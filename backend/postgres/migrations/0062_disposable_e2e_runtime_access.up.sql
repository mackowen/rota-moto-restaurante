-- Permit the runtime schema access assumed by the application on a clean
-- installation, and allow the founder bootstrap proof only in the explicitly
-- named disposable Lote 1B database family. All one-time authorization,
-- owner-provenance, latch and audit checks remain unchanged.
GRANT USAGE ON SCHEMA rotamoto TO rotamoto_app;

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
  IF EXISTS (SELECT 1 FROM rotamoto.installation_bootstrap ib
      WHERE ib.singleton=true AND ib.request_digest IS NOT NULL
        AND ib.request_digest IS DISTINCT FROM target_request_digest) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='installation bootstrap already belongs to another request';
  END IF;
  IF EXISTS (SELECT 1 FROM rotamoto.installation_bootstrap ib
      WHERE ib.singleton=true AND ib.request_digest=decode(repeat('00',32),'hex')) THEN
    RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='legacy installation has no provable founder identity';
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
  UPDATE rotamoto.platform_admin_bootstrap_latch SET founder_user_id=target_user,claimed_at=now() WHERE singleton=true;
  INSERT INTO rotamoto.platform_admin_audit_log(id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES(gen_random_uuid(),NULL,'local_operator','founder.created','user',target_user,
      jsonb_build_object('source','authorized_initial_owner_bootstrap','company_id',target_company));
  RETURN target_user;
END $$;
REVOKE ALL ON FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(uuid,uuid,bytea,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.platform_admin_complete_initial_bootstrap(uuid,uuid,bytea,bytea) TO rotamoto_app;
