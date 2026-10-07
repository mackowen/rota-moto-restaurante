\set ON_ERROR_STOP on

GRANT USAGE ON SCHEMA rotamoto TO rotamoto_provider_worker, rotamoto_provider_resolver;
GRANT SELECT (company_id,provider_id,code,display_name,provider_class,enabled,capabilities,configuration,version,integration_mode,api_enabled)
  ON rotamoto.logistics_providers TO rotamoto_provider_worker;
GRANT SELECT ON rotamoto.provider_command_outbox TO rotamoto_provider_worker;
GRANT UPDATE (status,lease_token,lease_until,next_attempt_at,last_error_class,updated_at,completed_at)
  ON rotamoto.provider_command_outbox TO rotamoto_provider_worker;
GRANT SELECT,INSERT ON rotamoto.provider_quotes TO rotamoto_provider_worker;
GRANT SELECT,INSERT ON rotamoto.provider_tracking_snapshots TO rotamoto_provider_worker;
GRANT UPDATE (status,eta_at,provider_updated_at,updated_at,last_event_id) ON rotamoto.provider_tracking_snapshots TO rotamoto_provider_worker;
GRANT SELECT ON rotamoto.dispatch_attempts TO rotamoto_provider_worker;
GRANT UPDATE (status,responded_at,external_reference) ON rotamoto.dispatch_attempts TO rotamoto_provider_worker;
GRANT SELECT ON rotamoto.domain_records TO rotamoto_provider_worker;
GRANT INSERT ON rotamoto.audit_log TO rotamoto_provider_worker;
GRANT SELECT ON rotamoto.provider_event_inbox TO rotamoto_provider_worker;
GRANT UPDATE (status,processed_at) ON rotamoto.provider_event_inbox TO rotamoto_provider_worker;
GRANT SELECT (company_id,fulfillment_id,delivery_id,provider_id,mode,status,revision,selected_by,updated_by)
  ON rotamoto.delivery_fulfillments TO rotamoto_provider_worker;
GRANT UPDATE (status,revision,updated_by,updated_at) ON rotamoto.delivery_fulfillments TO rotamoto_provider_worker;
GRANT EXECUTE ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) TO rotamoto_provider_worker;
GRANT SELECT (company_id,provider_id,code,api_enabled,secret_ref)
  ON rotamoto.logistics_providers TO rotamoto_provider_resolver;

REVOKE EXECUTE ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) FROM PUBLIC,rotamoto_app;
REVOKE SELECT,UPDATE ON rotamoto.logistics_providers FROM rotamoto_provider_worker,rotamoto_provider_resolver;

GRANT SELECT ON rotamoto.marketplace_event_inbox TO rotamoto_provider_worker;
GRANT UPDATE (status,processed_at,attempts,next_attempt_at,lease_token,lease_until,last_error_code)
  ON rotamoto.marketplace_event_inbox TO rotamoto_provider_worker;
GRANT SELECT ON rotamoto.marketplace_command_outbox TO rotamoto_provider_worker;
GRANT UPDATE (status,attempts,next_attempt_at,lease_token,lease_until,last_error_code,updated_at,completed_at,result_data)
  ON rotamoto.marketplace_command_outbox TO rotamoto_provider_worker;
GRANT SELECT,INSERT,UPDATE ON rotamoto.marketplace_order_versions TO rotamoto_provider_worker;
GRANT SELECT ON rotamoto.marketplace_account_bindings TO rotamoto_provider_worker;
GRANT SELECT (id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,metadata,account_status,
  token_expires_at,last_sync_at,last_error_code,poll_next_at,poll_lease_token,poll_lease_until)
  ON rotamoto.external_accounts TO rotamoto_provider_worker;
GRANT UPDATE (poll_next_at,poll_lease_token,poll_lease_until,last_sync_at,last_error_code,updated_at)
  ON rotamoto.external_accounts TO rotamoto_provider_worker;
GRANT SELECT ON rotamoto.integrations TO rotamoto_provider_worker;
GRANT SELECT,INSERT,UPDATE ON rotamoto.domain_records,rotamoto.sync_installations TO rotamoto_provider_worker;
GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_event(uuid,uuid,integer) TO rotamoto_provider_worker;
GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_poll_account(uuid,text,uuid,integer) TO rotamoto_provider_worker;
GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_command(uuid,uuid,integer) TO rotamoto_provider_worker;

GRANT SELECT (id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,metadata,secret_ref,
  account_status,token_expires_at,last_sync_at,last_error_code)
  ON rotamoto.external_accounts TO rotamoto_provider_resolver;
GRANT INSERT (id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,metadata,secret_ref,
  account_status,token_expires_at,last_sync_at,last_error_code)
  ON rotamoto.external_accounts TO rotamoto_provider_resolver;
GRANT UPDATE (secret_ref,account_status,token_expires_at,last_sync_at,last_error_code,updated_at)
  ON rotamoto.external_accounts TO rotamoto_provider_resolver;
GRANT SELECT,INSERT,UPDATE ON rotamoto.marketplace_oauth_secrets,rotamoto.marketplace_account_bindings TO rotamoto_provider_resolver;
GRANT DELETE ON rotamoto.marketplace_oauth_secrets TO rotamoto_provider_resolver;
GRANT UPDATE (status,lease_token,lease_until,completed_at,last_error_code,updated_at)
  ON rotamoto.marketplace_command_outbox TO rotamoto_provider_resolver;
GRANT SELECT,INSERT ON rotamoto.marketplace_authorization_events TO rotamoto_provider_resolver;
GRANT SELECT ON rotamoto.marketplace_account_routes,rotamoto.integrations TO rotamoto_provider_resolver;
GRANT UPDATE (authorized,updated_at) ON rotamoto.marketplace_account_bindings TO rotamoto_provider_resolver;
GRANT UPDATE (account_status,last_error_code,updated_at) ON rotamoto.external_accounts TO rotamoto_provider_resolver;
REVOKE SELECT ON rotamoto.marketplace_oauth_secrets FROM rotamoto_provider_worker;
REVOKE SELECT (secret_ref) ON rotamoto.external_accounts FROM rotamoto_provider_worker;
REVOKE EXECUTE ON FUNCTION rotamoto.claim_marketplace_event(uuid,uuid,integer) FROM PUBLIC,rotamoto_app;
REVOKE EXECUTE ON FUNCTION rotamoto.claim_marketplace_poll_account(uuid,text,uuid,integer) FROM PUBLIC,rotamoto_app;
REVOKE EXECUTE ON FUNCTION rotamoto.claim_marketplace_command(uuid,uuid,integer) FROM PUBLIC,rotamoto_app;
