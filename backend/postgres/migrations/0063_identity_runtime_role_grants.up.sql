-- Apply the explicit least-privilege runtime grants already specified by
-- backend/postgres/admin/role-split.sql to cleanly migrated installations.
-- Existing tenant RLS/FORCE RLS policies remain the row-access boundary.
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.companies TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.credentials TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.identity_tokens TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.memberships TO rotamoto_app;
GRANT SELECT ON TABLE rotamoto.permissions TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.provisioning_requests TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.recovery_tokens TO rotamoto_app;
GRANT SELECT, INSERT ON TABLE rotamoto.role_permissions TO rotamoto_app;
GRANT SELECT, INSERT ON TABLE rotamoto.roles TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.sessions TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.users TO rotamoto_app;
GRANT INSERT ON TABLE rotamoto.audit_log TO rotamoto_app;
GRANT EXECUTE ON FUNCTION rotamoto.current_tenant_id() TO rotamoto_app;
