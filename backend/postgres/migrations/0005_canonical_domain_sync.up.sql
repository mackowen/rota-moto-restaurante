CREATE TABLE rotamoto.sync_installations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  app_key text NOT NULL CHECK (app_key IN ('restaurante','motoboy')),
  local_device_id text NOT NULL CHECK (length(btrim(local_device_id)) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, app_key, local_device_id),
  UNIQUE (company_id, app_key, id),
  CHECK (last_seen_at >= created_at)
);

CREATE TABLE rotamoto.domain_records (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  record_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN (
    'Company','Driver','Order','Delivery','Route','DeliveryEvent',
    'LocationPoint','DeliveryProof','Earning'
  )),
  source_app text NOT NULL CHECK (source_app IN ('restaurante','motoboy')),
  source_installation_id uuid NOT NULL,
  related_entity_type text,
  related_record_id uuid,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (company_id, record_id),
  UNIQUE (company_id, record_id, entity_type),
  FOREIGN KEY (company_id, source_app, source_installation_id)
    REFERENCES rotamoto.sync_installations(company_id, app_key, id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, related_record_id, related_entity_type)
    REFERENCES rotamoto.domain_records(company_id, record_id, entity_type)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK ((related_record_id IS NULL) = (related_entity_type IS NULL)),
  CHECK (
    (entity_type='Delivery' AND (related_entity_type IS NULL OR related_entity_type='Order')) OR
    (entity_type='DeliveryEvent' AND (related_entity_type IS NULL OR related_entity_type IN ('Delivery','Order'))) OR
    (entity_type IN ('LocationPoint','DeliveryProof','Earning') AND
      (related_entity_type IS NULL OR related_entity_type='Delivery')) OR
    (entity_type IN ('Company','Driver','Order','Route') AND related_entity_type IS NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CHECK (entity_type <> 'Delivery' OR payload->>'status' IN (
    'CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED',
    'DELIVERED','CANCELLED','FAILED','RETURNED','REDELIVERY'
  )),
  CHECK (entity_type <> 'DeliveryEvent' OR deleted_at IS NULL)
);

ALTER TABLE rotamoto.local_id_maps
  ADD CONSTRAINT local_id_maps_installation_fk
    FOREIGN KEY (company_id, app_key, installation_id)
    REFERENCES rotamoto.sync_installations(company_id, app_key, id) ON DELETE RESTRICT,
  ADD CONSTRAINT local_id_maps_canonical_record_fk
    FOREIGN KEY (company_id, canonical_id)
    REFERENCES rotamoto.domain_records(company_id, record_id) ON DELETE RESTRICT;
ALTER TABLE rotamoto.sync_inbox
  ADD CONSTRAINT sync_inbox_installation_fk
    FOREIGN KEY (company_id, app_key, installation_id)
    REFERENCES rotamoto.sync_installations(company_id, app_key, id) ON DELETE RESTRICT;
ALTER TABLE rotamoto.sync_outbox
  ADD CONSTRAINT sync_outbox_installation_fk
    FOREIGN KEY (company_id, app_key, installation_id)
    REFERENCES rotamoto.sync_installations(company_id, app_key, id) ON DELETE RESTRICT;

CREATE INDEX domain_records_tenant_entity_updated_idx
  ON rotamoto.domain_records(company_id, entity_type, updated_at DESC, record_id);
CREATE INDEX domain_records_related_idx
  ON rotamoto.domain_records(company_id, related_entity_type, related_record_id)
  WHERE related_record_id IS NOT NULL;
CREATE INDEX sync_outbox_tenant_cursor_idx
  ON rotamoto.sync_outbox(company_id, created_at, event_id);

CREATE FUNCTION rotamoto.guard_domain_event_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.entity_type='DeliveryEvent' THEN
    RAISE EXCEPTION 'DeliveryEvent é um fato imutável';
  END IF;
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER domain_delivery_events_immutable
  BEFORE UPDATE OR DELETE ON rotamoto.domain_records
  FOR EACH ROW EXECUTE FUNCTION rotamoto.guard_domain_event_immutable();

ALTER TABLE rotamoto.sync_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.sync_installations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.sync_installations
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
ALTER TABLE rotamoto.domain_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.domain_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.domain_records
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.sync_installations TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.domain_records TO rotamoto_app;
GRANT SELECT, INSERT ON TABLE rotamoto.local_id_maps TO rotamoto_app;
GRANT SELECT, INSERT ON TABLE rotamoto.sync_inbox TO rotamoto_app;
GRANT SELECT, INSERT ON TABLE rotamoto.sync_outbox TO rotamoto_app;
