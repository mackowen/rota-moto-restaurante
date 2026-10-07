DO $$ BEGIN
  RAISE EXCEPTION 'rollback bloqueado: marketplace runtime pode conter pedidos e comandos já observados; restaure recovery set verificado e faça rollback operacional controlado';
END $$;
