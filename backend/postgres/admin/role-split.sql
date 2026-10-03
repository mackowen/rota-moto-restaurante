-- Preparação administrativa para separar DBA, migrator e runtime.
-- NÃO contém senha e NÃO deve ser executado pelo backend ou por rotamoto_app.
-- Execute somente após cumprir o checklist em role-split-runbook.md.
\set ON_ERROR_STOP on

\if :{?checkpoint_confirmed}
\if :checkpoint_confirmed
\else
\echo 'Abortado: confirme checkpoint completo com -v checkpoint_confirmed=on.'
\quit 3
\endif
\else
\echo 'Abortado: confirme checkpoint completo com -v checkpoint_confirmed=on.'
\quit 3
\endif

DO $preflight$
DECLARE
  app_oid oid;
  migrator_oid oid;
  tenant_rls_count integer;
BEGIN
  IF session_user <> 'u0_a436' OR current_user <> 'u0_a436'
     OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'Execute como a sessão superuser local u0_a436; nenhuma alteração aplicada.';
  END IF;
  IF current_database() <> 'rotamoto' THEN
    RAISE EXCEPTION 'Database incorreto: esperado rotamoto; nenhuma alteração aplicada.';
  END IF;

  SELECT oid INTO app_oid FROM pg_roles WHERE rolname = 'rotamoto_app';
  SELECT oid INTO migrator_oid FROM pg_roles WHERE rolname = 'rotamoto_migrator';
  IF app_oid IS NULL THEN
    RAISE EXCEPTION 'Role rotamoto_app ausente; nenhuma alteração aplicada.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='rotamoto'
                 AND datdba IN (app_oid, (SELECT oid FROM pg_roles WHERE rolname='u0_a436'))) THEN
    RAISE EXCEPTION 'Owner inesperado do database; revise antes de executar.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='rotamoto'
                 AND nspowner IN (app_oid, COALESCE(migrator_oid, app_oid))) THEN
    RAISE EXCEPTION 'Owner inesperado do schema rotamoto; revise antes de executar.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','v','m','f','S')
      AND c.relowner NOT IN (app_oid, COALESCE(migrator_oid, app_oid))
  ) THEN
    RAISE EXCEPTION 'Há tabela/view/sequence de owner inesperado em rotamoto; nenhuma transferência parcial permitida.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='rotamoto' AND p.proowner NOT IN (app_oid, COALESCE(migrator_oid, app_oid))
  ) THEN
    RAISE EXCEPTION 'Há rotina de owner inesperado em rotamoto; revise antes de executar.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='rotamoto' AND t.typrelid=0 AND t.typtype IN ('c','d','e','r','m')
      AND t.typowner NOT IN (app_oid, COALESCE(migrator_oid, app_oid))
  ) THEN
    RAISE EXCEPTION 'Há tipo independente de owner inesperado em rotamoto; revise antes de executar.';
  END IF;

  SELECT count(*) INTO tenant_rls_count
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') AND c.relrowsecurity;
  IF tenant_rls_count <> 10 OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p')
      AND c.relrowsecurity AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Conjunto RLS diverge do esperado (10 tabelas tenant-scoped, todas FORCE); pare e investigue.';
  END IF;
  IF (SELECT count(*) FROM pg_roles
      WHERE rolcanlogin AND rolname NOT IN ('u0_a436','rotamoto_app','rotamoto_migrator')) <> 0 THEN
    RAISE EXCEPTION 'Existe outro login PostgreSQL; não revogue CONNECT/TEMP de PUBLIC sem revisar consumidores.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE member IN (app_oid, COALESCE(migrator_oid, app_oid))
       OR roleid IN (app_oid, COALESCE(migrator_oid, app_oid))
  ) THEN
    RAISE EXCEPTION 'Há membership envolvendo runtime/migrator; revise grants herdados antes de prosseguir.';
  END IF;
END;
$preflight$;

-- CREATE ROLE não recebe PASSWORD: defina-o depois com o meta-comando psql \password.
DO $create_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rotamoto_migrator') THEN
    CREATE ROLE rotamoto_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$create_role$;

ALTER ROLE rotamoto_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE rotamoto_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS;

