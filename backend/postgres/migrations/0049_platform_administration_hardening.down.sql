DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.platform_administrators) OR
     EXISTS (SELECT 1 FROM rotamoto.platform_admin_audit_log) OR
     EXISTS (SELECT 1 FROM rotamoto.platform_admin_bootstrap_latch WHERE claimed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback blocked: platform administration history exists; use a reviewed forward migration';
  END IF;
  RAISE EXCEPTION 'rollback 0049 blocked: corrected security-definer functions are retained as the safe platform-admin contract';
END;
$rollback$;
