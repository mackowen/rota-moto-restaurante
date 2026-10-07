ALTER TABLE rotamoto.marketplace_oauth_states
  ADD COLUMN onboarding_status text NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN ('pending','merchant_lookup','complete','failed')),
  ADD COLUMN onboarding_attempts integer NOT NULL DEFAULT 0 CHECK (onboarding_attempts>=0),
  ADD COLUMN onboarding_next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX marketplace_oauth_onboarding_idx ON rotamoto.marketplace_oauth_states(onboarding_next_attempt_at)
  WHERE provider='ifood' AND consumed_at IS NOT NULL AND onboarding_status='merchant_lookup';

ALTER TABLE rotamoto.marketplace_command_outbox
  ADD COLUMN result_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_data)='object');
ALTER TABLE rotamoto.marketplace_command_outbox DROP CONSTRAINT marketplace_command_outbox_command_data_check;
ALTER TABLE rotamoto.marketplace_command_outbox ADD CONSTRAINT marketplace_command_outbox_command_data_check
  CHECK (jsonb_typeof(command_data)='object' AND command_data - ARRAY['reason','quoteId','orderExternalCode','createdAt','preparationTime',
    'deliveryTrackingInfo','code','mode','outOfStockItems','invalidItems']::text[] = '{}'::jsonb);
ALTER TABLE rotamoto.marketplace_event_inbox DROP CONSTRAINT marketplace_event_inbox_event_data_check;
ALTER TABLE rotamoto.marketplace_event_inbox ADD CONSTRAINT marketplace_event_inbox_event_data_check
  CHECK (jsonb_typeof(event_data)='object' AND event_data - ARRAY['id','orderId','eventType','status','occurredAt','externalStatus','code','fullCode','createdAt','kind']::text[] = '{}'::jsonb);

CREATE TABLE rotamoto.marketplace_authorization_events (
  company_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider='keeta'),
  external_account_id uuid NOT NULL,
  event_key text NOT NULL CHECK(length(event_key)=64 AND event_key ~ '^[a-f0-9]{64}$'),
  body_digest bytea NOT NULL CHECK(octet_length(body_digest)=32),
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(company_id,provider,event_key),
  FOREIGN KEY(external_account_id,company_id) REFERENCES rotamoto.external_accounts(id,company_id) ON DELETE RESTRICT
);
ALTER TABLE rotamoto.marketplace_authorization_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.marketplace_authorization_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rotamoto.marketplace_authorization_events
  USING(company_id=rotamoto.current_tenant_id()) WITH CHECK(company_id=rotamoto.current_tenant_id());
REVOKE ALL ON rotamoto.marketplace_authorization_events FROM PUBLIC,rotamoto_app;

DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_resolver') THEN
    GRANT SELECT,INSERT ON rotamoto.marketplace_authorization_events TO rotamoto_provider_resolver;
    GRANT UPDATE(account_status,last_error_code,updated_at) ON rotamoto.external_accounts TO rotamoto_provider_resolver;
    GRANT UPDATE(authorized,updated_at) ON rotamoto.marketplace_account_bindings TO rotamoto_provider_resolver;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT SELECT,UPDATE ON rotamoto.marketplace_oauth_states TO rotamoto_provider_worker;
    GRANT SELECT ON rotamoto.marketplace_oauth_secrets TO rotamoto_provider_worker;
    GRANT UPDATE(result_data) ON rotamoto.marketplace_command_outbox TO rotamoto_provider_worker;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rotamoto.claim_marketplace_command(p_company_id uuid,p_lease uuid,p_seconds integer DEFAULT 45)
RETURNS TABLE(company_id uuid,command_id uuid,external_account_id uuid,provider text,external_order_id text,operation text,idempotency_key text,command_data jsonb,retry_class text,attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  IF p_company_id IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Claim context required'; END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  UPDATE rotamoto.marketplace_command_outbox c SET status='unknown_outcome',lease_token=NULL,lease_until=NULL,
    completed_at=now(),last_error_code='WORKER_LEASE_EXPIRED',updated_at=now()
    WHERE c.company_id=p_company_id AND c.status='leased' AND c.lease_until<now()
      AND c.retry_class IN ('reconcile_before_retry','no_blind_retry')
      AND c.operation NOT IN ('SHIPPING_QUOTE','SHIPPING_TRACKING');
  RETURN QUERY WITH candidate AS (
    SELECT c.company_id,c.command_id FROM rotamoto.marketplace_command_outbox c
    JOIN rotamoto.external_accounts a ON a.id=c.external_account_id AND a.company_id=c.company_id
    JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id
    WHERE c.company_id=p_company_id AND a.account_status='active' AND a.link_status='confirmed' AND i.status='active'
      AND c.attempts<8 AND ((c.status='queued' AND c.next_attempt_at<=now()) OR
        (c.status='leased' AND c.lease_until<now() AND c.retry_class IN ('safe_retry','idempotent')))
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
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_command(uuid,uuid,integer) TO rotamoto_provider_worker;
  END IF;
END $$;

COMMENT ON TABLE rotamoto.marketplace_authorization_events IS 'Idempotency records for signed Keeta authorization revocation callbacks; raw payload is never retained.';
