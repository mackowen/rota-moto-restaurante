DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: restoring an unscoped provider claim would violate tenant isolation';
END $$;
