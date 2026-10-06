DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: restaurar SELECT da tabela external_accounts reexporia secret_ref ao runtime';
END $$;
