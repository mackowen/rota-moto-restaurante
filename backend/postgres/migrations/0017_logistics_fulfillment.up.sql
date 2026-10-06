CREATE TABLE rotamoto.logistics_providers (
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  provider_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_-]{1,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  provider_class text NOT NULL CHECK (provider_class IN ('internal_fleet','partner','marketplace')),
  enabled boolean NOT NULL DEFAULT true,
  capabilities text[] NOT NULL DEFAULT ARRAY['manual_assignment']::text[],
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuration)='object'
    AND configuration - ARRAY['dispatchInstructions','portalUrl']::text[] = '{}'::jsonb),
  secret_ref text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, provider_id),
  UNIQUE (company_id, code),
  CHECK (capabilities <@ ARRAY['manual_assignment']::text[]),
  CHECK ((provider_class='internal_fleet' AND code='internal_fleet') OR provider_class<>'internal_fleet'),
  CHECK (provider_class<>'internal_fleet' OR (enabled AND capabilities @> ARRAY['manual_assignment']::text[])),
  CHECK (secret_ref IS NULL OR (length(secret_ref) BETWEEN 1 AND 256 AND secret_ref !~ '[[:cntrl:]]')),
  CHECK (updated_at >= created_at)
);

CREATE TABLE rotamoto.delivery_fulfillments (
  company_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  delivery_entity_type text NOT NULL DEFAULT 'Delivery' CHECK (delivery_entity_type='Delivery'),
  provider_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('internal','external')),
  driver_id uuid,
  driver_entity_type text NOT NULL DEFAULT 'Driver' CHECK (driver_entity_type='Driver'),
  external_reference text CHECK (external_reference IS NULL OR
    (length(btrim(external_reference)) BETWEEN 1 AND 160 AND external_reference !~ '[[:cntrl:]]')),
  status text NOT NULL CHECK (status IN ('selected','dispatch_requested','accepted','in_progress','arrived','completed','cancelled','failed','superseded')),
  selected_at timestamptz NOT NULL DEFAULT now(),
  selected_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  updated_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  quote_amount_minor bigint CHECK (quote_amount_minor IS NULL OR quote_amount_minor BETWEEN 0 AND 9000000000000000),
  quote_currency text CHECK (quote_currency IS NULL OR quote_currency ~ '^[A-Z]{3}$'),
  eta_at timestamptz,
  estimated_cost_minor bigint CHECK (estimated_cost_minor IS NULL OR estimated_cost_minor BETWEEN 0 AND 9000000000000000),
  estimated_cost_currency text CHECK (estimated_cost_currency IS NULL OR estimated_cost_currency ~ '^[A-Z]{3}$'),
  final_cost_minor bigint CHECK (final_cost_minor IS NULL OR final_cost_minor BETWEEN 0 AND 9000000000000000),
  final_cost_currency text CHECK (final_cost_currency IS NULL OR final_cost_currency ~ '^[A-Z]{3}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, fulfillment_id),
  UNIQUE (company_id, fulfillment_id, delivery_id),
  UNIQUE (company_id, delivery_id, revision),
  FOREIGN KEY (company_id, delivery_id, delivery_entity_type)
    REFERENCES rotamoto.domain_records(company_id, record_id, entity_type) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, provider_id) REFERENCES rotamoto.logistics_providers(company_id, provider_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, driver_id, driver_entity_type)
    REFERENCES rotamoto.domain_records(company_id, record_id, entity_type) ON DELETE RESTRICT,
  CHECK ((mode='internal' AND driver_id IS NOT NULL AND external_reference IS NULL) OR
         (mode='external' AND driver_id IS NULL)),
  CHECK ((quote_amount_minor IS NULL)=(quote_currency IS NULL)),
  CHECK ((estimated_cost_minor IS NULL)=(estimated_cost_currency IS NULL)),
  CHECK ((final_cost_minor IS NULL)=(final_cost_currency IS NULL)),
  CHECK (final_cost_minor IS NULL OR status='completed'),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX delivery_fulfillments_one_active_uq
  ON rotamoto.delivery_fulfillments(company_id, delivery_id)
  WHERE status IN ('selected','dispatch_requested','accepted','in_progress','arrived');
CREATE INDEX delivery_fulfillments_delivery_history_idx
  ON rotamoto.delivery_fulfillments(company_id, delivery_id, revision DESC);
CREATE INDEX delivery_fulfillments_provider_status_idx
  ON rotamoto.delivery_fulfillments(company_id, provider_id, status, updated_at DESC);

