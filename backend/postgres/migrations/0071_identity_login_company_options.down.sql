DROP FUNCTION IF EXISTS rotamoto.identity_login_company_options(uuid);
DROP POLICY IF EXISTS identity_login_read_role_permissions ON rotamoto.role_permissions;
DROP POLICY IF EXISTS identity_login_read_companies ON rotamoto.companies;
DROP POLICY IF EXISTS identity_login_read_memberships ON rotamoto.memberships;
