CREATE TABLE rotamoto.logistics_route_settings (
  company_id uuid PRIMARY KEY REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  origin_mode text NOT NULL DEFAULT 'establishment' CHECK (origin_mode IN ('establishment','custom')),
  origin_latitude double precision,
  origin_longitude double precision,
  origin_provenance text,
  return_to_origin boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin_latitude IS NULL) = (origin_longitude IS NULL)),
  CHECK (origin_latitude IS NULL OR origin_latitude BETWEEN -90 AND 90),
  CHECK (origin_longitude IS NULL OR origin_longitude BETWEEN -180 AND 180),
  CHECK ((origin_mode='custom' AND (origin_latitude IS NULL OR origin_provenance='operator_configured')) OR
         (origin_mode='establishment' AND origin_provenance IS NULL)),
  CHECK (updated_at >= created_at)
);
ALTER TABLE rotamoto.logistics_route_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.logistics_route_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.logistics_route_settings
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON TABLE rotamoto.logistics_route_settings TO rotamoto_app;
COMMENT ON TABLE rotamoto.logistics_route_settings IS
  'Tenant-scoped operational origin/return policy for internal fleet Route distance evaluation. Coordinates are operator-entered; no geocoding or external courier location.';
