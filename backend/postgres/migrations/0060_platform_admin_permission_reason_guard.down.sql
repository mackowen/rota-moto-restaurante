DO $$ BEGIN
  RAISE EXCEPTION 'rollback blocked: permission audit validation is security-sensitive; use a reviewed forward migration';
END $$;
