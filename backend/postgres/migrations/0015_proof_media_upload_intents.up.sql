CREATE TABLE rotamoto.proof_media_upload_intents (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  delivery_entity_type text NOT NULL DEFAULT 'Delivery' CHECK (delivery_entity_type='Delivery'),
  proof_id uuid NOT NULL,
  object_key text NOT NULL CHECK (object_key ~ '^tenant/[0-9a-f-]{36}/delivery/[0-9a-f-]{36}/proof/[0-9a-f-]{36}\.(png|jpg)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, proof_id),
  UNIQUE (company_id, object_key),
  FOREIGN KEY (company_id, delivery_id, delivery_entity_type)
    REFERENCES rotamoto.domain_records(company_id, record_id, entity_type) ON DELETE RESTRICT
);
CREATE INDEX proof_media_upload_intents_delivery_idx
  ON rotamoto.proof_media_upload_intents(company_id, delivery_id);
ALTER TABLE rotamoto.proof_media_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.proof_media_upload_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.proof_media_upload_intents
  USING (company_id = rotamoto.current_tenant_id())
  WITH CHECK (company_id = rotamoto.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE rotamoto.proof_media_upload_intents TO rotamoto_app;
COMMENT ON TABLE rotamoto.proof_media_upload_intents IS
  'Roots staged filesystem media until its DeliveryProof reference is committed; tenant scoped and never contains blob bytes.';
