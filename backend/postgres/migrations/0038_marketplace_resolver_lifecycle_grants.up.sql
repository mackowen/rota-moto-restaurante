DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_resolver') THEN
    GRANT DELETE ON rotamoto.marketplace_oauth_secrets TO rotamoto_provider_resolver;
    GRANT UPDATE (status,lease_token,lease_until,completed_at,last_error_code,updated_at)
      ON rotamoto.marketplace_command_outbox TO rotamoto_provider_resolver;
  END IF;
END $$;
COMMENT ON TABLE rotamoto.marketplace_authorization_events IS 'Resolver-only idempotency records for signed Keeta authorization lifecycle callbacks.';
