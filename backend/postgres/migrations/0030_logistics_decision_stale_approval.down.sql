DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: pode haver decisões stale com aprovação humana persistida';
END $$;
