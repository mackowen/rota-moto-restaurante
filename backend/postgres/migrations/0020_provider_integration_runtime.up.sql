ALTER TABLE rotamoto.logistics_providers
  ADD COLUMN integration_mode text NOT NULL DEFAULT 'manual' CHECK (integration_mode IN ('manual','api')),
  ADD COLUMN api_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN last_connection_test_at timestamptz,
  ADD COLUMN last_connection_test_status text CHECK (last_connection_test_status IS NULL OR last_connection_test_status IN ('ok','error','not_configured'));
ALTER TABLE rotamoto.logistics_providers DROP CONSTRAINT logistics_providers_capabilities_check;
ALTER TABLE rotamoto.logistics_providers ADD CONSTRAINT logistics_providers_capabilities_check
  CHECK (capabilities <@ ARRAY['manual_assignment','quote','dispatch','cancel','tracking','webhook']::text[]);
ALTER TABLE rotamoto.logistics_providers ADD CONSTRAINT logistics_provider_api_gate
  CHECK (NOT api_enabled OR (enabled AND integration_mode='api' AND provider_class<>'internal_fleet' AND secret_ref IS NOT NULL));

CREATE TABLE rotamoto.provider_quotes (
  company_id uuid NOT NULL,
  quote_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  delivery_entity_type text NOT NULL DEFAULT 'Delivery' CHECK(delivery_entity_type='Delivery'),
  fulfillment_id uuid,
  provider_id uuid NOT NULL,
  external_quote_id text NOT NULL CHECK (length(external_quote_id) BETWEEN 1 AND 160 AND external_quote_id !~ '[[:cntrl:]]'),
  status text NOT NULL CHECK (status IN ('available','selected','expired','rejected')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9000000000000000),
  eta_at timestamptz,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  selected_at timestamptz,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_snapshot)='object' AND provider_snapshot - ARRAY['provider','status']::text[] = '{}'::jsonb),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,quote_id),
  UNIQUE(company_id,provider_id,external_quote_id),
  FOREIGN KEY(company_id,delivery_id,delivery_entity_type) REFERENCES rotamoto.domain_records(company_id,record_id,entity_type) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,provider_id) REFERENCES rotamoto.logistics_providers(company_id,provider_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,fulfillment_id,delivery_id) REFERENCES rotamoto.delivery_fulfillments(company_id,fulfillment_id,delivery_id) ON DELETE RESTRICT,
  CHECK(expires_at > issued_at), CHECK(selected_at IS NULL OR status='selected'), CHECK(updated_at>=created_at)
);
CREATE INDEX provider_quotes_delivery_idx ON rotamoto.provider_quotes(company_id,delivery_id,created_at DESC);
CREATE INDEX provider_quotes_expiry_idx ON rotamoto.provider_quotes(company_id,provider_id,expires_at) WHERE status='available';