CREATE TABLE rotamoto.dispatch_attempts (
  company_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  fulfillment_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key !~ '[[:cntrl:]]'),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('requested','accepted','rejected','cancel_requested','cancelled','unknown','completed','failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  external_reference text CHECK (external_reference IS NULL OR
    (length(btrim(external_reference)) BETWEEN 1 AND 160 AND external_reference !~ '[[:cntrl:]]')),
  quote_amount_minor bigint CHECK (quote_amount_minor IS NULL OR quote_amount_minor BETWEEN 0 AND 9000000000000000),
  quote_currency text CHECK (quote_currency IS NULL OR quote_currency ~ '^[A-Z]{3}$'),
  estimated_cost_minor bigint CHECK (estimated_cost_minor IS NULL OR estimated_cost_minor BETWEEN 0 AND 9000000000000000),
  estimated_cost_currency text CHECK (estimated_cost_currency IS NULL OR estimated_cost_currency ~ '^[A-Z]{3}$'),
  eta_at timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  retry_of uuid,
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  requested_by uuid NOT NULL REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, attempt_id),
  UNIQUE (company_id, provider_id, idempotency_key),
  UNIQUE (company_id, fulfillment_id, attempt_number),
  FOREIGN KEY (company_id, fulfillment_id, delivery_id)
    REFERENCES rotamoto.delivery_fulfillments(company_id, fulfillment_id, delivery_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, provider_id) REFERENCES rotamoto.logistics_providers(company_id, provider_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id, retry_of) REFERENCES rotamoto.dispatch_attempts(company_id, attempt_id) ON DELETE RESTRICT,
  CHECK ((quote_amount_minor IS NULL)=(quote_currency IS NULL)),
  CHECK ((estimated_cost_minor IS NULL)=(estimated_cost_currency IS NULL)),
  CHECK (responded_at IS NULL OR responded_at >= requested_at),
  CHECK ((status='requested' AND responded_at IS NULL) OR (status<>'requested' AND responded_at IS NOT NULL))
);
CREATE INDEX dispatch_attempts_fulfillment_idx
  ON rotamoto.dispatch_attempts(company_id, fulfillment_id, attempt_number DESC);

CREATE FUNCTION rotamoto.guard_fulfillment_provider_mode() RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog,rotamoto
AS $$
DECLARE provider_class_value text; provider_enabled_value boolean;
BEGIN
  SELECT provider_class,enabled INTO provider_class_value,provider_enabled_value
    FROM rotamoto.logistics_providers
    WHERE company_id=NEW.company_id AND provider_id=NEW.provider_id;
  IF NOT FOUND OR NOT provider_enabled_value THEN RAISE EXCEPTION 'LogisticsProvider unavailable'; END IF;
  IF (NEW.mode='internal' AND provider_class_value<>'internal_fleet') OR
     (NEW.mode='external' AND provider_class_value='internal_fleet') THEN
    RAISE EXCEPTION 'Fulfillment mode does not match LogisticsProvider class';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rotamoto.guard_fulfillment_provider_mode() FROM PUBLIC;

CREATE TRIGGER delivery_fulfillment_provider_mode
  BEFORE INSERT OR UPDATE OF company_id,provider_id,mode ON rotamoto.delivery_fulfillments
  FOR EACH ROW EXECUTE FUNCTION rotamoto.guard_fulfillment_provider_mode();

ALTER TABLE rotamoto.logistics_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.logistics_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.logistics_providers
  USING (company_id=rotamoto.current_tenant_id()) WITH CHECK (company_id=rotamoto.current_tenant_id());
ALTER TABLE rotamoto.delivery_fulfillments ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.delivery_fulfillments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.delivery_fulfillments
  USING (company_id=rotamoto.current_tenant_id()) WITH CHECK (company_id=rotamoto.current_tenant_id());
ALTER TABLE rotamoto.dispatch_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.dispatch_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.dispatch_attempts
  USING (company_id=rotamoto.current_tenant_id()) WITH CHECK (company_id=rotamoto.current_tenant_id());

GRANT SELECT ON TABLE rotamoto.logistics_providers TO rotamoto_app;
GRANT INSERT (company_id,provider_id,code,display_name,provider_class,enabled,capabilities,configuration,created_by,updated_by)
  ON TABLE rotamoto.logistics_providers TO rotamoto_app;
GRANT UPDATE (display_name,enabled,configuration,version,updated_by,updated_at)
  ON TABLE rotamoto.logistics_providers TO rotamoto_app;
GRANT SELECT ON TABLE rotamoto.delivery_fulfillments TO rotamoto_app;
GRANT INSERT (company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,external_reference,status,selected_at,selected_by,
  updated_by,revision,quote_amount_minor,quote_currency,eta_at,estimated_cost_minor,estimated_cost_currency,final_cost_minor,final_cost_currency)
  ON TABLE rotamoto.delivery_fulfillments TO rotamoto_app;
GRANT UPDATE (status,external_reference,revision,updated_by,updated_at,eta_at,estimated_cost_minor,estimated_cost_currency,final_cost_minor,final_cost_currency)
  ON TABLE rotamoto.delivery_fulfillments TO rotamoto_app;
GRANT SELECT ON TABLE rotamoto.dispatch_attempts TO rotamoto_app;
GRANT INSERT (company_id,attempt_id,fulfillment_id,delivery_id,provider_id,idempotency_key,request_digest,attempt_number,status,
  external_reference,quote_amount_minor,quote_currency,estimated_cost_minor,estimated_cost_currency,eta_at,error_code,retry_of,retry_count,requested_by)
  ON TABLE rotamoto.dispatch_attempts TO rotamoto_app;
GRANT UPDATE (status,responded_at) ON TABLE rotamoto.dispatch_attempts TO rotamoto_app;
COMMENT ON TABLE rotamoto.logistics_providers IS 'Tenant-scoped logistics provider catalog; only manual_assignment is currently implemented. Secret values are never stored here.';
COMMENT ON TABLE rotamoto.delivery_fulfillments IS 'Versioned provider allocation for a canonical Delivery. External allocations never contain a canonical Driver.';
COMMENT ON TABLE rotamoto.dispatch_attempts IS 'Idempotent manual dispatch audit and future side-effect boundary; no provider API is called by this schema.';
