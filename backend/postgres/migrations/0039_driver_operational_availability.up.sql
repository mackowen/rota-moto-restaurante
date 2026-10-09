CREATE TABLE rotamoto.driver_availability (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  driver_id uuid NOT NULL,
  entity_type text NOT NULL DEFAULT 'Driver' CHECK (entity_type='Driver'),
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  lease_expires_at timestamptz,
  lease_session_id uuid,
  updated_by_user_id uuid REFERENCES rotamoto.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,driver_id),
  FOREIGN KEY (company_id,driver_id,entity_type) REFERENCES rotamoto.domain_records(company_id,record_id,entity_type) ON DELETE RESTRICT,
  CHECK ((status='online') = (lease_expires_at IS NOT NULL)),
  CHECK ((status='online') = (lease_session_id IS NOT NULL))
);

CREATE TABLE rotamoto.driver_availability_commands (
  company_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  command_id uuid NOT NULL,
  desired_status text NOT NULL CHECK (desired_status IN ('online','offline')),
  result_revision integer NOT NULL CHECK (result_revision >= 0),
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,driver_id,command_id),
  FOREIGN KEY (company_id,driver_id) REFERENCES rotamoto.driver_availability(company_id,driver_id) ON DELETE RESTRICT
);

CREATE INDEX driver_availability_dispatch_idx
  ON rotamoto.driver_availability(company_id,status,lease_expires_at,driver_id);

ALTER TABLE rotamoto.driver_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.driver_availability FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.driver_availability
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
ALTER TABLE rotamoto.driver_availability_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.driver_availability_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.driver_availability_commands
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());

GRANT SELECT,INSERT,UPDATE ON rotamoto.driver_availability TO rotamoto_app;
GRANT SELECT,INSERT ON rotamoto.driver_availability_commands TO rotamoto_app;
