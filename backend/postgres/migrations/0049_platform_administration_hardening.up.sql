-- Forward correction for the first platform-administration release. The old
-- ledger digest stays intact; these definitions fix audit writes and founder
-- bootstrap without granting the HTTP runtime any grant-management capability.
CREATE OR REPLACE FUNCTION rotamoto.platform_admin_list_users() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
BEGIN
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC,item.id)
    FROM (SELECT u.id::text AS id,u.email,(u.email_verified_at IS NOT NULL) AS email_verified,
        (u.disabled_at IS NOT NULL) AS disabled,u.created_at,
        count(DISTINCT m.company_id)::integer AS company_count,
        coalesce(bool_or(pa.user_id IS NOT NULL AND pa.revoked_at IS NULL),false) AS platform_admin
      FROM rotamoto.users u LEFT JOIN rotamoto.memberships m ON m.user_id=u.id
      LEFT JOIN rotamoto.platform_administrators pa ON pa.user_id=u.id
      GROUP BY u.id ORDER BY u.created_at DESC,u.id LIMIT 500) item),'[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION rotamoto.platform_admin_set_company_status(target_company uuid,new_status text,reason_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE prior_status text; actor uuid;
BEGIN
  actor:=nullif(current_setting('app.platform_admin_user_id',true),'')::uuid;
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  IF new_status NOT IN ('active','suspended') OR reason_code NOT IN ('business_review','security_review','owner_request') THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid platform status change';
  END IF;
  SELECT status INTO prior_status FROM rotamoto.companies WHERE id=target_company FOR UPDATE;
  IF prior_status IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='company not found'; END IF;
  IF prior_status NOT IN ('active','suspended') THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='company lifecycle state is not manageable'; END IF;
  IF prior_status<>new_status THEN
    UPDATE rotamoto.companies SET status=new_status,updated_at=now() WHERE id=target_company;
    INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES(gen_random_uuid(),actor,'platform_admin',CASE new_status WHEN 'suspended' THEN 'company.suspended' ELSE 'company.reactivated' END,
        'company',target_company,jsonb_build_object('from',prior_status,'to',new_status,'reason',reason_code));
  END IF;
  RETURN jsonb_build_object('id',target_company::text,'status',new_status,'changed',prior_status<>new_status);
END $$;

CREATE OR REPLACE FUNCTION rotamoto.platform_admin_set_user_disabled(target_user uuid,disable_user boolean,reason_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE actor uuid; prior_disabled boolean;
BEGIN
  actor:=nullif(current_setting('app.platform_admin_user_id',true),'')::uuid;
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  IF reason_code NOT IN ('security_review','owner_request') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid user status change'; END IF;
  IF actor=target_user THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='self-disable is forbidden'; END IF;
  SELECT disabled_at IS NOT NULL INTO prior_disabled FROM rotamoto.users WHERE id=target_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='user not found'; END IF;
  IF prior_disabled IS DISTINCT FROM disable_user THEN
    UPDATE rotamoto.users SET disabled_at=CASE WHEN disable_user THEN now() ELSE NULL END,updated_at=now() WHERE id=target_user;
    IF disable_user THEN UPDATE rotamoto.sessions SET revoked_at=now() WHERE user_id=target_user AND revoked_at IS NULL; END IF;
    INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES(gen_random_uuid(),actor,'platform_admin',CASE WHEN disable_user THEN 'user.disabled' ELSE 'user.enabled' END,
        'user',target_user,jsonb_build_object('disabled',disable_user,'reason',reason_code));
  END IF;
  RETURN jsonb_build_object('id',target_user::text,'disabled',disable_user,'changed',prior_disabled IS DISTINCT FROM disable_user);
END $$;

