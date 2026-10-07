-- Marketplace account bindings and durable order event/command processing.
-- Raw webhook bodies, credentials and customer data are deliberately excluded.
ALTER TABLE rotamoto.external_accounts
  ADD COLUMN account_status text NOT NULL DEFAULT 'pending'
    CHECK (account_status IN ('pending','active','disabled','revoked','reauthorization_required','error')),
  ADD COLUMN token_expires_at timestamptz,
  ADD COLUMN last_sync_at timestamptz,
  ADD COLUMN last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  ADD COLUMN poll_next_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN poll_lease_token uuid,
  ADD COLUMN poll_lease_until timestamptz,
  ADD CONSTRAINT external_accounts_poll_lease_check CHECK ((poll_lease_token IS NULL)=(poll_lease_until IS NULL));
ALTER TABLE rotamoto.external_accounts
  ADD CONSTRAINT external_accounts_id_company_integration_uq UNIQUE(id,company_id,integration_id);

CREATE TABLE rotamoto.marketplace_oauth_states (
  state_digest bytea PRIMARY KEY CHECK (octet_length(state_digest)=32),
  company_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ifood','keeta')),
  redirect_uri text NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2048),
  code_verifier_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  FOREIGN KEY (integration_id,company_id) REFERENCES rotamoto.integrations(id,company_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);
CREATE INDEX marketplace_oauth_states_expiry_idx ON rotamoto.marketplace_oauth_states(expires_at);

CREATE TABLE rotamoto.marketplace_account_bindings (
  company_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  external_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ifood','keeta')),
  merchant_id text NOT NULL CHECK (length(btrim(merchant_id)) BETWEEN 1 AND 255 AND merchant_id !~ '[[:cntrl:]]'),
  service_merchant_id text CHECK (service_merchant_id IS NULL OR (length(btrim(service_merchant_id)) BETWEEN 1 AND 255 AND service_merchant_id !~ '[[:cntrl:]]')),
  display_name text CHECK (display_name IS NULL OR length(display_name) <= 160),
  authorized boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,external_account_id,merchant_id),
  UNIQUE(provider,merchant_id),
  FOREIGN KEY (external_account_id,company_id) REFERENCES rotamoto.external_accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY (external_account_id,company_id,integration_id) REFERENCES rotamoto.external_accounts(id,company_id,integration_id) ON DELETE RESTRICT,
  FOREIGN KEY (integration_id,company_id) REFERENCES rotamoto.integrations(id,company_id) ON DELETE RESTRICT,
  CHECK ((provider='keeta') OR service_merchant_id IS NULL),
  CHECK (updated_at >= created_at)
);
CREATE INDEX marketplace_account_binding_lookup_idx ON rotamoto.marketplace_account_bindings(provider,merchant_id) WHERE authorized;

