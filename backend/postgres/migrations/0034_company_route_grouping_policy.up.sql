ALTER TABLE rotamoto.companies
  ADD COLUMN route_grouping_policy text NOT NULL DEFAULT 'nearest_extension';

ALTER TABLE rotamoto.companies
  ADD CONSTRAINT companies_route_grouping_policy CHECK (
    route_grouping_policy IN ('nearest_extension', 'nearest_origin_round_robin')
  );

GRANT SELECT (route_grouping_policy) ON TABLE rotamoto.companies TO rotamoto_app;
GRANT UPDATE (route_grouping_policy, company_settings_version, updated_at) ON TABLE rotamoto.companies TO rotamoto_app;

COMMENT ON COLUMN rotamoto.companies.route_grouping_policy IS
  'Restaurant-owned human-reviewed assignment grouping strategy; revisioned with company_settings_version.';
