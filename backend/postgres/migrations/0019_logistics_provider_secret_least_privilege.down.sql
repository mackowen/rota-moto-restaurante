DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: restaurar SELECT de tabela reexporia secret_ref ao runtime';
END $$;
