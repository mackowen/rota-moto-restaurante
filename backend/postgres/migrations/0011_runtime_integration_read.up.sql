-- A API administrativa expõe apenas status e metadados não secretos de integração.
-- As tabelas seguem tenant-scoped com RLS ENABLE/FORCE; sem grants de escrita.
GRANT SELECT ON TABLE rotamoto.integrations, rotamoto.external_accounts TO rotamoto_app;
