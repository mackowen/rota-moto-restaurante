-- Extend the existing MFA-gated, audited platform control plane with explicit
-- company-scoped role inspection/delegation and aggregate-only finance review.
ALTER TABLE rotamoto.platform_admin_audit_log DROP CONSTRAINT IF EXISTS platform_admin_audit_log_action_check;
ALTER TABLE rotamoto.platform_admin_audit_log DROP CONSTRAINT IF EXISTS platform_admin_audit_log_resource_type_check;
ALTER TABLE rotamoto.platform_admin_audit_log ADD CONSTRAINT platform_admin_audit_log_action_check
  CHECK (action IN ('founder.created','company.suspended','company.reactivated','user.disabled','user.enabled',
    'company.roles.read','company.role.permissions.updated','company.finance.summary.read','platform.settings.read'));
ALTER TABLE rotamoto.platform_admin_audit_log ADD CONSTRAINT platform_admin_audit_log_resource_type_check
  CHECK (resource_type IN ('company','user','role','platform'));

CREATE FUNCTION rotamoto.platform_admin_list_company_roles(target_company uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor:=nullif(current_setting('app.platform_admin_user_id',true),'')::uuid;
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  IF target_company IS NULL OR NOT EXISTS (SELECT 1 FROM rotamoto.companies WHERE id=target_company) THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='company not found';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.role_key),'[]'::jsonb) INTO result
  FROM (SELECT r.id::text AS id,r.role_key,r.display_name,r.is_system_template,
      (r.role_key='owner') AS protected,
      coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL),'{}') AS permissions,
      coalesce((SELECT jsonb_agg(jsonb_build_object('key',p.permission_key,'description',p.description) ORDER BY p.permission_key)
        FROM rotamoto.permissions p WHERE p.catalog_version=1),'[]'::jsonb) AS permission_catalog
    FROM rotamoto.roles r LEFT JOIN rotamoto.role_permissions rp ON rp.company_id=r.company_id AND rp.role_id=r.id AND rp.catalog_version=1
    WHERE r.company_id=target_company GROUP BY r.id) item;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),actor,'platform_admin','company.roles.read','company',target_company,'{}'::jsonb);
  RETURN result;
END $$;

CREATE FUNCTION rotamoto.platform_admin_set_company_role_permissions(
  target_company uuid,target_role uuid,permission_keys text[],reason_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE actor uuid; role_key text; before_keys text[]; requested text[]; invalid_count integer;
BEGIN
  actor:=nullif(current_setting('app.platform_admin_user_id',true),'')::uuid;
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  IF target_company IS NULL OR target_role IS NULL OR permission_keys IS NULL OR cardinality(permission_keys)>64 OR
     reason_code NOT IN ('owner_request','security_review','platform_policy') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid role permission request';
  END IF;
  IF cardinality(permission_keys)<>(SELECT count(DISTINCT item) FROM unnest(permission_keys) item) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='duplicate permissions are not allowed';
  END IF;
  requested:=coalesce(permission_keys,'{}'::text[]);
  SELECT r.role_key INTO role_key FROM rotamoto.roles r
    WHERE r.company_id=target_company AND r.id=target_role FOR UPDATE;
  IF role_key IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='role not found in selected company'; END IF;
  SELECT coalesce(array_agg(rp.permission_key ORDER BY rp.permission_key),'{}') INTO before_keys
    FROM rotamoto.role_permissions rp WHERE rp.company_id=target_company AND rp.role_id=target_role AND rp.catalog_version=1;
  IF role_key='owner' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='essential owner permissions are protected'; END IF;
  SELECT count(*) INTO invalid_count FROM unnest(requested) item
    LEFT JOIN rotamoto.permissions p ON p.permission_key=item AND p.catalog_version=1 WHERE p.permission_key IS NULL;
  IF invalid_count>0 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='permission is not in the current catalog'; END IF;
  IF 'finance.manage'=ANY(requested) AND NOT 'finance.read'=ANY(requested) THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='finance.manage requires finance.read';
  END IF;
  DELETE FROM rotamoto.role_permissions WHERE company_id=target_company AND role_id=target_role AND catalog_version=1;
  INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
    SELECT target_company,target_role,item,1 FROM unnest(requested) item ORDER BY item;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),actor,'platform_admin','company.role.permissions.updated','role',target_role,
      jsonb_build_object('company_id',target_company,'reason',reason_code,'before',before_keys,'after',requested));
  RETURN jsonb_build_object('companyId',target_company::text,'roleId',target_role::text,'roleKey',role_key,'permissions',requested);
END $$;

CREATE FUNCTION rotamoto.platform_admin_read_company_financial_summary(
  target_company uuid,period_start timestamptz,period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE actor uuid; result jsonb;
BEGIN
  actor:=nullif(current_setting('app.platform_admin_user_id',true),'')::uuid;
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  IF target_company IS NULL OR period_start IS NULL OR period_end IS NULL OR period_end<=period_start OR
     period_end-period_start>interval '366 days' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='financial review period must be explicit and at most 366 days';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rotamoto.companies WHERE id=target_company) THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='company not found';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventKind',summary.event_kind,'currency',summary.currency,
      'eventCount',summary.event_count,'amountMinor',summary.amount_minor) ORDER BY summary.currency,summary.event_kind),'[]'::jsonb)
    INTO result FROM (SELECT event_kind,currency,count(*)::integer AS event_count,sum(amount_minor)::text AS amount_minor
      FROM rotamoto.financial_events WHERE company_id=target_company AND occurred_at>=period_start AND occurred_at<period_end
      GROUP BY event_kind,currency) summary;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),actor,'platform_admin','company.finance.summary.read','company',target_company,
      jsonb_build_object('from',period_start,'to',period_end,'result_count',jsonb_array_length(result)));
  RETURN jsonb_build_object('companyId',target_company::text,'from',period_start,'to',period_end,'events',result,
    'scope','aggregate_only','bank_settlement_verified',false);
END $$;

CREATE FUNCTION rotamoto.platform_admin_get_safe_settings() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE actor uuid; claimed boolean;
BEGIN
  actor:=nullif(current_setting('app.platform_admin_user_id',true),'')::uuid;
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  SELECT founder_user_id IS NOT NULL INTO claimed FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),actor,'platform_admin','platform.settings.read','platform','00000000-0000-7000-8000-000000000000'::uuid,'{}'::jsonb);
  RETURN jsonb_build_object('scope','deployment_managed','platform_admin_mfa_required',true,
    'tenant_isolation','company_scoped','founder_claimed',coalesce(claimed,false),
    'financial_review','explicit_company_period_aggregate_only');
END $$;

REVOKE ALL ON FUNCTION rotamoto.platform_admin_list_company_roles(uuid),
  rotamoto.platform_admin_set_company_role_permissions(uuid,uuid,text[],text),
  rotamoto.platform_admin_read_company_financial_summary(uuid,timestamptz,timestamptz),
  rotamoto.platform_admin_get_safe_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_list_company_roles(uuid),
  rotamoto.platform_admin_set_company_role_permissions(uuid,uuid,text[],text),
  rotamoto.platform_admin_read_company_financial_summary(uuid,timestamptz,timestamptz),
  rotamoto.platform_admin_get_safe_settings() TO rotamoto_app;
