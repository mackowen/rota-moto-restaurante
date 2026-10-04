DO $$
BEGIN
  RAISE EXCEPTION 'rollback bloqueado: instalações e recibos podem conter identidade de sync usada pelo domínio';
END;
$$;
