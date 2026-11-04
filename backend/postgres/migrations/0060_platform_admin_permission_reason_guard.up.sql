-- Reject a missing audit reason in direct calls as well as HTTP requests.
CREATE OR REPLACE FUNCTION rotamoto.platform_admin_set_company_role_permissions(
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

