ALTER TABLE rotamoto.logistics_decisions
  DROP CONSTRAINT logistics_decisions_check;
ALTER TABLE rotamoto.logistics_decisions
  ADD CONSTRAINT logistics_decisions_decision_actor_state_check CHECK (
    (status='proposed' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status='stale' AND ((decided_by IS NULL AND decided_at IS NULL) OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)))
    OR (status IN ('approved','rejected','execution_requested','executed','failed','unknown_outcome')
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  );
