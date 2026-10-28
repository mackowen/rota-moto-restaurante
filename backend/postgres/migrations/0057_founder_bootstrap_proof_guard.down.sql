DO $$ BEGIN
  RAISE EXCEPTION 'rollback blocked: founder-bootstrap proof guard is security-sensitive; use a reviewed forward migration';
END $$;
