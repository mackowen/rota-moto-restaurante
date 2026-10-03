DO $$
BEGIN
  RAISE EXCEPTION 'rollback bloqueado: domain_records e sync_installations podem conter dados canônicos; migração forward-only';
END;
$$;
