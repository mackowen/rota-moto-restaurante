CREATE TABLE rotamoto.company_delivery_pricing (
  company_id uuid PRIMARY KEY REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  settings jsonb NOT NULL CHECK (jsonb_typeof(settings)='object'),
  version integer NOT NULL CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at)
);

ALTER TABLE rotamoto.company_delivery_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.company_delivery_pricing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.company_delivery_pricing
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.company_delivery_pricing TO rotamoto_app;
COMMENT ON TABLE rotamoto.company_delivery_pricing IS
  'Canonical tenant-scoped Restaurant delivery pricing. No device-local values are copied automatically.';
