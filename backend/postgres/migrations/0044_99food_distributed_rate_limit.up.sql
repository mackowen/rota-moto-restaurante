-- Shared 99Food Protocol (Recommended) throttling across API and worker processes.
-- The table contains only opaque SHA-256 keys and throttle timestamps.
CREATE TABLE rotamoto.marketplace_99food_rate_limits (
  scope_kind text NOT NULL CHECK (scope_kind IN ('application','store')),
  scope_hash bytea NOT NULL CHECK (octet_length(scope_hash)=32),
  operation text NOT NULL CHECK (operation IN ('order_detail','order_command','token_get','token_refresh')),
  next_allowed_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_kind,scope_hash,operation)
);
CREATE INDEX marketplace_99food_rate_limits_expiry_idx
  ON rotamoto.marketplace_99food_rate_limits (next_allowed_at);
ALTER TABLE rotamoto.marketplace_99food_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE rotamoto.marketplace_99food_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY marketplace_99food_rate_limits_owner_policy
  ON rotamoto.marketplace_99food_rate_limits TO rotamoto_migrator
  USING (true) WITH CHECK (true);
REVOKE ALL ON TABLE rotamoto.marketplace_99food_rate_limits FROM PUBLIC,rotamoto_app,rotamoto_provider_worker;

CREATE FUNCTION rotamoto.consume_99food_rate_limit(
  p_company_id uuid,p_account_id uuid,p_application_hash bytea,p_store_hash bytea,p_operation text
) RETURNS TABLE (allowed boolean,retry_after_ms integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,rotamoto AS $$
DECLARE
  now_at timestamptz := clock_timestamp();
  interval_ms integer;
  app_next timestamptz;
  store_next timestamptz;
  wait_ms integer;
BEGIN
  IF p_company_id IS NULL OR p_application_hash IS NULL OR octet_length(p_application_hash)<>32 OR
     p_store_hash IS NULL OR octet_length(p_store_hash)<>32 OR
     p_operation NOT IN ('order_detail','order_command','token_get','token_refresh') THEN
    RAISE EXCEPTION 'Invalid 99Food rate limit context' USING ERRCODE='22023';
  END IF;
  IF p_operation NOT IN ('token_get','token_refresh') AND p_account_id IS NULL THEN
    RAISE EXCEPTION '99Food order rate limit requires an account' USING ERRCODE='22023';
  END IF;
  PERFORM set_config('app.tenant_id',p_company_id::text,true);
  IF p_account_id IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM rotamoto.integrations i WHERE i.company_id=p_company_id AND i.provider='99food') THEN
      RAISE EXCEPTION '99Food integration context unavailable' USING ERRCODE='42501';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM rotamoto.external_accounts a
    JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id
    JOIN rotamoto.marketplace_account_bindings b ON b.company_id=a.company_id AND b.integration_id=a.integration_id AND b.external_account_id=a.id
    WHERE a.company_id=p_company_id AND a.id=p_account_id AND a.account_status='active' AND a.link_status='confirmed'
      AND i.provider='99food' AND i.status='active' AND b.provider='99food' AND b.authorized
  ) THEN
    RAISE EXCEPTION '99Food account context unavailable' USING ERRCODE='42501';
  END IF;

  interval_ms := CASE p_operation
    WHEN 'order_detail' THEN 1000       -- 10 details per 10 seconds
    WHEN 'order_command' THEN 200       -- 5 order commands per second
    WHEN 'token_get' THEN 30000         -- one token retrieval per 30 seconds
    WHEN 'token_refresh' THEN 30000     -- one token refresh per 30 seconds
  END;

  INSERT INTO rotamoto.marketplace_99food_rate_limits(scope_kind,scope_hash,operation,next_allowed_at)
  VALUES ('application',p_application_hash,p_operation,now_at),('store',p_store_hash,p_operation,now_at)
  ON CONFLICT (scope_kind,scope_hash,operation) DO NOTHING;
  -- Lock both scopes in stable order so different stores sharing one app key
  -- serialize on the application bucket without deadlocks.
  SELECT r.next_allowed_at INTO app_next FROM rotamoto.marketplace_99food_rate_limits r
    WHERE r.scope_kind='application' AND r.scope_hash=p_application_hash AND r.operation=p_operation FOR UPDATE;
  SELECT r.next_allowed_at INTO store_next FROM rotamoto.marketplace_99food_rate_limits r
    WHERE r.scope_kind='store' AND r.scope_hash=p_store_hash AND r.operation=p_operation FOR UPDATE;
  wait_ms := GREATEST(0,ceil(EXTRACT(epoch FROM GREATEST(app_next,store_next)-now_at)*1000)::integer);
  IF wait_ms>0 THEN
    RETURN QUERY SELECT false,LEAST(wait_ms,2147483647);
    RETURN;
  END IF;
  UPDATE rotamoto.marketplace_99food_rate_limits SET next_allowed_at=now_at+(interval_ms*interval '1 millisecond'),updated_at=now_at
    WHERE scope_kind='application' AND scope_hash=p_application_hash AND operation=p_operation;
  UPDATE rotamoto.marketplace_99food_rate_limits SET next_allowed_at=now_at+(interval_ms*interval '1 millisecond'),updated_at=now_at
    WHERE scope_kind='store' AND scope_hash=p_store_hash AND operation=p_operation;
  RETURN QUERY SELECT true,0;
END $$;
REVOKE ALL ON FUNCTION rotamoto.consume_99food_rate_limit(uuid,uuid,bytea,bytea,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotamoto.consume_99food_rate_limit(uuid,uuid,bytea,bytea,text) TO rotamoto_app,rotamoto_provider_worker;
COMMENT ON TABLE rotamoto.marketplace_99food_rate_limits IS
  'Cross-process 99Food Protocol rate gates. Opaque application/store hashes only; rows are operational throttling metadata, not tenant or credential data.';
