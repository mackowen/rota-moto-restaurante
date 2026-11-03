-- The protected first-founder completion function records the authenticated
-- owner as the actor only after password acceptance and confirmed MFA.
ALTER TABLE rotamoto.platform_admin_audit_log
  DROP CONSTRAINT IF EXISTS platform_admin_audit_log_actor_kind_check;
ALTER TABLE rotamoto.platform_admin_audit_log
  ADD CONSTRAINT platform_admin_audit_log_actor_kind_check
  CHECK (actor_kind IN ('platform_admin','local_operator','user'));
