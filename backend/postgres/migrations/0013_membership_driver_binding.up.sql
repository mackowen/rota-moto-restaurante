ALTER TABLE rotamoto.memberships
  ADD COLUMN driver_id uuid,
  ADD COLUMN driver_entity_type text NOT NULL DEFAULT 'Driver'
    CHECK (driver_entity_type = 'Driver'),
  ADD CONSTRAINT memberships_driver_record_fk
    FOREIGN KEY (company_id, driver_id, driver_entity_type)
    REFERENCES rotamoto.domain_records(company_id, record_id, entity_type)
    ON DELETE RESTRICT;

CREATE UNIQUE INDEX memberships_driver_unique
  ON rotamoto.memberships(company_id, driver_id)
  WHERE driver_id IS NOT NULL;
CREATE INDEX memberships_driver_lookup
  ON rotamoto.memberships(company_id, driver_id)
  WHERE status = 'active' AND driver_id IS NOT NULL;

ALTER TABLE rotamoto.sync_outbox
  ADD COLUMN recipient_driver_id uuid,
  ADD CONSTRAINT sync_outbox_recipient_driver_fk
    FOREIGN KEY (company_id, recipient_driver_id)
    REFERENCES rotamoto.domain_records(company_id, record_id)
    ON DELETE RESTRICT;
CREATE INDEX sync_outbox_driver_cursor_idx
  ON rotamoto.sync_outbox(company_id, recipient_driver_id, created_at, event_id)
  WHERE recipient_driver_id IS NOT NULL;

GRANT UPDATE (driver_id, updated_at) ON TABLE rotamoto.memberships TO rotamoto_app;
GRANT INSERT (company_id, event_id, app_key, installation_id, recipient_driver_id, payload)
  ON TABLE rotamoto.sync_outbox TO rotamoto_app;

COMMENT ON COLUMN rotamoto.memberships.driver_id IS
  'Canonical tenant-scoped Driver explicitly associated by an authorized administrator; never inferred from identity metadata.';
COMMENT ON COLUMN rotamoto.sync_outbox.recipient_driver_id IS
  'Optional server-selected recipient for minimal driver authorization notifications such as assignment revocation.';
