DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: reabriria claim global de comandos externos para rotamoto_app';
END $$;
