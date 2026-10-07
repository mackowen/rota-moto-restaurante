DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: restaure recovery set verificado e faça rollback operacional controlado para preservar o boundary de secrets do marketplace';
END $$;
