-- Keep the first-install slot reserved while the owner accepts the invitation
-- and completes mandatory MFA. The founder grant and completed latch are set
-- only in the MFA enrollment transaction.
ALTER TABLE rotamoto.installation_bootstrap
  DROP CONSTRAINT IF EXISTS installation_bootstrap_check;
ALTER TABLE rotamoto.installation_bootstrap
  ADD CONSTRAINT installation_bootstrap_completion_requires_digest
  CHECK (completed_at IS NULL OR request_digest IS NOT NULL);

ALTER TABLE rotamoto.provisioning_requests
  ADD COLUMN bootstrap_capability_digest bytea,
  ADD CONSTRAINT provisioning_bootstrap_capability_digest_length
    CHECK (bootstrap_capability_digest IS NULL OR octet_length(bootstrap_capability_digest)=32);

CREATE OR REPLACE FUNCTION rotamoto.platform_admin_bootstrap_status()
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE
  install_row rotamoto.installation_bootstrap%ROWTYPE;
  founder_user uuid;
  pending record;
BEGIN
  IF session_user <> 'rotamoto_app' OR NOT (
      current_database() IN ('rotamoto','rotamoto_e2e') OR
      current_database() ~ '^rotamoto_e2e_lote1b_[0-9]{8}_[a-f0-9]{8}$') THEN
    RETURN 'unavailable';
  END IF;
  SELECT * INTO install_row FROM rotamoto.installation_bootstrap WHERE singleton=true;
  SELECT founder_user_id INTO founder_user FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true;
  IF NOT FOUND OR install_row.singleton IS DISTINCT FROM true THEN RETURN 'unavailable'; END IF;

  IF install_row.completed_at IS NOT NULL THEN
    IF founder_user IS NOT NULL AND EXISTS (SELECT 1 FROM rotamoto.platform_administrators
        WHERE user_id=founder_user AND revoked_at IS NULL AND grant_kind='founder_bootstrap') THEN
      RETURN 'complete';
    END IF;
    RETURN 'unavailable';
  END IF;

  IF install_row.request_digest IS NOT NULL THEN
    IF founder_user IS NOT NULL OR EXISTS (SELECT 1 FROM rotamoto.platform_administrators) THEN RETURN 'unavailable'; END IF;
    SELECT p.company_id,p.user_id,m.status AS membership_status,u.disabled_at,u.email_verified_at,
      cr.mfa_required,cr.mfa_secret_ref,p.bootstrap_capability_digest
      INTO pending
      FROM rotamoto.provisioning_requests p
      JOIN rotamoto.memberships m ON m.company_id=p.company_id AND m.user_id=p.user_id
      JOIN rotamoto.roles r ON r.id=m.role_id AND r.company_id=m.company_id AND r.role_key='owner'
      JOIN rotamoto.companies c ON c.id=p.company_id
      JOIN rotamoto.users u ON u.id=p.user_id
      LEFT JOIN rotamoto.credentials cr ON cr.user_id=p.user_id
      WHERE p.idempotency_key_digest=install_row.request_digest
        AND p.bootstrap_capability_digest IS NOT NULL AND c.status IN ('provisioning','active');
    IF NOT FOUND OR pending.disabled_at IS NOT NULL OR pending.bootstrap_capability_digest IS NULL THEN RETURN 'unavailable'; END IF;
    IF pending.membership_status='invited' AND pending.email_verified_at IS NULL AND pending.mfa_required IS NULL THEN
      RETURN 'pending_owner_activation';
    END IF;
    IF pending.membership_status='active' AND pending.email_verified_at IS NOT NULL AND pending.mfa_required=true
      AND pending.mfa_secret_ref IS NULL THEN RETURN 'pending_owner_mfa'; END IF;
    RETURN 'unavailable';
  END IF;

  IF founder_user IS NOT NULL OR EXISTS (SELECT 1 FROM rotamoto.platform_administrators) OR
      EXISTS (SELECT 1 FROM rotamoto.companies) OR EXISTS (SELECT 1 FROM rotamoto.users) OR
      EXISTS (SELECT 1 FROM rotamoto.provisioning_requests) THEN
    RETURN 'unavailable';
  END IF;
  RETURN 'ready';
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_bootstrap_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_bootstrap_status() TO rotamoto_app;

