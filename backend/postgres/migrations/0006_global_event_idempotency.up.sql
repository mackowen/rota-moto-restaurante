ALTER TABLE rotamoto.domain_records
  ADD COLUMN source_event_id text,
  ADD CONSTRAINT domain_records_source_event_id_check
    CHECK (source_event_id IS NULL OR length(btrim(source_event_id)) BETWEEN 1 AND 255),
  ADD CONSTRAINT domain_records_source_event_type_check
    CHECK (source_event_id IS NULL OR entity_type='DeliveryEvent');

CREATE UNIQUE INDEX domain_records_event_idempotency_uq
  ON rotamoto.domain_records(company_id, source_event_id)
  WHERE entity_type='DeliveryEvent' AND source_event_id IS NOT NULL;
