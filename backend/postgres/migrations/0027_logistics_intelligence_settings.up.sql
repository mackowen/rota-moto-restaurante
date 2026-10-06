CREATE TABLE rotamoto.logistics_intelligence_settings (
  company_id uuid PRIMARY KEY REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  internal_provider_id uuid NOT NULL,
  fixed_cost_per_delivery_minor bigint,
  variable_cost_per_km_minor bigint,
  currency text,
  default_policy text NOT NULL DEFAULT 'lowest_cost'
    CHECK (default_policy IN ('lowest_cost','prefer_internal','earliest_eta')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,internal_provider_id)
    REFERENCES rotamoto.logistics_providers(company_id,provider_id) ON DELETE RESTRICT,
  CHECK (fixed_cost_per_delivery_minor IS NULL OR fixed_cost_per_delivery_minor BETWEEN 0 AND 9000000000000000),
  CHECK (variable_cost_per_km_minor IS NULL OR variable_cost_per_km_minor BETWEEN 0 AND 9000000000000000),
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  CHECK ((fixed_cost_per_delivery_minor IS NULL) = (variable_cost_per_km_minor IS NULL)
     AND (fixed_cost_per_delivery_minor IS NULL) = (currency IS NULL)),
  CHECK (updated_at >= created_at)
);

ALTER TABLE rotamoto.logistics_intelligence_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.logistics_intelligence_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.logistics_intelligence_settings
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON TABLE rotamoto.logistics_intelligence_settings TO rotamoto_app;
