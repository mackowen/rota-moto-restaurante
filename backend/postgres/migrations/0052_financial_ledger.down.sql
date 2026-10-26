DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.financial_events) THEN
    RAISE EXCEPTION 'rollback bloqueado: financial_events contém trilha financeira imutável';
  END IF;
END $$;
DROP TRIGGER IF EXISTS financial_events_immutable ON rotamoto.financial_events;
DROP FUNCTION IF EXISTS rotamoto.guard_financial_event_immutable();
DROP TABLE IF EXISTS rotamoto.financial_events;
DELETE FROM rotamoto.role_permissions WHERE catalog_version=1 AND permission_key IN ('finance.read','finance.manage');
DELETE FROM rotamoto.permissions WHERE catalog_version=1 AND permission_key IN ('finance.read','finance.manage');
