DO $$ BEGIN
  RAISE EXCEPTION 'Rollback 0043 blocked: command rows and webhook application metadata must be reviewed before changing provider constraints.';
END $$;