-- A minimal global routing index lets the privileged resolver find a tenant from
-- provider identity before setting tenant RLS context. It contains no secrets or PII.
CREATE TABLE rotamoto.marketplace_account_routes (
  provider text NOT NULL CHECK (provider IN ('ifood','keeta')),
  route_kind text NOT NULL CHECK (route_kind IN ('account','merchant')),
  route_key text NOT NULL CHECK (length(btrim(route_key)) BETWEEN 1 AND 255 AND route_key !~ '[[:cntrl:]]'),
  company_id uuid NOT NULL,
  external_account_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,route_kind,route_key),
  FOREIGN KEY(external_account_id,company_id) REFERENCES rotamoto.external_accounts(id,company_id) ON DELETE RESTRICT
);
REVOKE ALL ON rotamoto.marketplace_account_routes FROM PUBLIC,rotamoto_app;
CREATE FUNCTION rotamoto.sync_marketplace_account_route() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    DELETE FROM rotamoto.marketplace_account_routes WHERE provider=OLD.provider AND external_account_id=OLD.external_account_id;
  END IF;
  INSERT INTO rotamoto.marketplace_account_routes(provider,route_kind,route_key,company_id,external_account_id)
    VALUES(NEW.provider,'account',NEW.external_account_id::text,NEW.company_id,NEW.external_account_id),
          (NEW.provider,'merchant',NEW.merchant_id,NEW.company_id,NEW.external_account_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rotamoto.sync_marketplace_account_route() FROM PUBLIC;
CREATE TRIGGER marketplace_account_route_sync AFTER INSERT OR UPDATE ON rotamoto.marketplace_account_bindings
  FOR EACH ROW EXECUTE FUNCTION rotamoto.sync_marketplace_account_route();

CREATE TABLE rotamoto.marketplace_event_inbox (
  company_id uuid NOT NULL,
  event_id uuid NOT NULL,
  external_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ifood','keeta')),
  external_event_id text NOT NULL CHECK (length(btrim(external_event_id)) BETWEEN 1 AND 160 AND external_event_id !~ '[[:cntrl:]]'),
  external_order_id text NOT NULL CHECK (length(btrim(external_order_id)) BETWEEN 1 AND 160 AND external_order_id !~ '[[:cntrl:]]'),
  event_type text NOT NULL CHECK (length(btrim(event_type)) BETWEEN 1 AND 128 AND event_type !~ '[[:cntrl:]]'),
  body_digest bytea NOT NULL CHECK (octet_length(body_digest)=32),
  event_data jsonb NOT NULL CHECK (jsonb_typeof(event_data)='object' AND event_data - ARRAY['id','orderId','eventType','status','occurredAt','externalStatus','code','fullCode','createdAt']::text[] = '{}'::jsonb),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processing','processed','retry','unmapped','rejected')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  FOREIGN KEY (external_account_id,company_id) REFERENCES rotamoto.external_accounts(id,company_id) ON DELETE RESTRICT,
  PRIMARY KEY(company_id,event_id),
  UNIQUE(provider,external_account_id,external_event_id),
  CHECK ((status IN ('processed','unmapped','rejected'))=(processed_at IS NOT NULL)),
  CHECK ((status='processing')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX marketplace_event_ready_idx ON rotamoto.marketplace_event_inbox(next_attempt_at,received_at) WHERE status IN ('received','retry');

CREATE TABLE rotamoto.marketplace_command_outbox (
  company_id uuid NOT NULL,
  command_id uuid NOT NULL,
  external_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ifood','keeta')),
  external_order_id text NOT NULL CHECK (length(btrim(external_order_id)) BETWEEN 1 AND 160 AND external_order_id !~ '[[:cntrl:]]'),
  operation text NOT NULL CHECK (operation IN ('CONFIRM','START_PREPARATION','READY','DISPATCH_MERCHANT','CANCEL_ORDER','SHIPPING_QUOTE','SHIPPING_REQUEST','SHIPPING_CANCEL','SHIPPING_TRACKING','RECONCILE')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 160 AND idempotency_key !~ '[[:cntrl:]]'),
  command_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(command_data)='object' AND command_data - ARRAY['reason','quoteId','orderExternalCode','createdAt','preparationTime','deliveryTrackingInfo']::text[] = '{}'::jsonb),
  retry_class text NOT NULL CHECK (retry_class IN ('safe_retry','idempotent','reconcile_before_retry','no_blind_retry')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','pending','succeeded','rejected','unknown_outcome','needs_review')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(company_id,command_id),
  UNIQUE(provider,external_account_id,operation,idempotency_key),
  FOREIGN KEY (external_account_id,company_id) REFERENCES rotamoto.external_accounts(id,company_id) ON DELETE RESTRICT,
  CHECK ((status='leased')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((status IN ('succeeded','rejected','unknown_outcome','needs_review'))=(completed_at IS NOT NULL)),
  CHECK (updated_at >= created_at)
);
CREATE INDEX marketplace_command_ready_idx ON rotamoto.marketplace_command_outbox(next_attempt_at,created_at) WHERE status='queued';

CREATE TABLE rotamoto.marketplace_order_versions (
  company_id uuid NOT NULL,
  external_account_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('ifood','keeta')),
  external_order_id text NOT NULL CHECK (length(btrim(external_order_id)) BETWEEN 1 AND 160),
  last_event_at timestamptz,
  last_event_id uuid,
  domain_order_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(provider,external_account_id,external_order_id),
  FOREIGN KEY (external_account_id,company_id) REFERENCES rotamoto.external_accounts(id,company_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,last_event_id) REFERENCES rotamoto.marketplace_event_inbox(company_id,event_id) ON DELETE RESTRICT,
  FOREIGN KEY (company_id,domain_order_id) REFERENCES rotamoto.domain_records(company_id,record_id) ON DELETE RESTRICT
);

DO $$ DECLARE t text; BEGIN
    FOREACH t IN ARRAY ARRAY['marketplace_oauth_states','marketplace_account_bindings','marketplace_event_inbox','marketplace_command_outbox','marketplace_order_versions'] LOOP
    EXECUTE format('ALTER TABLE rotamoto.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE rotamoto.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON rotamoto.%I USING (company_id=rotamoto.current_tenant_id()) WITH CHECK (company_id=rotamoto.current_tenant_id())',t);
  END LOOP;
END $$;

CREATE TABLE rotamoto.marketplace_oauth_secrets (
  state_digest bytea PRIMARY KEY REFERENCES rotamoto.marketplace_oauth_states(state_digest) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES rotamoto.companies(id) ON DELETE RESTRICT,
  secret_ref text NOT NULL CHECK (length(secret_ref) BETWEEN 1 AND 256 AND secret_ref !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rotamoto.marketplace_oauth_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.marketplace_oauth_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.marketplace_oauth_secrets
  USING(company_id=rotamoto.current_tenant_id()) WITH CHECK(company_id=rotamoto.current_tenant_id());
REVOKE ALL ON rotamoto.marketplace_oauth_secrets FROM PUBLIC,rotamoto_app;

GRANT SELECT (account_status,token_expires_at,last_sync_at,last_error_code,poll_next_at) ON rotamoto.external_accounts TO rotamoto_app;
GRANT UPDATE (account_status,last_sync_at,last_error_code,updated_at) ON rotamoto.external_accounts TO rotamoto_app;
GRANT SELECT,INSERT,UPDATE ON rotamoto.integrations TO rotamoto_app;
GRANT INSERT (id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,metadata)
  ON rotamoto.external_accounts TO rotamoto_app;
GRANT UPDATE (display_name,link_status,confirmed_at,metadata,account_status,last_error_code,updated_at)
  ON rotamoto.external_accounts TO rotamoto_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON rotamoto.marketplace_oauth_states TO rotamoto_app;
REVOKE ALL ON rotamoto.marketplace_account_bindings FROM PUBLIC,rotamoto_app;
GRANT SELECT ON rotamoto.marketplace_event_inbox,rotamoto.marketplace_command_outbox,rotamoto.marketplace_order_versions TO rotamoto_app;
GRANT SELECT,INSERT,UPDATE ON rotamoto.marketplace_command_outbox TO rotamoto_app;
GRANT SELECT,INSERT,UPDATE ON rotamoto.marketplace_event_inbox,rotamoto.marketplace_order_versions TO rotamoto_app;
REVOKE SELECT ON rotamoto.external_accounts FROM rotamoto_app;
GRANT SELECT (id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,metadata,created_at,updated_at,account_status,token_expires_at,last_sync_at,last_error_code) ON rotamoto.external_accounts TO rotamoto_app;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT USAGE ON SCHEMA rotamoto TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.marketplace_event_inbox TO rotamoto_provider_worker;
    GRANT UPDATE (status,processed_at,attempts,next_attempt_at,lease_token,lease_until,last_error_code) ON rotamoto.marketplace_event_inbox TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.marketplace_command_outbox TO rotamoto_provider_worker;
    GRANT UPDATE (status,attempts,next_attempt_at,lease_token,lease_until,last_error_code,updated_at,completed_at) ON rotamoto.marketplace_command_outbox TO rotamoto_provider_worker;
    GRANT SELECT,INSERT,UPDATE ON rotamoto.marketplace_order_versions TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.marketplace_account_bindings TO rotamoto_provider_worker;
    GRANT SELECT (id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,metadata,account_status,token_expires_at,last_sync_at,last_error_code,poll_next_at,poll_lease_token,poll_lease_until) ON rotamoto.external_accounts TO rotamoto_provider_worker;
    GRANT UPDATE (poll_next_at,poll_lease_token,poll_lease_until,last_sync_at,last_error_code,updated_at) ON rotamoto.external_accounts TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.integrations TO rotamoto_provider_worker;
    GRANT SELECT,INSERT,UPDATE ON rotamoto.domain_records TO rotamoto_provider_worker;
    GRANT SELECT,INSERT,UPDATE ON rotamoto.sync_installations TO rotamoto_provider_worker;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_resolver') THEN
    GRANT USAGE ON SCHEMA rotamoto TO rotamoto_provider_resolver;
    GRANT SELECT (id,company_id,integration_id,external_account_id,link_status,secret_ref,account_status) ON rotamoto.external_accounts TO rotamoto_provider_resolver;
    GRANT SELECT ON rotamoto.marketplace_oauth_secrets TO rotamoto_provider_resolver;
    GRANT SELECT,INSERT,UPDATE ON rotamoto.marketplace_oauth_secrets TO rotamoto_provider_resolver;
    GRANT SELECT,INSERT,UPDATE ON rotamoto.marketplace_account_bindings TO rotamoto_provider_resolver;
    GRANT SELECT ON rotamoto.marketplace_account_routes TO rotamoto_provider_resolver;
    GRANT SELECT ON rotamoto.integrations TO rotamoto_provider_resolver;
    GRANT INSERT (id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,metadata,secret_ref,account_status,token_expires_at,last_sync_at,last_error_code)
      ON rotamoto.external_accounts TO rotamoto_provider_resolver;
    GRANT UPDATE (secret_ref,account_status,token_expires_at,last_sync_at,last_error_code,updated_at)
      ON rotamoto.external_accounts TO rotamoto_provider_resolver;
  END IF;
END $$;

CREATE FUNCTION rotamoto.claim_marketplace_poll_account(p_company_id uuid,p_provider text,p_lease uuid,p_seconds integer DEFAULT 90)
RETURNS TABLE(company_id uuid,account_id uuid,provider text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  IF p_company_id IS NULL OR p_lease IS NULL OR p_provider NOT IN ('ifood','keeta') THEN RAISE EXCEPTION 'Poll claim context required'; END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  RETURN QUERY WITH candidate AS (
    SELECT a.id,a.company_id FROM rotamoto.external_accounts a
    JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id
    WHERE a.company_id=p_company_id AND a.account_status='active' AND a.link_status='confirmed' AND i.status='active'
      AND i.provider=p_provider AND a.poll_next_at<=now() AND (a.poll_lease_until IS NULL OR a.poll_lease_until<now())
      AND EXISTS(SELECT 1 FROM rotamoto.marketplace_account_bindings b WHERE b.company_id=a.company_id AND b.external_account_id=a.id AND b.authorized)
    ORDER BY a.poll_next_at,a.created_at FOR UPDATE OF a SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE rotamoto.external_accounts a SET poll_lease_token=p_lease,poll_lease_until=now()+make_interval(secs=>least(greatest(p_seconds,15),300))
      FROM candidate c WHERE a.id=c.id AND a.company_id=c.company_id
      RETURNING a.company_id,a.id,p_provider
  ) SELECT * FROM claimed;
END $$;
REVOKE ALL ON FUNCTION rotamoto.claim_marketplace_poll_account(uuid,text,uuid,integer) FROM PUBLIC,rotamoto_app;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_poll_account(uuid,text,uuid,integer) TO rotamoto_provider_worker;
  END IF;
END $$;

CREATE FUNCTION rotamoto.claim_marketplace_event(p_company_id uuid,p_lease uuid,p_seconds integer DEFAULT 90)
RETURNS TABLE(company_id uuid,event_id uuid,external_account_id uuid,provider text,external_event_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  IF p_company_id IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Event claim context required'; END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  RETURN QUERY WITH candidate AS (
    SELECT e.company_id,e.event_id FROM rotamoto.marketplace_event_inbox e
    JOIN rotamoto.external_accounts a ON a.id=e.external_account_id AND a.company_id=e.company_id
    JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id
    WHERE e.company_id=p_company_id AND e.provider IN ('ifood','keeta')
      AND a.account_status='active' AND a.link_status='confirmed' AND i.status='active'
      AND EXISTS(SELECT 1 FROM rotamoto.marketplace_account_bindings b WHERE b.company_id=a.company_id AND b.external_account_id=a.id AND b.authorized)
      AND ((e.status IN ('received','retry') AND e.next_attempt_at<=now()) OR (e.status='processing' AND e.lease_until<now()))
    ORDER BY e.next_attempt_at,e.received_at FOR UPDATE OF e SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE rotamoto.marketplace_event_inbox e SET status='processing',lease_token=p_lease,
      lease_until=now()+make_interval(secs=>least(greatest(p_seconds,15),300)),attempts=e.attempts+1
    FROM candidate c WHERE e.company_id=c.company_id AND e.event_id=c.event_id
    RETURNING e.company_id,e.event_id,e.external_account_id,e.provider,e.external_event_id
  ) SELECT * FROM claimed;
END $$;
REVOKE ALL ON FUNCTION rotamoto.claim_marketplace_event(uuid,uuid,integer) FROM PUBLIC,rotamoto_app;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_event(uuid,uuid,integer) TO rotamoto_provider_worker;
  END IF;
END $$;

CREATE FUNCTION rotamoto.claim_marketplace_command(p_company_id uuid,p_lease uuid,p_seconds integer DEFAULT 45)
RETURNS TABLE(company_id uuid,command_id uuid,external_account_id uuid,provider text,external_order_id text,operation text,idempotency_key text,command_data jsonb,retry_class text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  IF p_company_id IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Claim context required'; END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  RETURN QUERY WITH candidate AS (
    SELECT c.company_id,c.command_id FROM rotamoto.marketplace_command_outbox c
    JOIN rotamoto.external_accounts a ON a.id=c.external_account_id AND a.company_id=c.company_id
    JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id
    WHERE c.company_id=p_company_id AND a.account_status='active' AND a.link_status='confirmed' AND i.status='active'
      AND c.attempts<8 AND ((c.status='queued' AND c.next_attempt_at<=now()) OR (c.status='leased' AND c.lease_until<now()))
    ORDER BY c.next_attempt_at,c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE rotamoto.marketplace_command_outbox c SET status='leased',lease_token=p_lease,
      lease_until=now()+make_interval(secs=>least(greatest(p_seconds,10),120)),attempts=c.attempts+1,updated_at=now()
    FROM candidate q WHERE c.company_id=q.company_id AND c.command_id=q.command_id
    RETURNING c.company_id,c.command_id,c.external_account_id,c.provider,c.external_order_id,c.operation,c.idempotency_key,c.command_data,c.retry_class,c.attempts
  ) SELECT * FROM claimed;
END $$;
REVOKE ALL ON FUNCTION rotamoto.claim_marketplace_command(uuid,uuid,integer) FROM PUBLIC,rotamoto_app;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_command(uuid,uuid,integer) TO rotamoto_provider_worker;
  END IF;
END $$;


COMMENT ON TABLE rotamoto.marketplace_event_inbox IS 'Durable deduplicated marketplace order events. Event data is normalized and PII-free; raw payloads and credentials are never stored.';
COMMENT ON TABLE rotamoto.marketplace_command_outbox IS 'Durable marketplace lifecycle commands; 202 remains pending and ambiguous side effects are reconciled before retry.';
