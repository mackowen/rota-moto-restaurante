DO $$ BEGIN
  RAISE EXCEPTION 'rollback blocked: founder-bootstrap semantics are security-sensitive; use a reviewed forward migration';
END $$;
