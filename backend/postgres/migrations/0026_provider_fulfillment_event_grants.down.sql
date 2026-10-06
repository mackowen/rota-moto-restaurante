DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: remover projeção de eventos poderia deixar status externo divergente';
END $$;
