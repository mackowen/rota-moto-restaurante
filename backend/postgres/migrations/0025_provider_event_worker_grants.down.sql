DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: o processamento assíncrono de eventos depende desses grants mínimos';
END $$;
