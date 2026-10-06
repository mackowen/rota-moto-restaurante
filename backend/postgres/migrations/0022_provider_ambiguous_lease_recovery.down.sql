DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: the earlier provider lease policy could blindly repeat an ambiguous dispatch or cancellation';
END $$;
