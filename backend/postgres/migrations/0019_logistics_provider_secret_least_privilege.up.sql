REVOKE SELECT ON TABLE rotamoto.logistics_providers FROM rotamoto_app;
REVOKE SELECT (secret_ref) ON TABLE rotamoto.logistics_providers FROM rotamoto_app;
REVOKE UPDATE (secret_ref) ON TABLE rotamoto.logistics_providers FROM rotamoto_app;

GRANT SELECT (
  company_id,
  provider_id,
  code,
  display_name,
  provider_class,
  enabled,
  capabilities,
  configuration,
  version,
  created_at,
  updated_at
) ON TABLE rotamoto.logistics_providers TO rotamoto_app;