CREATE OR REPLACE FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(
  target_user uuid, target_company uuid, target_request_digest bytea, target_capability_digest bytea
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE latch_user uuid; eligible boolean;
BEGIN
  IF session_user <> 'rotamoto_app' OR NOT (
      current_database() IN ('rotamoto','rotamoto_e2e') OR
      current_database() ~ '^rotamoto_e2e_lote1b_[0-9]{8}_[a-f0-9]{8}$') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='initial founder grant requires the authorized bootstrap runtime';
  END IF;
  IF target_user IS NULL OR target_company IS NULL OR octet_length(target_request_digest)<>32 OR
     octet_length(target_capability_digest)<>32 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid initial bootstrap proof';
  END IF;
  PERFORM 1 FROM rotamoto.installation_bootstrap WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='installation bootstrap latch unavailable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM rotamoto.installation_bootstrap ib
      WHERE ib.singleton=true AND ib.request_digest=target_request_digest AND ib.completed_at IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='installation bootstrap is not reserved for this request';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rotamoto.bootstrap_authorizations
      WHERE token_digest=target_capability_digest AND installation_scope='rotamoto' AND consumed_at IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='consumed installation authorization required';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM rotamoto.provisioning_requests p
    JOIN rotamoto.memberships m ON m.company_id=p.company_id AND m.user_id=p.user_id
    JOIN rotamoto.roles r ON r.id=m.role_id AND r.company_id=m.company_id AND r.role_key='owner'
    JOIN rotamoto.companies c ON c.id=p.company_id
    JOIN rotamoto.users u ON u.id=p.user_id
    JOIN rotamoto.credentials cr ON cr.user_id=u.id
    WHERE p.idempotency_key_digest=target_request_digest AND p.user_id=target_user AND p.company_id=target_company
      AND p.bootstrap_capability_digest=target_capability_digest
      AND m.status='active' AND c.status='active' AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
      AND cr.mfa_required=true AND cr.mfa_secret_ref IS NOT NULL
  ) INTO eligible;
  IF NOT eligible THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='verified owner with confirmed MFA is required'; END IF;

  SELECT founder_user_id INTO latch_user FROM rotamoto.platform_admin_bootstrap_latch
    WHERE singleton=true FOR UPDATE;
  IF latch_user IS NOT NULL THEN
    IF latch_user<>target_user OR NOT EXISTS (SELECT 1 FROM rotamoto.platform_administrators
        WHERE user_id=target_user AND revoked_at IS NULL AND grant_kind='founder_bootstrap') THEN
      RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='platform founder already claimed';
    END IF;
    RETURN target_user;
  END IF;
  IF EXISTS (SELECT 1 FROM rotamoto.platform_administrators) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='platform administration already has history';
  END IF;
  INSERT INTO rotamoto.platform_administrators(user_id,granted_by_user_id,grant_kind)
    VALUES(target_user,NULL,'founder_bootstrap');
  UPDATE rotamoto.platform_admin_bootstrap_latch
    SET founder_user_id=target_user,claimed_at=now() WHERE singleton=true;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),target_user,'user','founder.created','user',target_user,
      jsonb_build_object('source','authorized_initial_owner_bootstrap','company_id',target_company,'mfa_confirmed',true));
  RETURN target_user;
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(uuid,uuid,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(uuid,uuid,bytea,bytea) TO rotamoto_app;

COMMENT ON COLUMN rotamoto.provisioning_requests.bootstrap_capability_digest IS
  'Digest-only proof linking a first-install reservation to the owner invitation; cleared only by migration policy, never an API token.';