-- PostgreSQL não permite ALTER DATABASE OWNER dentro de BEGIN/COMMIT.
-- O database fica sob o DBA de emergência; migrator recebe CREATE limitado ao database.
ALTER DATABASE rotamoto OWNER TO u0_a436;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

GRANT CONNECT, CREATE, TEMPORARY ON DATABASE rotamoto TO rotamoto_migrator;
REVOKE ALL PRIVILEGES ON DATABASE rotamoto FROM rotamoto_app;
REVOKE CONNECT, TEMPORARY ON DATABASE rotamoto FROM PUBLIC;
GRANT CONNECT ON DATABASE rotamoto TO rotamoto_app;

ALTER SCHEMA rotamoto OWNER TO rotamoto_migrator;
GRANT USAGE, CREATE ON SCHEMA rotamoto TO rotamoto_migrator;
REVOKE ALL PRIVILEGES ON SCHEMA rotamoto FROM PUBLIC, rotamoto_app;
GRANT USAGE ON SCHEMA rotamoto TO rotamoto_app;

DO $transfer_objects$
DECLARE
  item record;
  app_oid oid := (SELECT oid FROM pg_roles WHERE rolname='rotamoto_app');
BEGIN
  FOR item IN
    SELECT n.nspname, c.relname, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','v','m','f','S')
      AND c.relowner=app_oid
    ORDER BY c.relkind, c.relname
  LOOP
    IF item.relkind='S' THEN
      EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO rotamoto_migrator', item.nspname, item.relname);
    ELSE
      EXECUTE format('ALTER TABLE %I.%I OWNER TO rotamoto_migrator', item.nspname, item.relname);
    END IF;
  END LOOP;

  FOR item IN
    SELECT n.nspname, p.proname, p.prokind, pg_get_function_identity_arguments(p.oid) AS identity_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='rotamoto' AND p.proowner=app_oid
    ORDER BY p.proname
  LOOP
    IF item.prokind='p' THEN
      EXECUTE format('ALTER PROCEDURE %I.%I(%s) OWNER TO rotamoto_migrator',
        item.nspname, item.proname, item.identity_args);
    ELSIF item.prokind='a' THEN
      EXECUTE format('ALTER AGGREGATE %I.%I(%s) OWNER TO rotamoto_migrator',
        item.nspname, item.proname, item.identity_args);
    ELSE
      EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO rotamoto_migrator',
        item.nspname, item.proname, item.identity_args);
    END IF;
  END LOOP;

  FOR item IN
    SELECT n.nspname, t.typname
    FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='rotamoto' AND t.typrelid=0
      AND t.typtype IN ('c','d','e','r','m') AND t.typowner=app_oid
    ORDER BY t.typname
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO rotamoto_migrator', item.nspname, item.typname);
  END LOOP;
END;
$transfer_objects$;

-- Remova privilégios herdados/anteriores e conceda somente o DML usado pela API atual.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA rotamoto FROM PUBLIC, rotamoto_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA rotamoto FROM PUBLIC, rotamoto_app;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA rotamoto FROM PUBLIC, rotamoto_app;

GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.companies TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.credentials TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.identity_tokens TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.memberships TO rotamoto_app;
GRANT SELECT ON TABLE rotamoto.permissions TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.provisioning_requests TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.recovery_tokens TO rotamoto_app;
GRANT SELECT, INSERT ON TABLE rotamoto.role_permissions TO rotamoto_app;
GRANT SELECT, INSERT ON TABLE rotamoto.roles TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.sessions TO rotamoto_app;
GRANT SELECT, INSERT, UPDATE ON TABLE rotamoto.users TO rotamoto_app;
GRANT INSERT ON TABLE rotamoto.audit_log TO rotamoto_app;
GRANT EXECUTE ON FUNCTION rotamoto.current_tenant_id() TO rotamoto_app;

-- Default deny para tudo que uma migration futura criar. Cada objeto novo deve receber
-- grants explícitos na própria migration, conforme o caller e o escopo de tenant.
ALTER DEFAULT PRIVILEGES FOR ROLE rotamoto_migrator IN SCHEMA rotamoto
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, rotamoto_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rotamoto_migrator IN SCHEMA rotamoto
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, rotamoto_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rotamoto_migrator IN SCHEMA rotamoto
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, rotamoto_app;
-- PostgreSQL's global default EXECUTE grant to PUBLIC is not cancelled by a
-- per-schema REVOKE. Remove it globally for future migrator-owned routines.
ALTER DEFAULT PRIVILEGES FOR ROLE rotamoto_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $postflight$
DECLARE
  app_oid oid := (SELECT oid FROM pg_roles WHERE rolname='rotamoto_app');
  migrator_oid oid := (SELECT oid FROM pg_roles WHERE rolname='rotamoto_migrator');
  tenant_rls_count integer;
