CREATE TABLE rotamoto.delivery_custody_operations (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  operation_type text NOT NULL CHECK (operation_type IN ('CANCEL','RETURN','RELEASE','INCIDENT','RECEIPT')),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 16 AND 128 AND idempotency_key !~ '[[:cntrl:]]'),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  delivery_id uuid NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object'),
  actor_user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,operation_type,idempotency_key),
  FOREIGN KEY (company_id,delivery_id) REFERENCES rotamoto.domain_records(company_id,record_id) ON DELETE RESTRICT
);

ALTER TABLE rotamoto.delivery_custody_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.delivery_custody_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.delivery_custody_operations
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
GRANT SELECT,INSERT ON rotamoto.delivery_custody_operations TO rotamoto_app;

ALTER TABLE rotamoto.domain_records DROP CONSTRAINT domain_records_check1;
ALTER TABLE rotamoto.domain_records ADD CONSTRAINT domain_records_related_entity_type_check CHECK (
  (entity_type='Delivery' AND (
    related_entity_type IS NULL OR related_entity_type='Order' OR
    (related_entity_type='Delivery' AND payload->'extensions'->>'x_rotamoto_delivery_type'='RETURN')
  )) OR
  (entity_type='DeliveryEvent' AND (related_entity_type IS NULL OR related_entity_type IN ('Delivery','Order'))) OR
  (entity_type IN ('LocationPoint','DeliveryProof','Earning') AND (related_entity_type IS NULL OR related_entity_type='Delivery')) OR
  (entity_type IN ('Company','Driver','Order','Route') AND related_entity_type IS NULL)
);

-- A RETURN delivery is linked through the existing domain_records relation and
-- namespaced extension. This prevents concurrent/replayed commands creating a
-- second operational return for the same original, including after completion.
CREATE UNIQUE INDEX domain_one_return_delivery_per_original_uq
  ON rotamoto.domain_records(company_id,related_record_id)
  WHERE entity_type='Delivery' AND related_entity_type='Delivery'
    AND payload->'extensions'->>'x_rotamoto_delivery_type'='RETURN';

COMMENT ON TABLE rotamoto.delivery_custody_operations IS
  'Tenant-scoped idempotency receipts for audited delivery custody decisions; does not duplicate Order or financial data.';
