SET LOCAL row_security = off;

DO $$
DECLARE table_name text;
DECLARE row_count bigint;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users','credentials','recovery_tokens','companies','permissions','roles',
    'role_permissions','memberships','sessions','integrations','external_accounts',
    'local_id_maps','audit_log','sync_inbox','sync_outbox'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM rotamoto.%I', table_name) INTO row_count;
    IF row_count > 0 THEN
      RAISE EXCEPTION 'rollback bloqueado: rotamoto.% contém dados', table_name;
    END IF;
  END LOOP;
END $$;

DROP TABLE rotamoto.sync_outbox;
DROP TABLE rotamoto.sync_inbox;
DROP TABLE rotamoto.audit_log;
DROP TABLE rotamoto.local_id_maps;
DROP TABLE rotamoto.external_accounts;
DROP TABLE rotamoto.integrations;
DROP TABLE rotamoto.sessions;
DROP TABLE rotamoto.memberships;
DROP TABLE rotamoto.role_permissions;
DROP TABLE rotamoto.roles;
DROP TABLE rotamoto.permissions;
DROP TABLE rotamoto.recovery_tokens;
DROP TABLE rotamoto.credentials;
DROP TABLE rotamoto.users;
DROP TABLE rotamoto.companies;
DROP FUNCTION rotamoto.guard_audit_log_immutable();
DROP FUNCTION rotamoto.current_tenant_id();
