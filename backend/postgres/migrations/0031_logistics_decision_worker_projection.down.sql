DO $$
BEGIN
  RAISE EXCEPTION 'rollback bloqueado: projeções de execução aprovadas precisam preservar o histórico de decisões';
END $$;
