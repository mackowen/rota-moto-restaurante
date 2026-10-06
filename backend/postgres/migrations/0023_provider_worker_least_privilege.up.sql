REVOKE ALL ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) FROM rotamoto_app;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT USAGE ON SCHEMA rotamoto TO rotamoto_provider_worker;
    GRANT SELECT (company_id,provider_id,code,display_name,provider_class,enabled,capabilities,configuration,version,integration_mode,api_enabled)
      ON rotamoto.logistics_providers TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.provider_command_outbox TO rotamoto_provider_worker;
    GRANT UPDATE (status,lease_token,lease_until,next_attempt_at,last_error_class,updated_at,completed_at)
      ON rotamoto.provider_command_outbox TO rotamoto_provider_worker;
    GRANT SELECT,INSERT ON rotamoto.provider_quotes TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.provider_tracking_snapshots TO rotamoto_provider_worker;
    GRANT INSERT ON rotamoto.provider_tracking_snapshots TO rotamoto_provider_worker;
    GRANT UPDATE (eta_at,provider_updated_at,updated_at) ON rotamoto.provider_tracking_snapshots TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.dispatch_attempts TO rotamoto_provider_worker;
    GRANT UPDATE (status,responded_at,external_reference) ON rotamoto.dispatch_attempts TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.domain_records TO rotamoto_provider_worker;
    GRANT INSERT ON rotamoto.audit_log TO rotamoto_provider_worker;
    GRANT EXECUTE ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) TO rotamoto_provider_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_resolver') THEN
    GRANT USAGE ON SCHEMA rotamoto TO rotamoto_provider_resolver;
    GRANT SELECT (company_id,provider_id,code,api_enabled,secret_ref) ON rotamoto.logistics_providers TO rotamoto_provider_resolver;
  END IF;
END $$;

COMMENT ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) IS
  'Tenant-scoped provider worker claim; execute is reserved for the isolated rotamoto_provider_worker service role.';
