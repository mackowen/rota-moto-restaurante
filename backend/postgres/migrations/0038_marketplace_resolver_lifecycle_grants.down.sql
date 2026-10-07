DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: restore verificado e rollback operacional controlado necessários para preservar account lifecycle e outbox';
END $$;
