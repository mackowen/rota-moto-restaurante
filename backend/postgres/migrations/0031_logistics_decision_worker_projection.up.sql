ALTER TABLE rotamoto.logistics_decisions
  DROP CONSTRAINT logistics_decisions_status_check;
ALTER TABLE rotamoto.logistics_decisions
  ADD CONSTRAINT logistics_decisions_status_check CHECK (status IN
    ('proposed','approved','rejected','stale','execution_requested','executed','failed','unknown_outcome','cancelled'));
ALTER TABLE rotamoto.logistics_decisions
  DROP CONSTRAINT logistics_decisions_decision_actor_state_check;
ALTER TABLE rotamoto.logistics_decisions
  ADD CONSTRAINT logistics_decisions_decision_actor_state_check CHECK (
    (status='proposed' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status='stale' AND ((decided_by IS NULL AND decided_at IS NULL) OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)))
    OR (status IN ('approved','rejected','execution_requested','executed','failed','unknown_outcome','cancelled')
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  );
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') THEN
    GRANT SELECT (company_id,decision_id,delivery_id,status,execution_result,version)
      ON rotamoto.logistics_decisions TO rotamoto_provider_worker;
    GRANT UPDATE (status,version,updated_at)
      ON rotamoto.logistics_decisions TO rotamoto_provider_worker;
  END IF;
END $$;
