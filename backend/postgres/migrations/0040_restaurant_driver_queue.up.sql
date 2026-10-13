CREATE TABLE rotamoto.restaurant_dispatch_settings (
  company_id uuid PRIMARY KEY REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual','automatic')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rotamoto.restaurant_driver_presence (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  driver_id uuid NOT NULL,
  entity_type text NOT NULL DEFAULT 'Driver' CHECK (entity_type='Driver'),
  checked_in_at timestamptz NOT NULL,
  checkin_method text NOT NULL CHECK (checkin_method IN ('self_reported','restaurant_qr','restaurant_confirmed')),
  confirmed boolean NOT NULL DEFAULT false,
  is_present boolean NOT NULL DEFAULT true,
  checked_out_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_gps_accuracy_m numeric(8,2) CHECK (last_gps_accuracy_m IS NULL OR last_gps_accuracy_m BETWEEN 0 AND 10000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, driver_id),
  FOREIGN KEY (company_id,driver_id,entity_type) REFERENCES rotamoto.domain_records(company_id,record_id,entity_type) ON DELETE RESTRICT,
  CHECK (is_present = (checked_out_at IS NULL)),
  CHECK (NOT confirmed OR checkin_method IN ('restaurant_qr','restaurant_confirmed'))
);

CREATE INDEX restaurant_driver_presence_fifo_idx
  ON rotamoto.restaurant_driver_presence(company_id, checked_in_at, driver_id)
  WHERE is_present;

CREATE TABLE rotamoto.restaurant_presence_qr_nonces (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  nonce_id uuid NOT NULL,
  issued_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (company_id, nonce_id)
);
CREATE INDEX restaurant_presence_qr_expiry_idx ON rotamoto.restaurant_presence_qr_nonces(expires_at);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['restaurant_dispatch_settings','restaurant_driver_presence','restaurant_presence_qr_nonces'] LOOP
    EXECUTE format('ALTER TABLE rotamoto.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE rotamoto.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON rotamoto.%I USING (company_id=rotamoto.current_tenant_id()) WITH CHECK (company_id=rotamoto.current_tenant_id())', table_name);
  END LOOP;
END $$;

GRANT SELECT,INSERT,UPDATE ON rotamoto.restaurant_dispatch_settings TO rotamoto_app;
GRANT SELECT,INSERT,UPDATE ON rotamoto.restaurant_driver_presence TO rotamoto_app;
GRANT SELECT,INSERT,UPDATE ON rotamoto.restaurant_presence_qr_nonces TO rotamoto_app;
