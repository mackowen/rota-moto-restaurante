DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: snapshots geográficos exigem decisão operacional e preservação auditável antes de remoção';
END $$;
