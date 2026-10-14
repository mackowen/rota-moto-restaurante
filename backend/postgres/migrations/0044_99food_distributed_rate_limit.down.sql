-- rollback bloqueado: accumulated cross-process throttle state must
-- not be discarded by an automated rollback. Disable the feature in code and
-- retire this table only through a separately reviewed migration.
DO $$ BEGIN
  RAISE EXCEPTION 'Migration 0044 is non-destructive and has no automatic down operation';
END $$;
