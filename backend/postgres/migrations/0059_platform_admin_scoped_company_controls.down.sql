DO $$ BEGIN
  RAISE EXCEPTION 'rollback blocked: global company permission and financial audit controls are security-sensitive; use a reviewed forward migration';
END $$;
