CREATE TABLE rotamoto.logistics_decisions (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  decision_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('proposed','approved','rejected','stale','execution_requested','executed','failed','unknown_outcome')),
  policy text NOT NULL CHECK (policy IN ('lowest_cost','prefer_internal','earliest_eta','balanced')),
  recommended_alternative_id text,
  selected_alternative_id text,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  state_fingerprint char(64) NOT NULL CHECK (state_fingerprint ~ '^[a-f0-9]{64}$'),
  evaluated_at timestamptz NOT NULL,
  proposed_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  decided_by uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  execution_key text,
  execution_result jsonb CHECK (execution_result IS NULL OR jsonb_typeof(execution_result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,decision_id),
  FOREIGN KEY(company_id,delivery_id) REFERENCES rotamoto.domain_records(company_id,record_id) ON DELETE RESTRICT,
  CHECK ((status IN ('approved','rejected','execution_requested','executed','failed','unknown_outcome')) = (decided_at IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (updated_at >= created_at)
);
CREATE UNIQUE INDEX logistics_decisions_execution_idempotency
  ON rotamoto.logistics_decisions(company_id,execution_key) WHERE execution_key IS NOT NULL;
CREATE INDEX logistics_decisions_delivery_history
  ON rotamoto.logistics_decisions(company_id,delivery_id,created_at DESC);
ALTER TABLE rotamoto.logistics_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.logistics_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.logistics_decisions
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
GRANT SELECT,INSERT,UPDATE ON TABLE rotamoto.logistics_decisions TO rotamoto_app;
