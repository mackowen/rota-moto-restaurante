-- Add 99Food Protocol (Recommended) support to the existing tenant-scoped
-- marketplace runtime. This does not enable polling: that belongs to Open Delivery.
ALTER TABLE rotamoto.marketplace_account_bindings
  DROP CONSTRAINT marketplace_account_bindings_provider_check,
  ADD CONSTRAINT marketplace_account_bindings_provider_check CHECK (provider IN ('ifood','keeta','99food'));
ALTER TABLE rotamoto.marketplace_account_routes
  DROP CONSTRAINT marketplace_account_routes_provider_check,
  ADD CONSTRAINT marketplace_account_routes_provider_check CHECK (provider IN ('ifood','keeta','99food'));
ALTER TABLE rotamoto.marketplace_event_inbox
  DROP CONSTRAINT marketplace_event_inbox_provider_check,
  ADD CONSTRAINT marketplace_event_inbox_provider_check CHECK (provider IN ('ifood','keeta','99food'));
ALTER TABLE rotamoto.marketplace_command_outbox
  DROP CONSTRAINT marketplace_command_outbox_provider_check,
  ADD CONSTRAINT marketplace_command_outbox_provider_check CHECK (provider IN ('ifood','keeta','99food')),
  DROP CONSTRAINT marketplace_command_outbox_operation_check,
  ADD CONSTRAINT marketplace_command_outbox_operation_check CHECK (operation IN
    ('CONFIRM','START_PREPARATION','READY','DISPATCH_MERCHANT','CANCEL_ORDER','SHIPPING_QUOTE','SHIPPING_REQUEST',
     'SHIPPING_CANCEL','SHIPPING_TRACKING','RECONCILE','CANCEL_REQUEST','REFUND_REQUEST','DELIVERED')),
  DROP CONSTRAINT marketplace_command_outbox_command_data_check,
  ADD CONSTRAINT marketplace_command_outbox_command_data_check CHECK (jsonb_typeof(command_data)='object' AND
    command_data - ARRAY['reason','quoteId','orderExternalCode','createdAt','preparationTime','deliveryTrackingInfo','code','mode',
      'outOfStockItems','invalidItems','reasonId','applyId','agree','baseReasonId','baseReason','customReason','deliveryType']::text[] = '{}'::jsonb);
ALTER TABLE rotamoto.marketplace_order_versions
  DROP CONSTRAINT marketplace_order_versions_provider_check,
  ADD CONSTRAINT marketplace_order_versions_provider_check CHECK (provider IN ('ifood','keeta','99food'));

ALTER TABLE rotamoto.external_accounts
  ADD COLUMN provider_token_lease_token uuid,
  ADD COLUMN provider_token_lease_until timestamptz,
  ADD CONSTRAINT external_accounts_provider_token_lease_check
    CHECK ((provider_token_lease_token IS NULL)=(provider_token_lease_until IS NULL));

CREATE FUNCTION rotamoto.claim_marketplace_99food_token_refresh(p_company_id uuid,p_account_id uuid,p_lease uuid,p_seconds integer DEFAULT 45)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
DECLARE affected integer;
BEGIN
  IF p_company_id IS NULL OR p_account_id IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Token refresh context required'; END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  UPDATE rotamoto.external_accounts a SET provider_token_lease_token=p_lease,
    -- Refresh+token retrieval has a documented 120 second provider cooldown.
    provider_token_lease_until=now()+make_interval(secs=>least(greatest(p_seconds,15),150))
  FROM rotamoto.integrations i
  WHERE a.company_id=p_company_id AND a.id=p_account_id AND a.integration_id=i.id AND i.company_id=a.company_id
    AND i.provider='99food' AND i.status='active' AND a.account_status='active' AND a.link_status='confirmed'
    AND (a.provider_token_lease_until IS NULL OR a.provider_token_lease_until<now())
    AND EXISTS(SELECT 1 FROM rotamoto.marketplace_account_bindings b WHERE b.company_id=a.company_id
      AND b.external_account_id=a.id AND b.provider='99food' AND b.authorized);
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected=1;
END $$;
REVOKE ALL ON FUNCTION rotamoto.claim_marketplace_99food_token_refresh(uuid,uuid,uuid,integer) FROM PUBLIC,rotamoto_app;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT UPDATE(provider_token_lease_token,provider_token_lease_until) ON rotamoto.external_accounts TO rotamoto_provider_worker;
    GRANT EXECUTE ON FUNCTION rotamoto.claim_marketplace_99food_token_refresh(uuid,uuid,uuid,integer) TO rotamoto_provider_worker;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION rotamoto.claim_marketplace_event(p_company_id uuid,p_lease uuid,p_seconds integer DEFAULT 90)
RETURNS TABLE(company_id uuid,event_id uuid,external_account_id uuid,provider text,external_event_id text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  IF p_company_id IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Event claim context required'; END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  RETURN QUERY WITH candidate AS (
    SELECT e.company_id,e.event_id FROM rotamoto.marketplace_event_inbox e
    JOIN rotamoto.external_accounts a ON a.id=e.external_account_id AND a.company_id=e.company_id
    JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id
    WHERE e.company_id=p_company_id AND e.provider IN ('ifood','keeta','99food')
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

COMMENT ON TABLE rotamoto.marketplace_event_inbox IS
  'Durable deduplicated iFood, Keeta and 99Food Recommended Protocol order events. Normalized PII-free data only; no raw webhook bodies or credentials.';
