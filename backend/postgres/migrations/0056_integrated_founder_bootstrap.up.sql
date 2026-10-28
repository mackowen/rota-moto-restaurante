-- Tie the only global founder grant to the first authorized company-owner
-- bootstrap. The grant is created in the same transaction as company/owner.
CREATE FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(
  target_user uuid, target_company uuid, target_request_digest bytea, target_capability_digest bytea
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE latch_user uuid; installation_digest bytea; eligible boolean;
BEGIN
  IF session_user <> 'rotamoto_app' OR current_database() NOT IN ('rotamoto','rotamoto_e2e') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='initial founder grant requires the authorized bootstrap runtime';
  END IF;
  IF target_user IS NULL OR target_company IS NULL OR octet_length(target_request_digest)<>32 OR
     octet_length(target_capability_digest)<>32 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='invalid initial bootstrap proof';
  END IF;
  PERFORM 1 FROM rotamoto.installation_bootstrap WHERE singleton=true FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='installation bootstrap latch unavailable'; END IF;
  SELECT request_digest INTO installation_digest FROM rotamoto.installation_bootstrap WHERE singleton=true;
  IF installation_digest IS NOT NULL AND installation_digest<>target_request_digest THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='installation bootstrap already belongs to another request';
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
    WHERE p.idempotency_key_digest=target_request_digest AND p.user_id=target_user AND p.company_id=target_company
      AND m.status IN ('invited','active') AND c.status IN ('provisioning','active') AND u.disabled_at IS NULL
  ) INTO eligible;
  IF NOT eligible THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='founder must be the first provisioned company owner'; END IF;

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
    VALUES(gen_random_uuid(),NULL,'local_operator','founder.created','user',target_user,
      jsonb_build_object('source','authorized_initial_owner_bootstrap','company_id',target_company));
  RETURN target_user;
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(uuid,uuid,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(uuid,uuid,bytea,bytea) TO rotamoto_app;

-- The manual legacy regularization path may only recognize the identity already
-- recorded by the original provisioning request. Legacy zero-digest latches
-- intentionally remain ineligible because they cannot prove a founder.
CREATE OR REPLACE FUNCTION rotamoto.platform_admin_bootstrap_founder(target_email text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE candidate uuid; existing uuid; proven_user uuid;
BEGIN
  IF session_user <> 'rotamoto_migrator' OR current_database() NOT IN ('rotamoto','rotamoto_e2e') THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='founder regularization requires the local migration operator';
  END IF;
  IF target_email IS NULL OR target_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='verified founder email required';
  END IF;
  SELECT founder_user_id INTO existing FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true FOR UPDATE;
  SELECT u.id INTO candidate FROM rotamoto.users u
    WHERE lower(u.email)=lower(target_email) AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL;
  IF candidate IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='verified enabled founder account not found'; END IF;
  SELECT p.user_id INTO proven_user FROM rotamoto.installation_bootstrap b
    JOIN rotamoto.provisioning_requests p ON p.idempotency_key_digest=b.request_digest
    JOIN rotamoto.memberships m ON m.user_id=p.user_id AND m.company_id=p.company_id
    JOIN rotamoto.roles r ON r.id=m.role_id AND r.company_id=m.company_id AND r.role_key='owner'
    JOIN rotamoto.companies c ON c.id=p.company_id
    WHERE b.singleton=true AND b.completed_at IS NOT NULL AND b.request_digest IS NOT NULL
      AND b.request_digest<>decode(repeat('00',32),'hex') AND p.delivery_status IN ('sent','failed')
      AND m.status='active' AND c.status='active';
  IF proven_user IS NULL OR proven_user<>candidate THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='founder identity is not provable from the original bootstrap record';
  END IF;
  IF existing IS NOT NULL THEN
    IF existing<>candidate THEN RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='platform founder already claimed'; END IF;
    RETURN existing;
  END IF;
  IF EXISTS (SELECT 1 FROM rotamoto.platform_administrators) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='platform administration already has history';
  END IF;
  INSERT INTO rotamoto.platform_administrators(user_id,granted_by_user_id,grant_kind)
    VALUES(candidate,NULL,'founder_bootstrap');
  UPDATE rotamoto.platform_admin_bootstrap_latch SET founder_user_id=candidate,claimed_at=now() WHERE singleton=true;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),NULL,'local_operator','founder.created','user',candidate,
      jsonb_build_object('source','verified_original_bootstrap_record'));
  RETURN candidate;
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_bootstrap_founder(text) FROM PUBLIC,rotamoto_app;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_bootstrap_founder(text) TO rotamoto_migrator;

COMMENT ON FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(uuid,uuid,bytea,bytea) IS
  'Atomically grants the one global founder identity only to the owner created by the consumed first-install bootstrap authorization.';
