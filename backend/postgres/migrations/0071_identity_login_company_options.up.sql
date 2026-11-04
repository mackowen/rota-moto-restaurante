-- Internal login helper: called only after the identity service verifies the
-- supplied password. It exposes active membership choices, never operational
-- records, and is not callable by PUBLIC.
CREATE POLICY identity_login_read_memberships ON rotamoto.memberships
  FOR SELECT USING (user_id=nullif(current_setting('app.identity_login_user_id',true),'')::uuid);
CREATE POLICY identity_login_read_companies ON rotamoto.companies
  FOR SELECT USING (id IN (SELECT m.company_id FROM rotamoto.memberships m
    WHERE m.user_id=nullif(current_setting('app.identity_login_user_id',true),'')::uuid));
CREATE POLICY identity_login_read_role_permissions ON rotamoto.role_permissions
  FOR SELECT USING (company_id IN (SELECT m.company_id FROM rotamoto.memberships m
    WHERE m.user_id=nullif(current_setting('app.identity_login_user_id',true),'')::uuid AND m.role_id=role_permissions.role_id));

CREATE FUNCTION rotamoto.identity_login_company_options(target_user_id uuid)
RETURNS TABLE(company_id text, company_name text, requires_mfa boolean, platform_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,rotamoto
AS $$
  SELECT c.id::text,c.name,
    coalesce(bool_or(rp.permission_key=ANY(ARRAY['company.manage','members.invite','integrations.manage','finance.manage']::text[])),false),
    EXISTS(SELECT 1 FROM rotamoto.platform_administrators pa
      WHERE pa.user_id=target_user_id AND pa.revoked_at IS NULL)
  FROM rotamoto.memberships m
  JOIN rotamoto.companies c ON c.id=m.company_id
  LEFT JOIN rotamoto.role_permissions rp ON rp.company_id=m.company_id AND rp.role_id=m.role_id AND rp.catalog_version=1
  WHERE m.user_id=target_user_id
    AND target_user_id=nullif(current_setting('app.identity_login_user_id',true),'')::uuid
    AND m.status='active' AND c.status='active'
  GROUP BY c.id,c.name
  ORDER BY CASE WHEN EXISTS(SELECT 1 FROM rotamoto.platform_administrators pa
      WHERE pa.user_id=target_user_id AND pa.revoked_at IS NULL) THEN min(m.created_at) END NULLS LAST,
    lower(c.name),c.id
$$;
REVOKE ALL ON FUNCTION rotamoto.identity_login_company_options(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.identity_login_company_options(uuid) TO rotamoto_app;
