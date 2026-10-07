DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    REVOKE ALL ON rotamoto.marketplace_oauth_states,rotamoto.marketplace_oauth_secrets FROM rotamoto_provider_worker;
    REVOKE SELECT (secret_ref) ON rotamoto.external_accounts FROM rotamoto_provider_worker;
  END IF;
END $$;
COMMENT ON TABLE rotamoto.marketplace_oauth_secrets IS 'OAuth verifier references are resolver-only; marketplace worker does not access this secret boundary.';