BEGIN
  IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR NOT rolcanlogin
      FROM pg_roles WHERE oid=migrator_oid) THEN
    RAISE EXCEPTION 'Atributos inseguros em rotamoto_migrator.';
  END IF;
  IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR NOT rolcanlogin
      FROM pg_roles WHERE oid=app_oid) THEN
    RAISE EXCEPTION 'Atributos inseguros em rotamoto_app.';
  END IF;
  IF (SELECT datdba FROM pg_database WHERE datname='rotamoto') <>
     (SELECT oid FROM pg_roles WHERE rolname='u0_a436') THEN
    RAISE EXCEPTION 'Owner do database não ficou com o DBA de emergência.';
  END IF;
  IF (SELECT nspowner FROM pg_namespace WHERE nspname='rotamoto') <> migrator_oid THEN
    RAISE EXCEPTION 'Schema rotamoto não pertence ao migrator.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','v','m','f','S') AND c.relowner<>migrator_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='rotamoto' AND p.proowner<>migrator_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='rotamoto' AND t.typrelid=0
      AND t.typtype IN ('c','d','e','r','m') AND t.typowner<>migrator_oid
  ) THEN
    RAISE EXCEPTION 'Há objeto de schema que não pertence ao migrator.';
  END IF;
  IF has_database_privilege('rotamoto_app','rotamoto','CREATE')
     OR has_database_privilege('rotamoto_app','rotamoto','TEMP')
     OR has_schema_privilege('rotamoto_app','rotamoto','CREATE')
     OR has_schema_privilege('rotamoto_app','public','CREATE') THEN
    RAISE EXCEPTION 'Runtime ainda possui privilégio DDL/TEMP no database ou schema.';
  END IF;
  IF has_table_privilege('rotamoto_app','rotamoto.schema_migrations','SELECT')
     OR has_table_privilege('rotamoto_app','rotamoto.schema_migrations','INSERT')
     OR has_table_privilege('rotamoto_app','rotamoto.schema_migrations','UPDATE')
     OR has_table_privilege('rotamoto_app','rotamoto.schema_migrations','DELETE') THEN
    RAISE EXCEPTION 'Runtime recebeu privilégio indevido no ledger de migrations.';
  END IF;
  IF has_table_privilege('rotamoto_app','rotamoto.users','DELETE')
     OR has_table_privilege('rotamoto_app','rotamoto.users','TRUNCATE')
     OR has_table_privilege('rotamoto_app','rotamoto.audit_log','UPDATE')
     OR has_table_privilege('rotamoto_app','rotamoto.audit_log','DELETE') THEN
    RAISE EXCEPTION 'Runtime possui DML/DDL além do perfil previsto.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclrole=migrator_oid AND d.defaclobjtype='f'
      AND a.grantee=0 AND a.privilege_type='EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Rotinas futuras do migrator ainda concedem EXECUTE a PUBLIC.';
  END IF;
  IF NOT has_table_privilege('rotamoto_app','rotamoto.users','SELECT')
     OR NOT has_table_privilege('rotamoto_app','rotamoto.users','INSERT')
     OR NOT has_table_privilege('rotamoto_app','rotamoto.users','UPDATE')
     OR NOT has_table_privilege('rotamoto_app','rotamoto.audit_log','INSERT')
     OR NOT has_function_privilege('rotamoto_app','rotamoto.current_tenant_id()','EXECUTE') THEN
    RAISE EXCEPTION 'Privilégios mínimos necessários à API/RLS ausentes.';
  END IF;
  SELECT count(*) INTO tenant_rls_count
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') AND c.relrowsecurity AND c.relforcerowsecurity;
  IF tenant_rls_count <> 10 OR EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p')
      AND c.relrowsecurity AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'RLS/FORCE divergiu durante a transferência.';
  END IF;
END;
$postflight$;

COMMIT;
