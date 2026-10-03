DO $$
BEGIN
  RAISE EXCEPTION 'rollback bloqueado: eventId canônico já pode ter sido consumido por múltiplas instalações';
END;
$$;
