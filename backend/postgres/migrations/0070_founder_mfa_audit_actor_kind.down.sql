DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.platform_admin_audit_log WHERE actor_kind='user') THEN
    RAISE EXCEPTION 'cannot remove founder MFA audit actor support while user audit rows exist';
  END IF;
END $$;
ALTER TABLE rotamoto.platform_admin_audit_log
  DROP CONSTRAINT IF EXISTS platform_admin_audit_log_actor_kind_check;
ALTER TABLE rotamoto.platform_admin_audit_log
  ADD CONSTRAINT platform_admin_audit_log_actor_kind_check
  CHECK (actor_kind IN ('platform_admin','local_operator'));
