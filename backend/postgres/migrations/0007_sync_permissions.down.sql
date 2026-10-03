DO $$
BEGIN
  RAISE EXCEPTION 'rollback bloqueado: a API e o provisionamento já dependem das permission keys de sync';
END;
$$;
