DROP FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer);
CREATE FUNCTION rotamoto.claim_provider_command(p_company_id uuid,p_lease uuid,p_seconds integer DEFAULT 45)
RETURNS TABLE(company_id uuid,command_id uuid,provider_id uuid,delivery_id uuid,fulfillment_id uuid,operation text,idempotency_key text,payload jsonb,attempts integer,correlation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
BEGIN
  IF p_company_id IS NULL OR p_lease IS NULL THEN RAISE EXCEPTION 'Claim context required'; END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  UPDATE rotamoto.provider_command_outbox o SET status=CASE WHEN o.operation IN ('DISPATCH_REQUEST','CANCEL_REQUEST') THEN 'unknown_outcome' ELSE 'needs_review' END,
    lease_token=NULL,lease_until=NULL,last_error_class='UNKNOWN_OUTCOME',completed_at=now(),updated_at=now()
    WHERE o.company_id=p_company_id AND o.status='leased' AND o.lease_until<now()
      AND (o.operation IN ('DISPATCH_REQUEST','CANCEL_REQUEST') OR o.attempts>=8);
  RETURN QUERY WITH candidate AS (
    SELECT o.company_id,o.command_id FROM rotamoto.provider_command_outbox o
    JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
    WHERE o.company_id=p_company_id AND p.enabled AND p.api_enabled AND p.integration_mode='api'
      AND o.attempts<8 AND ((o.status='queued' AND o.next_attempt_at<=now()) OR
        (o.status='leased' AND o.lease_until<now() AND o.operation NOT IN ('DISPATCH_REQUEST','CANCEL_REQUEST')))
    ORDER BY o.next_attempt_at,o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1
  ), claimed AS (
    UPDATE rotamoto.provider_command_outbox o SET status='leased',lease_token=p_lease,lease_until=now()+make_interval(secs=>least(greatest(p_seconds,10),120)),attempts=o.attempts+1,updated_at=now()
    FROM candidate c WHERE o.company_id=c.company_id AND o.command_id=c.command_id
    RETURNING o.company_id,o.command_id,o.provider_id,o.delivery_id,o.fulfillment_id,o.operation,o.idempotency_key,o.payload,o.attempts,o.correlation_id
  ) SELECT * FROM claimed;
END $$;
REVOKE ALL ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.claim_provider_command(uuid,uuid,integer) TO rotamoto_app;
