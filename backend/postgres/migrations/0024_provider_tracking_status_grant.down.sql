DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: o worker precisa persistir status normalizado de tracking';
END $$;
