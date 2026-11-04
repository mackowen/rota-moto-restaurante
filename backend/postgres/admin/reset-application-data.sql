-- Campaign 0304: clear only the two explicitly authorized application schemas.
-- Invoke with psql -X -w -v commit_reset=false|true -f this-file.
-- false performs a full rehearsal and rolls the transaction back; true commits.
\if :{?commit_reset}
\else
  \echo 'Set -v commit_reset=false for rehearsal or true for the authorized commit.'
  \quit 2
\endif

BEGIN;
SET LOCAL search_path = pg_catalog, rotamoto;

DO $guard$
BEGIN
  IF current_database() NOT IN ('rotamoto', 'rotamoto_e2e') THEN
    RAISE EXCEPTION 'Reset recusado: banco fora do escopo autorizado';
  END IF;
  IF to_regclass('rotamoto.schema_migrations') IS NULL OR
     to_regclass('rotamoto.permissions') IS NULL OR
     to_regclass('rotamoto.installation_bootstrap') IS NULL OR
     to_regclass('rotamoto.platform_admin_bootstrap_latch') IS NULL THEN
    RAISE EXCEPTION 'Reset recusado: schema estrutural incompleto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rotamoto.schema_migrations WHERE migration_id = '0067_browser_bootstrap_mfa_completion') THEN
    RAISE EXCEPTION 'Reset recusado: migration 0067 ausente';
  END IF;
END
$guard$;

