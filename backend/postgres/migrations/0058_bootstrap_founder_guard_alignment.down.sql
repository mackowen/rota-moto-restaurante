DO $$ BEGIN
  RAISE EXCEPTION 'rollback blocked: bootstrap founder guard alignment is security-sensitive; use a reviewed forward migration';
END $$;
