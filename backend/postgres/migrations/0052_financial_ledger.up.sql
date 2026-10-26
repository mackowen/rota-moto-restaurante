INSERT INTO rotamoto.permissions (permission_key, catalog_version, description) VALUES
  ('finance.read', 1, 'Consultar eventos financeiros canônicos da empresa'),
  ('finance.manage', 1, 'Registrar e reconciliar eventos financeiros da empresa')
ON CONFLICT (permission_key, catalog_version) DO NOTHING;

INSERT INTO rotamoto.role_permissions (company_id, role_id, permission_key, catalog_version)
SELECT r.company_id, r.id, p.permission_key, 1
FROM rotamoto.roles r
JOIN rotamoto.role_permissions admin ON admin.company_id=r.company_id AND admin.role_id=r.id
  AND admin.catalog_version=1 AND admin.permission_key='company.manage'
CROSS JOIN rotamoto.permissions p
WHERE p.catalog_version=1 AND p.permission_key IN ('finance.read','finance.manage')
ON CONFLICT DO NOTHING;

CREATE TABLE rotamoto.financial_events (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  order_id uuid,
  delivery_id uuid,
  earning_id uuid,
  related_event_id uuid,
  event_kind text NOT NULL CHECK (event_kind IN ('PAYMENT_CONFIRMED','REFUND','ADJUSTMENT','PAYOUT_SETTLED')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN -9000000000000000 AND 9000000000000000 AND amount_minor<>0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_method text,
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 1 AND 160),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  source_kind text NOT NULL DEFAULT 'operator_declaration' CHECK (source_kind IN ('operator_declaration')),
  actor_user_id uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, event_id),
  UNIQUE (company_id, idempotency_key),
  FOREIGN KEY (company_id, order_id) REFERENCES rotamoto.domain_records(company_id, record_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, delivery_id) REFERENCES rotamoto.domain_records(company_id, record_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, earning_id) REFERENCES rotamoto.domain_records(company_id, record_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, related_event_id) REFERENCES rotamoto.financial_events(company_id, event_id) ON DELETE RESTRICT,
  CHECK ((event_kind IN ('PAYMENT_CONFIRMED','REFUND','ADJUSTMENT') AND order_id IS NOT NULL AND earning_id IS NULL) OR
         (event_kind='PAYOUT_SETTLED' AND earning_id IS NOT NULL AND order_id IS NULL)),
  CHECK ((event_kind='ADJUSTMENT' AND payment_method IS NULL) OR
         (event_kind<>'ADJUSTMENT' AND payment_method IN ('cash','pix','credit','debit','transfer','voucher','marketplace','other'))),
  CHECK ((event_kind='REFUND' AND related_event_id IS NOT NULL AND amount_minor>0) OR
         (event_kind<>'REFUND' AND related_event_id IS NULL)),
  CHECK (event_kind<>'PAYOUT_SETTLED' OR amount_minor>0),
  CHECK (event_kind<>'PAYMENT_CONFIRMED' OR amount_minor>0),
  CHECK (event_kind<>'ADJUSTMENT' OR related_event_id IS NOT NULL),
  CHECK (occurred_at<=created_at)
);

CREATE INDEX financial_events_order_idx ON rotamoto.financial_events(company_id, order_id, occurred_at, event_id)
  WHERE order_id IS NOT NULL;
CREATE INDEX financial_events_earning_idx ON rotamoto.financial_events(company_id, earning_id, occurred_at, event_id)
  WHERE earning_id IS NOT NULL;
CREATE INDEX financial_events_period_idx ON rotamoto.financial_events(company_id, occurred_at, event_id);

ALTER TABLE rotamoto.financial_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.financial_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.financial_events
  USING (company_id=rotamoto.current_tenant_id())
  WITH CHECK (company_id=rotamoto.current_tenant_id());
GRANT SELECT, INSERT ON TABLE rotamoto.financial_events TO rotamoto_app;

CREATE FUNCTION rotamoto.guard_financial_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial_events são imutáveis; registre evento compensatório';
END;
$$;
CREATE TRIGGER financial_events_immutable
  BEFORE UPDATE OR DELETE ON rotamoto.financial_events
  FOR EACH ROW EXECUTE FUNCTION rotamoto.guard_financial_event_immutable();
