CREATE TABLE rotamoto.delivery_geo_snapshots (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  delivery_entity_type text NOT NULL DEFAULT 'Delivery' CHECK (delivery_entity_type='Delivery'),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  provenance text NOT NULL CHECK (provenance IN ('customer_destination','geocoded_address','manual')),
  accuracy_m double precision CHECK (accuracy_m IS NULL OR (accuracy_m >= 0 AND accuracy_m <= 100000)),
  resolved_at timestamptz NOT NULL,
  algorithm_version text NOT NULL CHECK (algorithm_version='destination-v1'),
  created_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, delivery_id),
  FOREIGN KEY (company_id, delivery_id, delivery_entity_type)
    REFERENCES rotamoto.domain_records(company_id, record_id, entity_type) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);
CREATE INDEX delivery_geo_snapshots_resolved_idx
  ON rotamoto.delivery_geo_snapshots(company_id, resolved_at DESC, delivery_id);
CREATE FUNCTION rotamoto.bump_delivery_geo_snapshot_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,rotamoto
AS $$ BEGIN NEW.version:=OLD.version+1; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION rotamoto.bump_delivery_geo_snapshot_version() FROM PUBLIC;
CREATE TRIGGER delivery_geo_snapshot_version
  BEFORE UPDATE ON rotamoto.delivery_geo_snapshots
  FOR EACH ROW EXECUTE FUNCTION rotamoto.bump_delivery_geo_snapshot_version();
ALTER TABLE rotamoto.delivery_geo_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.delivery_geo_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.delivery_geo_snapshots
  USING (company_id=rotamoto.current_tenant_id()) WITH CHECK (company_id=rotamoto.current_tenant_id());
GRANT SELECT ON TABLE rotamoto.delivery_geo_snapshots TO rotamoto_app;
GRANT INSERT (company_id,delivery_id,latitude,longitude,provenance,accuracy_m,resolved_at,algorithm_version,created_by,updated_by)
  ON TABLE rotamoto.delivery_geo_snapshots TO rotamoto_app;
GRANT UPDATE (latitude,longitude,provenance,accuracy_m,resolved_at,algorithm_version,updated_by,updated_at)
  ON TABLE rotamoto.delivery_geo_snapshots TO rotamoto_app;
COMMENT ON TABLE rotamoto.delivery_geo_snapshots IS
  'Minimized, tenant-scoped destination coordinate snapshot. Never populated from individual Driver GPS or raw address during report rendering.';