-- Snapshot exact structural state before the data operation. TRUNCATE does not
-- disable or alter RLS, triggers, constraints, indexes, grants, or functions.
CREATE TEMP TABLE _reset_structure_before ON COMMIT DROP AS
SELECT jsonb_build_object(
  'relations', (SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relowner::regrole::text,c.relacl::text) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','v','m','S','f')),
  'indexes', (SELECT jsonb_agg(jsonb_build_array(t.relname,i.relname,pg_get_indexdef(i.oid)) ORDER BY t.relname,i.relname)
    FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto'),
  'constraints', (SELECT jsonb_agg(jsonb_build_array(t.relname,k.conname,pg_get_constraintdef(k.oid,true)) ORDER BY t.relname,k.conname)
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto'),
  'triggers', (SELECT jsonb_agg(jsonb_build_array(t.relname,g.tgname,pg_get_triggerdef(g.oid,true)) ORDER BY t.relname,g.tgname)
    FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto' AND NOT g.tgisinternal),
  'policies', (SELECT jsonb_agg(jsonb_build_array(t.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,p.polqual,p.polwithcheck) ORDER BY t.relname,p.polname)
    FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto'),
  'functions', (SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rotamoto'),
  'schemaGrants', (SELECT nspacl::text FROM pg_namespace WHERE nspname='rotamoto'),
  'migrationLedger', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.migration_id) FROM rotamoto.schema_migrations m),
  'permissionCatalog', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.permission_key,p.catalog_version) FROM rotamoto.permissions p)
) AS signature;

-- Explicit complete application-data table list for the real schema. No
-- CASCADE, schema removal, role change, security setting change, or backup.
-- The two singleton latches are re-created in their pristine state below.
TRUNCATE TABLE
  rotamoto.audit_log,
  rotamoto.bootstrap_authorizations,
  rotamoto.bootstrap_smtp_test_attempts,
  rotamoto.companies,
  rotamoto.company_delivery_pricing,
  rotamoto.credentials,
  rotamoto.delivery_custody_operations,
  rotamoto.delivery_fulfillments,
  rotamoto.delivery_geo_snapshots,
  rotamoto.dispatch_attempts,
  rotamoto.domain_records,
  rotamoto.driver_availability,
  rotamoto.driver_availability_commands,
  rotamoto.external_accounts,
  rotamoto.financial_events,
  rotamoto.identity_tokens,
  rotamoto.installation_bootstrap,
  rotamoto.integrations,
  rotamoto.local_id_maps,
  rotamoto.logistics_decisions,
  rotamoto.logistics_intelligence_settings,
  rotamoto.logistics_providers,
  rotamoto.logistics_route_settings,
  rotamoto.marketplace_99food_rate_limits,
  rotamoto.marketplace_account_bindings,
  rotamoto.marketplace_account_routes,
  rotamoto.marketplace_authorization_events,
  rotamoto.marketplace_command_outbox,
  rotamoto.marketplace_event_inbox,
  rotamoto.marketplace_oauth_secrets,
  rotamoto.marketplace_oauth_states,
  rotamoto.marketplace_order_versions,
  rotamoto.memberships,
  rotamoto.mfa_recovery_challenges,
  rotamoto.mfa_recovery_requests,
  rotamoto.platform_admin_audit_log,
  rotamoto.platform_admin_bootstrap_latch,
  rotamoto.platform_administrators,
  rotamoto.platform_smtp_test_attempts,
  rotamoto.proof_media_upload_intents,
  rotamoto.provider_command_outbox,
  rotamoto.provider_event_inbox,
  rotamoto.provider_quotes,
  rotamoto.provider_tracking_snapshots,
  rotamoto.provisioning_requests,
  rotamoto.recovery_tokens,
  rotamoto.restaurant_dispatch_settings,
  rotamoto.restaurant_driver_presence,
  rotamoto.restaurant_presence_qr_nonces,
  rotamoto.role_permissions,
  rotamoto.roles,
  rotamoto.sessions,
  rotamoto.sync_inbox,
  rotamoto.sync_installations,
  rotamoto.sync_outbox,
  rotamoto.users;

INSERT INTO rotamoto.installation_bootstrap(singleton) VALUES (true);
INSERT INTO rotamoto.platform_admin_bootstrap_latch(singleton) VALUES (true);

DO $verify$
DECLARE after_signature jsonb; item record; row_count bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM rotamoto.schema_migrations WHERE migration_id='0067_browser_bootstrap_mfa_completion') IS NOT TRUE THEN
    RAISE EXCEPTION 'Migration 0067 não foi preservada';
  END IF;
  FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='rotamoto'
      AND tablename NOT IN ('schema_migrations','permissions') ORDER BY tablename LOOP
    EXECUTE format('SELECT count(*) FROM rotamoto.%I',item.tablename) INTO row_count;
    IF item.tablename IN ('installation_bootstrap','platform_admin_bootstrap_latch') THEN
      IF row_count <> 1 THEN RAISE EXCEPTION 'Latch estrutural ausente: %',item.tablename; END IF;
    ELSIF row_count <> 0 THEN
      RAISE EXCEPTION 'Dados de aplicação permaneceram em %: % registros',item.tablename,row_count;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM rotamoto.installation_bootstrap WHERE singleton=true AND completed_at IS NULL AND request_digest IS NULL) <> 1 OR
     (SELECT count(*) FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true AND founder_user_id IS NULL AND claimed_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'Latches estruturais não estão no estado inicial';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rotamoto.permissions) THEN
    RAISE EXCEPTION 'Catálogo RBAC foi removido';
  END IF;

  SELECT jsonb_build_object(
    'relations', (SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relowner::regrole::text,c.relacl::text) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','v','m','S','f')),
    'indexes', (SELECT jsonb_agg(jsonb_build_array(t.relname,i.relname,pg_get_indexdef(i.oid)) ORDER BY t.relname,i.relname)
      FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid
      JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto'),
    'constraints', (SELECT jsonb_agg(jsonb_build_array(t.relname,k.conname,pg_get_constraintdef(k.oid,true)) ORDER BY t.relname,k.conname)
      FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto'),
    'triggers', (SELECT jsonb_agg(jsonb_build_array(t.relname,g.tgname,pg_get_triggerdef(g.oid,true)) ORDER BY t.relname,g.tgname)
      FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto' AND NOT g.tgisinternal),
    'policies', (SELECT jsonb_agg(jsonb_build_array(t.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,p.polqual,p.polwithcheck) ORDER BY t.relname,p.polname)
      FROM pg_policy p JOIN pg_class t ON t.oid=p.polrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto'),
    'functions', (SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),p.proacl::text) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rotamoto'),
    'schemaGrants', (SELECT nspacl::text FROM pg_namespace WHERE nspname='rotamoto'),
    'migrationLedger', (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.migration_id) FROM rotamoto.schema_migrations m),
    'permissionCatalog', (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.permission_key,p.catalog_version) FROM rotamoto.permissions p)
  ) INTO after_signature;
  IF after_signature IS DISTINCT FROM (SELECT signature FROM _reset_structure_before) THEN
    RAISE EXCEPTION 'Estrutura, grants, RLS, funções, ledger ou catálogo RBAC mudou';
  END IF;
END
$verify$;

\if :commit_reset
  COMMIT;
  \echo 'RESET COMMIT aplicado e verificado.'
\else
  ROLLBACK;
  \echo 'ENSAIO aprovado; ROLLBACK executado, sem alteração persistente.'
\endif
