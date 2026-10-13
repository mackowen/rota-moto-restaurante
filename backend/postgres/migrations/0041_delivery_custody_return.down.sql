DROP INDEX IF EXISTS rotamoto.domain_one_return_delivery_per_original_uq;
DROP TABLE IF EXISTS rotamoto.delivery_custody_operations;
ALTER TABLE rotamoto.domain_records DROP CONSTRAINT IF EXISTS domain_records_related_entity_type_check;
ALTER TABLE rotamoto.domain_records ADD CONSTRAINT domain_records_check1 CHECK (
  (entity_type='Delivery' AND (related_entity_type IS NULL OR related_entity_type='Order')) OR
  (entity_type='DeliveryEvent' AND (related_entity_type IS NULL OR related_entity_type IN ('Delivery','Order'))) OR
  (entity_type IN ('LocationPoint','DeliveryProof','Earning') AND (related_entity_type IS NULL OR related_entity_type='Delivery')) OR
  (entity_type IN ('Company','Driver','Order','Route') AND related_entity_type IS NULL)
);
