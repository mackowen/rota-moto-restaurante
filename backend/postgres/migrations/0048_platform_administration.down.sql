DO $rollback$
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.platform_administrators) OR
     EXISTS (SELECT 1 FROM rotamoto.platform_admin_audit_log) OR
     EXISTS (SELECT 1 FROM rotamoto.platform_admin_bootstrap_latch WHERE claimed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback blocked: platform administration history exists; use a reviewed forward migration';
  END IF;
END;
$rollback$;
DROP FUNCTION rotamoto.platform_admin_set_user_disabled(uuid,boolean,text);
DROP FUNCTION rotamoto.platform_admin_set_company_status(uuid,text,text);
DROP FUNCTION rotamoto.platform_admin_bootstrap_founder(text);
DROP FUNCTION rotamoto.platform_admin_list_memberships();
DROP FUNCTION rotamoto.platform_admin_list_users();
DROP FUNCTION rotamoto.platform_admin_list_companies();
DROP FUNCTION rotamoto.platform_admin_context_is_active();
DROP POLICY platform_admin_read_memberships ON rotamoto.memberships;
DROP POLICY platform_admin_update_companies ON rotamoto.companies;
DROP POLICY platform_admin_read_companies ON rotamoto.companies;
DROP TRIGGER platform_admin_audit_immutable ON rotamoto.platform_admin_audit_log;
DROP TABLE rotamoto.platform_admin_audit_log;
DROP TABLE rotamoto.platform_administrators;
DROP TABLE rotamoto.platform_admin_bootstrap_latch;
