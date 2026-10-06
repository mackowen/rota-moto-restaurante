-- Runtime integrations UI needs account metadata only; the credential pointer belongs
-- to the privileged credential boundary and is never readable by rotamoto_app.
REVOKE SELECT ON TABLE rotamoto.external_accounts FROM rotamoto_app;
GRANT SELECT (
  id,company_id,integration_id,external_account_id,display_name,link_status,
  confirmed_at,metadata,created_at,updated_at
) ON TABLE rotamoto.external_accounts TO rotamoto_app;
REVOKE UPDATE ON TABLE rotamoto.external_accounts FROM rotamoto_app;
