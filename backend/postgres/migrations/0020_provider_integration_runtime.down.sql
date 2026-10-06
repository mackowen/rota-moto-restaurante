DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: provider quotes, commands and events are operational records and must be preserved';
END $$;
