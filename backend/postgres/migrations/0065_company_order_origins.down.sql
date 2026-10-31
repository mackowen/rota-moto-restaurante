DO $$ BEGIN
  RAISE EXCEPTION 'Rollback 0065 is blocked because order-origin settings may already be in use.';
END $$;