CREATE TABLE rotamoto.provider_command_outbox (
  company_id uuid NOT NULL,
  command_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  delivery_entity_type text NOT NULL DEFAULT 'Delivery' CHECK(delivery_entity_type='Delivery'),
  fulfillment_id uuid,
  operation text NOT NULL CHECK(operation IN ('QUOTE_REQUEST','DISPATCH_REQUEST','CANCEL_REQUEST','TRACKING_REFRESH','RECONCILE')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 160 AND idempotency_key !~ '[[:cntrl:]]'),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND payload - ARRAY['deliveryId','fulfillmentId','quoteId','dispatchAttemptId','reason']::text[] = '{}'::jsonb),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','succeeded','rejected','unknown_outcome','needs_review')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid, lease_until timestamptz, last_error_class text CHECK(last_error_class IS NULL OR last_error_class IN ('TRANSIENT','RATE_LIMIT','AUTH','PERMANENT','CONFLICT','UNKNOWN_OUTCOME')),
  correlation_id uuid NOT NULL, created_by uuid REFERENCES rotamoto.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  PRIMARY KEY(company_id,command_id), UNIQUE(company_id,provider_id,operation,idempotency_key),
  FOREIGN KEY(company_id,provider_id) REFERENCES rotamoto.logistics_providers(company_id,provider_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,delivery_id,delivery_entity_type) REFERENCES rotamoto.domain_records(company_id,record_id,entity_type) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,fulfillment_id,delivery_id) REFERENCES rotamoto.delivery_fulfillments(company_id,fulfillment_id,delivery_id) ON DELETE RESTRICT,
  CHECK((status='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((status IN ('succeeded','rejected','unknown_outcome','needs_review'))=(completed_at IS NOT NULL)), CHECK(updated_at>=created_at)
);
CREATE INDEX provider_command_ready_idx ON rotamoto.provider_command_outbox(next_attempt_at,created_at) WHERE status='queued';
CREATE INDEX provider_command_tenant_state_idx ON rotamoto.provider_command_outbox(company_id,status,updated_at DESC);

CREATE TABLE rotamoto.provider_event_inbox (
  company_id uuid NOT NULL, event_id uuid NOT NULL, provider_id uuid NOT NULL,
  external_event_id text NOT NULL CHECK(length(external_event_id) BETWEEN 1 AND 160 AND external_event_id !~ '[[:cntrl:]]'),
  body_digest bytea NOT NULL CHECK(octet_length(body_digest)=32),
  normalized_event jsonb NOT NULL CHECK(jsonb_typeof(normalized_event)='object' AND normalized_event - ARRAY['status','externalOrderId','occurredAt','externalStatus']::text[] = '{}'::jsonb),
  status text NOT NULL DEFAULT 'received' CHECK(status IN ('received','processing','processed','unmapped','rejected')),
  received_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz,
  PRIMARY KEY(company_id,event_id), UNIQUE(company_id,provider_id,external_event_id),
  FOREIGN KEY(company_id,provider_id) REFERENCES rotamoto.logistics_providers(company_id,provider_id) ON DELETE RESTRICT,
  CHECK((status IN ('processed','unmapped','rejected'))=(processed_at IS NOT NULL))
);
CREATE INDEX provider_event_inbox_pending_idx ON rotamoto.provider_event_inbox(company_id,received_at) WHERE status='received';

CREATE TABLE rotamoto.provider_tracking_snapshots (
  company_id uuid NOT NULL, fulfillment_id uuid NOT NULL, delivery_id uuid NOT NULL, provider_id uuid NOT NULL,
  provenance text NOT NULL DEFAULT 'external_provider' CHECK(provenance='external_provider'),
  status text CHECK(status IS NULL OR status IN ('accepted','in_progress','arrived','completed','cancelled','failed','unmapped')),
  eta_at timestamptz, provider_updated_at timestamptz, last_event_id uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,fulfillment_id),
  FOREIGN KEY(company_id,fulfillment_id,delivery_id) REFERENCES rotamoto.delivery_fulfillments(company_id,fulfillment_id,delivery_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,provider_id) REFERENCES rotamoto.logistics_providers(company_id,provider_id) ON DELETE RESTRICT,
  FOREIGN KEY(company_id,last_event_id) REFERENCES rotamoto.provider_event_inbox(company_id,event_id) ON DELETE RESTRICT
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['provider_quotes','provider_command_outbox','provider_event_inbox','provider_tracking_snapshots'] LOOP
    EXECUTE format('ALTER TABLE rotamoto.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE rotamoto.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON rotamoto.%I USING (company_id=rotamoto.current_tenant_id()) WITH CHECK (company_id=rotamoto.current_tenant_id())',t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.%I TO rotamoto_app',t);
  END LOOP;
END $$;
GRANT SELECT (integration_mode,api_enabled,last_connection_test_at,last_connection_test_status) ON rotamoto.logistics_providers TO rotamoto_app;
GRANT UPDATE (integration_mode,api_enabled,last_connection_test_at,last_connection_test_status) ON rotamoto.logistics_providers TO rotamoto_app;
REVOKE SELECT ON rotamoto.logistics_providers FROM rotamoto_app;
GRANT SELECT (company_id,provider_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at,integration_mode,api_enabled,last_connection_test_at,last_connection_test_status) ON rotamoto.logistics_providers TO rotamoto_app;

CREATE FUNCTION rotamoto.claim_provider_command(p_lease uuid,p_seconds integer DEFAULT 45)
RETURNS TABLE(company_id uuid,command_id uuid,provider_id uuid,delivery_id uuid,fulfillment_id uuid,operation text,idempotency_key text,payload jsonb,attempts integer,correlation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  RETURN QUERY WITH candidate AS (
    SELECT o.company_id,o.command_id FROM rotamoto.provider_command_outbox o
    JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
    WHERE p.enabled AND p.api_enabled AND p.integration_mode='api'
      AND o.attempts<8 AND ((o.status='queued' AND o.next_attempt_at<=now()) OR (o.status='leased' AND o.lease_until<now()))
    ORDER BY o.next_attempt_at,o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE rotamoto.provider_command_outbox o SET status='leased',lease_token=p_lease,lease_until=now()+make_interval(secs=>least(greatest(p_seconds,10),120)),attempts=o.attempts+1,updated_at=now()
    FROM candidate c WHERE o.company_id=c.company_id AND o.command_id=c.command_id
    RETURNING o.company_id,o.command_id,o.provider_id,o.delivery_id,o.fulfillment_id,o.operation,o.idempotency_key,o.payload,o.attempts,o.correlation_id
  ) SELECT * FROM claimed;
END $$;
REVOKE ALL ON FUNCTION rotamoto.claim_provider_command(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.claim_provider_command(uuid,integer) TO rotamoto_app;

COMMENT ON TABLE rotamoto.provider_command_outbox IS 'Durable provider commands. Delivery is at-least-once with idempotency and reconciliation; this is separate from app sync outbox.';
COMMENT ON TABLE rotamoto.provider_event_inbox IS 'Sanitized normalized provider events only; request bodies and PII are never persisted.';
