-- Platform administration is an identity-level grant, independent of tenant RBAC.
-- Grants are created only by the local, one-time operator bootstrap; HTTP runtime
-- receives read-only access to the grant table and uses audited narrow functions.
CREATE TABLE rotamoto.platform_administrators (
  user_id uuid PRIMARY KEY REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  granted_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  grant_kind text NOT NULL CHECK (grant_kind IN ('founder_bootstrap','operator_grant')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);

CREATE TABLE rotamoto.platform_admin_bootstrap_latch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  founder_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  claimed_at timestamptz,
  CHECK ((founder_user_id IS NULL) = (claimed_at IS NULL))
);
INSERT INTO rotamoto.platform_admin_bootstrap_latch(singleton) VALUES(true);

CREATE FUNCTION rotamoto.platform_admin_bootstrap_founder(target_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE candidate uuid; existing uuid;
BEGIN
  IF session_user <> 'rotamoto_migrator' OR current_database() NOT IN ('rotamoto','rotamoto_e2e') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='founder bootstrap requires the local migration operator';
  END IF;
  IF target_email IS NULL OR target_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='verified founder email required';
  END IF;
  SELECT founder_user_id INTO existing FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true FOR UPDATE;
  SELECT id INTO candidate FROM rotamoto.users WHERE lower(email)=lower(target_email) AND email_verified_at IS NOT NULL AND disabled_at IS NULL;
  IF candidate IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='verified enabled founder account not found'; END IF;
  IF existing IS NOT NULL THEN
    IF existing<>candidate THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='founder bootstrap already claimed'; END IF;
    RETURN existing;
  END IF;
  INSERT INTO rotamoto.platform_administrators(user_id,granted_by_user_id,grant_kind) VALUES(candidate,NULL,'founder_bootstrap');
  UPDATE rotamoto.platform_admin_bootstrap_latch SET founder_user_id=candidate,claimed_at=now() WHERE singleton=true;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),NULL,'local_operator','founder.created','user',candidate,'{}'::jsonb);
  RETURN candidate;
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_bootstrap_founder(text) FROM PUBLIC,rotamoto_app;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_bootstrap_founder(text) TO rotamoto_migrator;

CREATE TABLE rotamoto.platform_admin_audit_log (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  actor_kind text NOT NULL CHECK (actor_kind IN ('platform_admin','local_operator')),
  action text NOT NULL CHECK (action IN ('founder.created','company.suspended','company.reactivated','user.disabled','user.enabled')),
  resource_type text NOT NULL CHECK (resource_type IN ('company','user')),
  resource_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object')
);
CREATE INDEX platform_admin_audit_actor_time_idx
  ON rotamoto.platform_admin_audit_log(actor_user_id,occurred_at DESC);
CREATE TRIGGER platform_admin_audit_immutable
  BEFORE UPDATE OR DELETE ON rotamoto.platform_admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION rotamoto.guard_audit_log_immutable();

REVOKE ALL ON rotamoto.platform_administrators,rotamoto.platform_admin_bootstrap_latch,
  rotamoto.platform_admin_audit_log FROM PUBLIC;
GRANT SELECT ON rotamoto.platform_administrators TO rotamoto_app;

CREATE FUNCTION rotamoto.platform_admin_context_is_active() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
  SELECT EXISTS (
    SELECT 1 FROM rotamoto.platform_administrators pa
    WHERE pa.user_id=nullif(current_setting('app.platform_admin_user_id',true),'')::uuid
      AND pa.revoked_at IS NULL
  )
$$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_context_is_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_context_is_active() TO rotamoto_app;

-- Global read access exists only while the trusted HTTP identity layer has set
-- an authenticated, MFA-verified platform actor in the current transaction.
CREATE POLICY platform_admin_read_companies ON rotamoto.companies
  FOR SELECT USING (rotamoto.platform_admin_context_is_active());
CREATE POLICY platform_admin_update_companies ON rotamoto.companies
  FOR UPDATE USING (rotamoto.platform_admin_context_is_active())
  WITH CHECK (rotamoto.platform_admin_context_is_active());
CREATE POLICY platform_admin_read_memberships ON rotamoto.memberships
  FOR SELECT USING (rotamoto.platform_admin_context_is_active());

CREATE FUNCTION rotamoto.platform_admin_list_companies() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
BEGIN
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at DESC,item.id)
    FROM (SELECT c.id::text AS id,c.name,c.status,c.created_at,c.updated_at,
        count(DISTINCT m.user_id)::integer AS member_count
      FROM rotamoto.companies c LEFT JOIN rotamoto.memberships m ON m.company_id=c.id AND m.status='active'
      GROUP BY c.id ORDER BY c.created_at DESC,c.id LIMIT 500) item),'[]'::jsonb);
END $$;

CREATE FUNCTION rotamoto.platform_admin_list_users() RETURNS jsonb
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

CREATE FUNCTION rotamoto.platform_admin_list_memberships() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
BEGIN
  IF NOT rotamoto.platform_admin_context_is_active() THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='platform admin required'; END IF;
  RETURN coalesce((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.company_name,item.email)
    FROM (SELECT m.id::text AS id,m.company_id::text AS company_id,c.name AS company_name,
        m.user_id::text AS user_id,u.email,m.status,r.display_name AS role_name,
        (m.driver_id IS NOT NULL) AS has_driver_link
      FROM rotamoto.memberships m JOIN rotamoto.companies c ON c.id=m.company_id
      JOIN rotamoto.users u ON u.id=m.user_id JOIN rotamoto.roles r ON r.id=m.role_id AND r.company_id=m.company_id
      ORDER BY c.name,u.email LIMIT 2000) item),'[]'::jsonb);
END $$;

CREATE FUNCTION rotamoto.platform_admin_set_company_status(target_company uuid,new_status text,reason_code text) RETURNS jsonb
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

CREATE FUNCTION rotamoto.platform_admin_set_user_disabled(target_user uuid,disable_user boolean,reason_code text) RETURNS jsonb
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

REVOKE ALL ON FUNCTION rotamoto.platform_admin_list_companies(),rotamoto.platform_admin_list_users(),
  rotamoto.platform_admin_list_memberships(),rotamoto.platform_admin_set_company_status(uuid,text,text),
  rotamoto.platform_admin_set_user_disabled(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_list_companies(),rotamoto.platform_admin_list_users(),
  rotamoto.platform_admin_list_memberships(),rotamoto.platform_admin_set_company_status(uuid,text,text),
  rotamoto.platform_admin_set_user_disabled(uuid,boolean,text) TO rotamoto_app;

COMMENT ON TABLE rotamoto.platform_administrators IS
  'Identity-level platform grants independent of tenant roles; only a local one-time bootstrap may create the founder grant.';
COMMENT ON TABLE rotamoto.platform_admin_audit_log IS
  'Append-only audit for global company and user status changes; contains no credentials or secrets.';
