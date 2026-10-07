REVOKE UPDATE (route_grouping_policy, company_settings_version, updated_at) ON TABLE rotamoto.companies FROM rotamoto_app;
REVOKE SELECT (route_grouping_policy) ON TABLE rotamoto.companies FROM rotamoto_app;
ALTER TABLE rotamoto.companies
  DROP CONSTRAINT companies_route_grouping_policy,
  DROP COLUMN route_grouping_policy;
