DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT SELECT ON rotamoto.provider_event_inbox TO rotamoto_provider_worker;
    GRANT UPDATE (status,processed_at) ON rotamoto.provider_event_inbox TO rotamoto_provider_worker;
    GRANT UPDATE (last_event_id) ON rotamoto.provider_tracking_snapshots TO rotamoto_provider_worker;
  END IF;
END $$;
COMMENT ON TABLE rotamoto.provider_event_inbox IS
  'Sanitized normalized provider events; raw body is never persisted, event ID and digest enforce idempotent ingress.';
