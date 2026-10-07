'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { createClient } = require('../backend/postgres/connection');
const { assertChecksums, getMigrations, withTransaction, migrationConnectionString } = require('../backend/postgres/migrate');

async function tenantQuery(client, tenantId, sql, values = []) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
    const result = await client.query(sql, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function runMigration(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, migrationArgs(command), {
      env: process.env, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
  });
}

function migrationArgs(command) {
  return [path.join(__dirname, '../backend/postgres/migrate.js'), command,
    ...(process.env.NODE_ENV === 'test' ? ['--e2e'] : [])];
}

function runMigrationSync(command) {
  return spawnSync(process.execPath, migrationArgs(command), { env: process.env, encoding: 'utf8', timeout: 10000 });
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.MIGRATOR_DATABASE_URL) {
    throw new Error('Defina DATABASE_URL (rotamoto_app) e MIGRATOR_DATABASE_URL (rotamoto_migrator) via pgpass.');
  }
  const runtimeUrl = new URL(process.env.DATABASE_URL);
  const migratorUrl = new URL(process.env.MIGRATOR_DATABASE_URL);
  if (runtimeUrl.pathname === '/rotamoto' || migratorUrl.pathname === '/rotamoto') {
    throw new Error('Guard: esta suíte cria fixtures e não pode conectar ao database operacional rotamoto. Use o lifecycle E2E em rotamoto_e2e.');
  }
  assert.equal(decodeURIComponent(runtimeUrl.username), 'rotamoto_app', 'runtime tests must use the restricted role');
  assert.equal(decodeURIComponent(migratorUrl.username), 'rotamoto_migrator', 'migration tests must use the migrator role');
  const configuredMigratorUrl = process.env.MIGRATOR_DATABASE_URL;
  process.env.MIGRATOR_DATABASE_URL = 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto';
  assert.throws(migrationConnectionString, /deve autenticar como rotamoto_migrator/,
    'migration runner rejects the runtime URL before connecting');
  process.env.MIGRATOR_DATABASE_URL = 'postgresql://rotamoto_migrator@192.0.2.1:5432/rotamoto';
  assert.throws(migrationConnectionString, /deve apontar sem senha para rotamoto_migrator/,
    'migration runner refuses a non-official host');
  process.env.MIGRATOR_DATABASE_URL = configuredMigratorUrl;
  const initialUp=await runMigration('up');
  assert.equal(initialUp.status,0,'new additive domain constraints migration applies through the migrator');
  const migration = getMigrations()[0];
  assert.equal(migration.id, '0001_identity_tenant_foundation');
  const provisioningMigration = getMigrations()[1];
  assert.equal(provisioningMigration.id, '0002_identity_provisioning_tokens');
  assert.match(provisioningMigration.up, /CREATE TABLE rotamoto\.identity_tokens/);
  assert.match(provisioningMigration.up, /token_digest bytea NOT NULL UNIQUE/);
  const membershipConstraintMigration = getMigrations()[2];
  assert.equal(membershipConstraintMigration.id, '0003_provisioning_membership_constraint');
  assert.match(membershipConstraintMigration.up, /FOREIGN KEY \(company_id, user_id\)/);
  const integrityMigration = getMigrations()[3];
  assert.equal(integrityMigration.id, '0004_foundation_integrity_constraints');
  assert.match(integrityMigration.up, /audit_log_user_actor_required/);
  assert.match(integrityMigration.up, /sessions_expiry_order_check/);
  assert.match(integrityMigration.up, /sync_outbox_publish_time_check/);
  assert.match(integrityMigration.down, /rollback bloqueado/);
  const domainSyncMigration = getMigrations()[4];
  assert.equal(domainSyncMigration.id, '0005_canonical_domain_sync');
  assert.match(domainSyncMigration.up, /CREATE TABLE rotamoto\.domain_records/);
  assert.match(domainSyncMigration.up, /CREATE TABLE rotamoto\.sync_installations/);
  assert.match(domainSyncMigration.up, /FORCE ROW LEVEL SECURITY/);
  assert.match(domainSyncMigration.up, /DeliveryEvent é um fato imutável/);
  assert.match(domainSyncMigration.down, /rollback bloqueado/);
  const eventIdempotencyMigration = getMigrations()[5];
  assert.equal(eventIdempotencyMigration.id, '0006_global_event_idempotency');
  assert.match(eventIdempotencyMigration.up, /domain_records_event_idempotency_uq/);
  assert.match(eventIdempotencyMigration.down, /rollback bloqueado/);
  const syncPermissionMigration = getMigrations()[6];
  assert.equal(syncPermissionMigration.id, '0007_sync_permissions');
  assert.match(syncPermissionMigration.up, /'sync\.push'/);
  assert.match(syncPermissionMigration.up, /'sync\.pull'/);
  const syncInstallIdentityMigration = getMigrations()[7];
  assert.equal(syncInstallIdentityMigration.id, '0008_sync_installation_identity');
  assert.match(syncInstallIdentityMigration.up, /registered_by_user_id uuid REFERENCES rotamoto\.users/);
  assert.match(syncInstallIdentityMigration.down, /rollback bloqueado/);
  const canonicalModelMigration = getMigrations()[8];
  assert.equal(canonicalModelMigration.id, '0009_domain_model_constraints');
  assert.match(canonicalModelMigration.up, /valid_route_delivery_ids/);
  assert.match(canonicalModelMigration.up, /domain_earning_amount_minor_check/);
  assert.match(canonicalModelMigration.up, /domain_active_route_delivery_gin_idx/);
  const runtimeIntegrationReadMigration = getMigrations()[10];
  assert.equal(runtimeIntegrationReadMigration.id, '0011_runtime_integration_read');
  assert.match(runtimeIntegrationReadMigration.up, /GRANT SELECT ON TABLE rotamoto\.integrations, rotamoto\.external_accounts TO rotamoto_app/);
  assert.match(runtimeIntegrationReadMigration.down, /REVOKE SELECT ON TABLE rotamoto\.integrations, rotamoto\.external_accounts FROM rotamoto_app/);
  const identityLifecycleMigration = getMigrations()[11];
  assert.equal(identityLifecycleMigration.id, '0012_identity_rbac_lifecycle');
  assert.match(identityLifecycleMigration.up, /membership_invitation/);
  assert.match(identityLifecycleMigration.up, /GRANT DELETE ON TABLE rotamoto\.role_permissions TO rotamoto_app/);
  assert.match(identityLifecycleMigration.down, /preservar registros e futuras/);
  const driverBindingMigration = getMigrations()[12];
  assert.equal(driverBindingMigration.id, '0013_membership_driver_binding');
  assert.match(driverBindingMigration.up, /memberships_driver_record_fk/);
  assert.match(driverBindingMigration.up, /memberships_driver_unique/);
  assert.match(driverBindingMigration.up, /sync_outbox_recipient_driver_fk/);
  assert.match(driverBindingMigration.down, /WHERE driver_id IS NOT NULL/u);
  assert.match(driverBindingMigration.down, /WHERE recipient_driver_id IS NOT NULL/u);
  const logisticsMigration = getMigrations()[16];
  assert.equal(logisticsMigration.id, '0017_logistics_fulfillment');
  assert.match(logisticsMigration.up, /delivery_fulfillments_one_active_uq/u);
  assert.match(logisticsMigration.up, /UNIQUE \(company_id, provider_id, idempotency_key\)/u);
  assert.match(logisticsMigration.up, /FORCE ROW LEVEL SECURITY/u);
  assert.match(logisticsMigration.down, /rollback bloqueado/u);
  const geoSnapshotMigration = getMigrations()[17];
  assert.equal(geoSnapshotMigration.id, '0018_delivery_geo_snapshots');
  assert.match(geoSnapshotMigration.up, /FORCE ROW LEVEL SECURITY/u);
  const providerLeastPrivilegeMigration = getMigrations()[18];
  assert.equal(providerLeastPrivilegeMigration.id, '0019_logistics_provider_secret_least_privilege');
  assert.match(providerLeastPrivilegeMigration.up, /REVOKE SELECT ON TABLE rotamoto\.logistics_providers FROM rotamoto_app/u);
  assert.match(providerLeastPrivilegeMigration.up, /GRANT SELECT \([\s\S]*configuration[\s\S]*\) ON TABLE rotamoto\.logistics_providers TO rotamoto_app/u);
  assert.doesNotMatch(providerLeastPrivilegeMigration.up, /GRANT SELECT \([\s\S]*secret_ref/u);
  assert.match(providerLeastPrivilegeMigration.down, /rollback bloqueado/u);
  const providerRuntimeMigration = getMigrations()[19];
  assert.equal(providerRuntimeMigration.id, '0020_provider_integration_runtime');
  assert.match(providerRuntimeMigration.up, /FOR UPDATE OF o SKIP LOCKED/u);
  assert.match(providerRuntimeMigration.up, /FORCE ROW LEVEL SECURITY/u);
  assert.match(providerRuntimeMigration.up, /secret_ref IS NOT NULL/u);
  const providerClaimMigration = getMigrations()[20];
  assert.equal(providerClaimMigration.id, '0021_provider_claim_tenant_scope');
  assert.match(providerClaimMigration.up, /p_company_id uuid/u);
  assert.match(providerClaimMigration.up, /app\.tenant_id/u);
  assert.match(providerClaimMigration.up, /FOR UPDATE OF o SKIP LOCKED/u);
  const providerLeaseRecoveryMigration = getMigrations()[21];
  assert.equal(providerLeaseRecoveryMigration.id, '0022_provider_ambiguous_lease_recovery');
  assert.match(providerLeaseRecoveryMigration.up, /unknown_outcome/u);
  assert.match(providerLeaseRecoveryMigration.up, /o\.operation NOT IN \('DISPATCH_REQUEST','CANCEL_REQUEST'\)/u);
  const providerWorkerPrivilegeMigration = getMigrations()[22];
  assert.equal(providerWorkerPrivilegeMigration.id, '0023_provider_worker_least_privilege');
  assert.match(providerWorkerPrivilegeMigration.up, /REVOKE EXECUTE[\s\S]*rotamoto_app/u);
  assert.match(providerWorkerPrivilegeMigration.up, /rotamoto_provider_worker/u);
  assert.doesNotMatch(providerWorkerPrivilegeMigration.up, /GRANT[^;]*secret_ref[^;]*rotamoto_provider_worker/u);
  const providerTrackingGrantMigration = getMigrations()[23];
  assert.equal(providerTrackingGrantMigration.id, '0024_provider_tracking_status_grant');
  assert.match(providerTrackingGrantMigration.up, /GRANT UPDATE \(status\).*rotamoto_provider_worker/u);
  const providerEventGrantMigration = getMigrations()[24];
  assert.equal(providerEventGrantMigration.id, '0025_provider_event_worker_grants');
  assert.match(providerEventGrantMigration.up, /provider_event_inbox TO rotamoto_provider_worker/u);
  const fulfillmentEventGrantMigration = getMigrations()[25];
  assert.equal(fulfillmentEventGrantMigration.id, '0026_provider_fulfillment_event_grants');
  assert.match(fulfillmentEventGrantMigration.up, /delivery_fulfillments TO rotamoto_provider_worker/u);
  const logisticsIntelligenceMigration = getMigrations()[26];
  assert.equal(logisticsIntelligenceMigration.id, '0027_logistics_intelligence_settings');
  assert.match(logisticsIntelligenceMigration.up, /CREATE TABLE rotamoto\.logistics_intelligence_settings/u);
  assert.match(logisticsIntelligenceMigration.up, /FORCE ROW LEVEL SECURITY/u);
  assert.match(logisticsIntelligenceMigration.up, /company_id=rotamoto\.current_tenant_id\(\)/u);
  assert.match(logisticsIntelligenceMigration.up, /GRANT SELECT,INSERT,UPDATE[^;]*rotamoto_app/u);
  assert.doesNotMatch(logisticsIntelligenceMigration.up, /secret_ref/u);
  const externalAccountSecretMigration = getMigrations()[27];
  assert.equal(externalAccountSecretMigration.id, '0028_external_account_secret_least_privilege');
  assert.match(externalAccountSecretMigration.up, /REVOKE SELECT ON TABLE rotamoto\.external_accounts FROM rotamoto_app/u);
  assert.match(externalAccountSecretMigration.up, /GRANT SELECT \([\s\S]*metadata,created_at,updated_at\s*\) ON TABLE rotamoto\.external_accounts TO rotamoto_app/u);
  assert.doesNotMatch(externalAccountSecretMigration.up, /secret_ref/u);
  assert.match(externalAccountSecretMigration.down, /rollback bloqueado/u);
  const humanDecisionMigration=getMigrations()[28];
  assert.equal(humanDecisionMigration.id,'0029_logistics_human_decisions');
  assert.match(humanDecisionMigration.up,/CREATE TABLE rotamoto\.logistics_decisions/u);
  assert.match(humanDecisionMigration.up,/FORCE ROW LEVEL SECURITY/u);
  assert.match(humanDecisionMigration.up,/company_id=rotamoto\.current_tenant_id\(\)/u);
  assert.match(humanDecisionMigration.up,/UNIQUE INDEX logistics_decisions_execution_idempotency/u);
  assert.match(humanDecisionMigration.up,/GRANT SELECT,INSERT,UPDATE[^;]*rotamoto_app/u);
  assert.doesNotMatch(humanDecisionMigration.up,/secret_ref|payload_raw|address|phone/iu);
  const staleApprovalMigration=getMigrations()[29];
  assert.equal(staleApprovalMigration.id,'0030_logistics_decision_stale_approval');
  assert.match(staleApprovalMigration.up,/DROP CONSTRAINT logistics_decisions_check/u);
  assert.match(staleApprovalMigration.up,/status='stale'[\s\S]*decided_by IS NOT NULL AND decided_at IS NOT NULL/u);
  assert.match(staleApprovalMigration.down,/rollback bloqueado/u);
  const decisionWorkerMigration=getMigrations()[30];
  assert.equal(decisionWorkerMigration.id,'0031_logistics_decision_worker_projection');
  assert.match(decisionWorkerMigration.up,/status IN[\s\S]*'cancelled'/u);
  assert.match(decisionWorkerMigration.up,/GRANT SELECT \(company_id,decision_id,delivery_id,status,execution_result,version\)[\s\S]*rotamoto_provider_worker/u);
  assert.match(decisionWorkerMigration.up,/GRANT UPDATE \(status,version,updated_at\)[\s\S]*rotamoto_provider_worker/u);
  assert.match(decisionWorkerMigration.down,/rollback bloqueado/u);
  assert.match(geoSnapshotMigration.up, /ON DELETE RESTRICT/u);
  assert.equal(migration.checksum, crypto.createHash('sha256').update(migration.up).digest('hex'));
  assert.match(migration.up, /CREATE TABLE rotamoto\.users/);
  assert.match(migration.up, /CREATE TABLE rotamoto\.memberships/);
  assert.match(migration.up, /CREATE TABLE rotamoto\.sessions/);
  assert.match(migration.up, /CREATE TABLE rotamoto\.integrations/);
  assert.match(migration.up, /CREATE TABLE rotamoto\.local_id_maps/);
  assert.match(migration.up, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration.down, /rollback bloqueado/);
  await assert.rejects(assertChecksums({ query: async () => ({ rows: [{ migration_id: '9999_removed_migration', checksum_sha256: '0'.repeat(64) }] }) }, []),
    /não existe mais/, 'runner refuses an applied migration missing from source');

  const client = createClient({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  const runtimeClient = createClient({ connectionString: process.env.DATABASE_URL });
  const migrationClient = createClient({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  await client.connect();
  await runtimeClient.connect();
  await migrationClient.connect();
  try {
    assert.equal((await runtimeClient.query('SELECT current_user AS role')).rows[0].role, 'rotamoto_app');
    assert.equal((await migrationClient.query('SELECT current_user AS role')).rows[0].role, 'rotamoto_migrator');
    await assert.rejects(assertChecksums(client, getMigrations().map(item => item.id === migration.id
      ? { ...item, checksum: '0'.repeat(64) } : item)),
      /Checksum divergente/, 'applied migration files cannot be edited silently');
    await assert.rejects(runtimeClient.query('SELECT migration_id FROM rotamoto.schema_migrations'), /permission denied/i,
      'runtime cannot inspect the migration ledger');
    const installed = await migrationClient.query('SELECT migration_id FROM rotamoto.schema_migrations ORDER BY migration_id');
    assert.deepEqual(installed.rows.map(row => row.migration_id), getMigrations().map(item => item.id),
      'official database has every checked-in migration applied');
    const runtimePrivileges = await runtimeClient.query(`SELECT
      has_database_privilege(current_user,current_database(),'CREATE') AS db_create,
      has_database_privilege(current_user,current_database(),'TEMP') AS db_temp,
      has_schema_privilege(current_user,'rotamoto','CREATE') AS schema_create,
      has_table_privilege(current_user,'rotamoto.schema_migrations','SELECT') AS ledger_select,
      has_table_privilege(current_user,'rotamoto.audit_log','UPDATE') AS audit_update,
      has_table_privilege(current_user,'rotamoto.audit_log','DELETE') AS audit_delete`);
    assert.deepEqual(runtimePrivileges.rows[0], { db_create: false, db_temp: false, schema_create: false,
      ledger_select: false, audit_update: false, audit_delete: false }, 'runtime role has no DDL, temp, ledger or audit mutation rights');
    const integrationPrivileges = await runtimeClient.query(`SELECT
      has_table_privilege(current_user,'rotamoto.integrations','SELECT') AS integrations_read,
      has_table_privilege(current_user,'rotamoto.integrations','INSERT') AS integrations_insert,
      has_table_privilege(current_user,'rotamoto.integrations','UPDATE') AS integrations_update,
      has_table_privilege(current_user,'rotamoto.external_accounts','SELECT') AS accounts_read,
      has_column_privilege(current_user,'rotamoto.external_accounts','display_name','SELECT') AS account_display_read,
      has_column_privilege(current_user,'rotamoto.external_accounts','secret_ref','SELECT') AS account_secret_read,
      has_column_privilege(current_user,'rotamoto.external_accounts','secret_ref','UPDATE') AS account_secret_update,
      has_table_privilege(current_user,'rotamoto.external_accounts','UPDATE') AS accounts_update`);
    assert.deepEqual(integrationPrivileges.rows[0], { integrations_read: true, integrations_insert: true, integrations_update: true,
      accounts_read: false, account_display_read: true, account_secret_read: false, account_secret_update: false,
      accounts_update: false }, 'runtime gets column-scoped integration metadata access without credential references');
    const lifecyclePrivileges = await runtimeClient.query(`SELECT
      has_column_privilege(current_user,'rotamoto.roles','display_name','UPDATE') AS role_name_update,
      has_table_privilege(current_user,'rotamoto.role_permissions','DELETE') AS role_permission_delete`);
    assert.deepEqual(lifecyclePrivileges.rows[0], { role_name_update: true, role_permission_delete: true },
      'runtime has only explicit role-maintenance privileges required by authorized admin use cases');
    const driverBindingPrivileges = await runtimeClient.query(`SELECT
      has_column_privilege(current_user,'rotamoto.memberships','driver_id','UPDATE') AS driver_link_update,
      has_column_privilege(current_user,'rotamoto.memberships','driver_id','SELECT') AS driver_link_read,
      has_table_privilege(current_user,'rotamoto.sync_outbox','DELETE') AS outbox_delete,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='rotamoto.memberships'::regclass) AS membership_forced_rls,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='rotamoto.sync_outbox'::regclass) AS outbox_forced_rls`);
    assert.deepEqual(driverBindingPrivileges.rows[0], { driver_link_update: true, driver_link_read: true, outbox_delete: false,
      membership_forced_rls: true, outbox_forced_rls: true }, 'driver binding is tenant protected and runtime has no destructive outbox rights');
    const logisticsPrivileges = await runtimeClient.query(`SELECT
      has_table_privilege(current_user,'rotamoto.logistics_providers','SELECT') AS provider_read,
      has_column_privilege(current_user,'rotamoto.logistics_providers','provider_id','SELECT') AS provider_id_read,
      has_column_privilege(current_user,'rotamoto.logistics_providers','secret_ref','SELECT') AS provider_secret_ref_read,
      has_column_privilege(current_user,'rotamoto.logistics_providers','provider_id','INSERT') AS provider_insert,
      has_column_privilege(current_user,'rotamoto.logistics_providers','display_name','UPDATE') AS provider_update,
      has_column_privilege(current_user,'rotamoto.logistics_providers','secret_ref','UPDATE') AS provider_secret_ref_update,
      has_column_privilege(current_user,'rotamoto.logistics_providers','provider_class','UPDATE') AS provider_class_update,
      has_table_privilege(current_user,'rotamoto.logistics_providers','DELETE') AS provider_delete,
      has_column_privilege(current_user,'rotamoto.delivery_fulfillments','mode','INSERT') AS fulfillment_insert,
      has_table_privilege(current_user,'rotamoto.delivery_fulfillments','DELETE') AS fulfillment_delete,
      has_column_privilege(current_user,'rotamoto.dispatch_attempts','status','UPDATE') AS attempt_status_update,
      has_table_privilege(current_user,'rotamoto.dispatch_attempts','DELETE') AS attempts_delete,
      (SELECT bool_and(c.relrowsecurity AND c.relforcerowsecurity) FROM pg_class c
        WHERE c.oid IN ('rotamoto.logistics_providers'::regclass,'rotamoto.delivery_fulfillments'::regclass,'rotamoto.dispatch_attempts'::regclass)) AS logistics_force_rls`);
    assert.deepEqual(logisticsPrivileges.rows[0], { provider_read: false, provider_id_read: true, provider_secret_ref_read: false,
      provider_insert: true, provider_update: true,
      provider_secret_ref_update: false, provider_class_update: false, provider_delete: false, fulfillment_insert: true,
      fulfillment_delete: false, attempt_status_update: true, attempts_delete: false, logistics_force_rls: true },
    'logistics runtime access uses column grants, forced RLS and no destructive rights');
    const driverForeignKeys = await migrationClient.query(`SELECT count(*)::int AS count FROM pg_constraint
      WHERE connamespace='rotamoto'::regnamespace AND conname IN ('memberships_driver_record_fk','sync_outbox_recipient_driver_fk')`);
    assert.equal(driverForeignKeys.rows[0].count, 2, 'both driver foreign keys are installed');
    const ownership = await migrationClient.query(`SELECT
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='rotamoto' AND pg_get_userbyid(p.proowner)='rotamoto_migrator') AS owned_routines,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'
         AND pg_get_userbyid(c.relowner)='rotamoto_migrator') AS migrator_ledger,
      (SELECT c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='rotamoto_migrator'
       FROM pg_class c WHERE c.oid='rotamoto.logistics_intelligence_settings'::regclass) AS intelligence_settings_protected,
      NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole='rotamoto_migrator'::regrole AND d.defaclobjtype='f'
          AND a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute_default`);
    assert.equal(ownership.rows[0].owned_routines, 11,
      'migrator owns the seven prior routines plus four marketplace claim/route routines');
    assert.equal(ownership.rows[0].migrator_ledger, 1);
    assert.equal(ownership.rows[0].intelligence_settings_protected, true,
      'new economic settings table is owned by migrator and enforces RLS and FORCE RLS');
    assert.equal(ownership.rows[0].no_public_execute_default, true,
      'future migrator functions do not receive PUBLIC EXECUTE by default');
    assert.equal((await runtimeClient.query("SELECT has_function_privilege(current_user,'rotamoto.valid_route_delivery_ids(jsonb)','EXECUTE') AS can_validate")).rows[0].can_validate,
      true,'runtime has only the explicit execution grant needed by the domain constraint');
    const routeIdsChecks = await migrationClient.query(
      'SELECT rotamoto.valid_route_delivery_ids($1::jsonb) AS empty_ok, rotamoto.valid_route_delivery_ids($2::jsonb) AS duplicate_rejected, rotamoto.valid_route_delivery_ids($3::jsonb) AS malformed_rejected',
      ['[]', '["00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000001"]',
        '["not-a-canonical-uuid"]']);
    assert.deepEqual(routeIdsChecks.rows[0], { empty_ok: true, duplicate_rejected: false, malformed_rejected: false },
      'route membership accepts empty plans and rejects duplicate or noncanonical IDs');
    assert.equal(await migrationClient.query("SELECT has_schema_privilege(current_user,'rotamoto','CREATE') AS can_ddl")
      .then(result => result.rows[0].can_ddl), true, 'migrator can create schema objects');
    const concurrentUp = await Promise.all([runMigration('up'), runMigration('up')]);
    assert(concurrentUp.every(result => result.status === 0), 'concurrent up runs serialize through advisory lock');
    assert(concurrentUp.every(result => /schema atualizado/u.test(result.stdout)), 'reapplying up is idempotent');

    const tempTable = `rollback_${crypto.randomUUID().replaceAll('-', '')}`;
    await assert.rejects(withTransaction(client, async () => {
      await client.query(`CREATE TEMP TABLE ${tempTable} (value integer)`);
      await client.query(`INSERT INTO ${tempTable} VALUES (1)`);
      throw new Error('synthetic migration failure');
    }), /synthetic migration failure/);
    const rollbackResult = await client.query('SELECT to_regclass($1) IS NULL AS rolled_back', [`pg_temp.${tempTable}`]);
    assert.equal(rollbackResult.rows[0].rolled_back, true, 'failed transaction removes all staged DDL and remains reusable');
    await client.query('SELECT 1');

    const cleanSchema = `migration_sandbox_${crypto.randomUUID().replaceAll('-', '')}`;
    await client.query('BEGIN');
    try {
      for (const item of getMigrations()) {
        await client.query(item.up.replace(/\brotamoto\b/gu, cleanSchema));
      }
      const cleanIntelligence = await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,
        pg_get_userbyid(c.relowner) AS owner,has_table_privilege('rotamoto_app',c.oid,'DELETE') AS app_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname='logistics_intelligence_settings'`, [cleanSchema]);
      assert.deepEqual(cleanIntelligence.rows[0], { relrowsecurity: true, relforcerowsecurity: true,
        owner: 'rotamoto_migrator', app_delete: false }, 'fresh install creates protected economic settings');
      await client.query('ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    const sandboxGone = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [cleanSchema]);
    assert.equal(sandboxGone.rowCount, 0, 'clean-install sandbox leaves no schema behind');

    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'rotamoto' AND table_type = 'BASE TABLE'
    `);
    assert.deepEqual(new Set(tables.rows.map(row => row.table_name)), new Set([
      'schema_migrations','users','credentials','recovery_tokens','companies','permissions',
      'roles','role_permissions','memberships','sessions','integrations','external_accounts',
      'local_id_maps','audit_log','sync_inbox','sync_outbox','provisioning_requests','identity_tokens',
      'sync_installations','domain_records','proof_media_upload_intents','logistics_providers','delivery_fulfillments','dispatch_attempts','delivery_geo_snapshots',
      'provider_quotes','provider_command_outbox','provider_event_inbox','provider_tracking_snapshots','logistics_intelligence_settings','logistics_decisions','logistics_route_settings',
      'marketplace_account_bindings','marketplace_account_routes','marketplace_authorization_events','marketplace_command_outbox',
      'marketplace_event_inbox','marketplace_oauth_secrets','marketplace_oauth_states','marketplace_order_versions'
    ]));
    const rls = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relkind='r' AND c.relname <> 'schema_migrations'
    `);
    const tenantTables = rls.rows.filter(row => row.relrowsecurity);
    assert(tenantTables.some(row=>row.relname==='logistics_intelligence_settings'&&row.relforcerowsecurity),
      'economic settings are included in forced tenant RLS');
    assert(tenantTables.some(row=>row.relname==='logistics_decisions'&&row.relforcerowsecurity),
      'human decisions are tenant scoped with forced RLS');
    assert(tenantTables.some(row=>row.relname==='logistics_route_settings'&&row.relforcerowsecurity),
      'Route origin policy remains tenant scoped with forced RLS');
    assert(tenantTables.every(row => row.relforcerowsecurity), 'all tenant-scoped tables enforce RLS');
    const auditTenant = crypto.randomUUID();
    await migrationClient.query('BEGIN');
    try {
      await migrationClient.query("SELECT set_config('app.tenant_id',$1,true)", [auditTenant]);
      await migrationClient.query(`INSERT INTO rotamoto.companies(id,name) VALUES($1,'QA append-only')`, [auditTenant]);
      await migrationClient.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_kind,action)
        VALUES($1,$2,'system','qa.append-only')`, [crypto.randomUUID(), auditTenant]);
      await migrationClient.query('SAVEPOINT audit_update_check');
      await assert.rejects(migrationClient.query(`UPDATE rotamoto.audit_log SET action='changed'
        WHERE company_id=$1 AND action='qa.append-only'`, [auditTenant]), /append-only/);
      await migrationClient.query('ROLLBACK TO SAVEPOINT audit_update_check');
      await migrationClient.query('RELEASE SAVEPOINT audit_update_check');
      await migrationClient.query('SAVEPOINT audit_delete_check');
      await assert.rejects(migrationClient.query(`DELETE FROM rotamoto.audit_log
        WHERE company_id=$1 AND action='qa.append-only'`, [auditTenant]), /append-only/);
      await migrationClient.query('ROLLBACK TO SAVEPOINT audit_delete_check');
      await migrationClient.query('RELEASE SAVEPOINT audit_delete_check');
      await migrationClient.query('ROLLBACK');
    } catch (error) {
      await migrationClient.query('ROLLBACK').catch(() => {});
      throw error;
    }
    const noTenant = await runtimeClient.query(`SELECT count(*)::int AS count FROM rotamoto.companies`);
    assert.equal(noTenant.rows[0].count, 0, 'missing tenant context denies visibility');
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    await tenantQuery(runtimeClient, tenantA, `INSERT INTO rotamoto.companies (id,name) VALUES ($1,'QA tenant A')`, [tenantA]);
    await tenantQuery(runtimeClient, tenantB, `INSERT INTO rotamoto.companies (id,name) VALUES ($1,'QA tenant B')`, [tenantB]);
    const logisticsProviderId = crypto.randomUUID();
    await tenantQuery(runtimeClient, tenantA, `INSERT INTO rotamoto.logistics_providers(company_id,provider_id,code,display_name,provider_class)
      VALUES($1,$2,'qa_provider','QA provider','partner')`, [tenantA, logisticsProviderId]);
    try {
      await runtimeClient.query('BEGIN');
      await runtimeClient.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantA]);
      const visible = await runtimeClient.query(`SELECT id::text FROM rotamoto.companies ORDER BY id`);
      assert.deepEqual(visible.rows.map(row => row.id), [tenantA], 'tenant context reveals only the selected company');
      await runtimeClient.query('ROLLBACK');
      await runtimeClient.query('BEGIN');
      await runtimeClient.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantA]);
      await assert.rejects(runtimeClient.query(`INSERT INTO rotamoto.companies (id,name) VALUES ($1,'cross-tenant')`, [tenantB]), /row-level security|policy/i, 'tenant context rejects cross-tenant writes');
      await runtimeClient.query('ROLLBACK');
      await assert.rejects(tenantQuery(runtimeClient, tenantA, `INSERT INTO rotamoto.logistics_providers(company_id,provider_id,code,display_name,provider_class)
        VALUES($1,$2,'cross_tenant_provider','cross tenant','partner')`, [tenantB, crypto.randomUUID()]), /row-level security|policy/i,
      'provider inserts cannot cross tenants');
      const visibleProviders = await tenantQuery(runtimeClient, tenantA, `SELECT provider_id::text FROM rotamoto.logistics_providers WHERE company_id=$1`, [tenantA]);
      assert.deepEqual(visibleProviders.rows.map(row => row.provider_id), [logisticsProviderId], 'provider read is tenant scoped');
      await assert.rejects(tenantQuery(runtimeClient, tenantA, `INSERT INTO rotamoto.audit_log(id,company_id,actor_kind,action)
        VALUES ($1,$2,'user','qa.invalid.actor')`, [crypto.randomUUID(), tenantA]), /audit_log_user_actor_required/,
      'user audit entries require a canonical actor user');
      await assert.rejects(runtimeClient.query(`UPDATE rotamoto.audit_log SET action='changed' WHERE false`), /permission denied/i,
        'runtime cannot update append-only audit entries');
      await assert.rejects(runtimeClient.query(`DELETE FROM rotamoto.audit_log WHERE false`), /permission denied/i,
        'runtime cannot delete append-only audit entries');
      await assert.rejects(tenantQuery(migrationClient, tenantA, `INSERT INTO rotamoto.sync_outbox
        (company_id,event_id,app_key,installation_id,created_at,published_at,payload)
        VALUES ($1,$2,'restaurante',$3,now(),now()-interval '1 second','{}'::jsonb)`,
      [tenantA, crypto.randomUUID(), crypto.randomUUID()]), /sync_outbox_publish_time_check/,
      'outbox cannot be published before creation');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await tenantQuery(migrationClient, tenantA, `DELETE FROM rotamoto.logistics_providers WHERE provider_id=$1`, [logisticsProviderId]);
      await tenantQuery(migrationClient, tenantA, `DELETE FROM rotamoto.companies WHERE id=$1`, [tenantA]);
      await tenantQuery(migrationClient, tenantB, `DELETE FROM rotamoto.companies WHERE id=$1`, [tenantB]);
    }
    const rollbackGuardId = crypto.randomUUID();
    const rollbackGuardUserId = crypto.randomUUID();
    const rollbackGuardRoleId = crypto.randomUUID();
    const rollbackGuardMembershipId = crypto.randomUUID();
    const rollbackGuardDigest = crypto.randomBytes(32);
    await tenantQuery(client, rollbackGuardId, `INSERT INTO rotamoto.companies (id,name) VALUES ($1,'QA rollback guard')`, [rollbackGuardId]);
    await tenantQuery(client, rollbackGuardId, `INSERT INTO rotamoto.users (id,email) VALUES ($1,$2)`,
      [rollbackGuardUserId, `rollback-${rollbackGuardUserId}@example.invalid`]);
    await tenantQuery(client, rollbackGuardId, `INSERT INTO rotamoto.roles (id,company_id,role_key,display_name)
      VALUES ($1,$2,'qa-rollback','QA rollback')`, [rollbackGuardRoleId, rollbackGuardId]);
    await tenantQuery(client, rollbackGuardId, `INSERT INTO rotamoto.memberships (id,company_id,user_id,role_id,status)
      VALUES ($1,$2,$3,$4,'invited')`, [rollbackGuardMembershipId, rollbackGuardId, rollbackGuardUserId, rollbackGuardRoleId]);
    await assert.rejects(tenantQuery(client, rollbackGuardId, `INSERT INTO rotamoto.sessions
      (id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES ($1,$2,$3,$4,$5,now(),now(),now()+interval '4 hours',now()+interval '3 hours')`,
    [crypto.randomUUID(), rollbackGuardUserId, rollbackGuardId, crypto.randomBytes(32), crypto.randomBytes(32)]),
    /sessions_expiry_order_check/, 'session idle expiry cannot exceed its absolute expiry');
    await tenantQuery(client, rollbackGuardId, `INSERT INTO rotamoto.provisioning_requests
      (idempotency_key_digest,request_digest,company_id,user_id,delivery_status) VALUES ($1,$2,$3,$4,'sent')`,
    [rollbackGuardDigest, crypto.randomBytes(32), rollbackGuardId, rollbackGuardUserId]);
    try {
      const appliedLedger = await migrationClient.query(`SELECT migration_id FROM rotamoto.schema_migrations ORDER BY migration_id DESC LIMIT 1`);
      if (['0033_company_operational_location','0034_company_route_grouping_policy'].includes(appliedLedger.rows[0]?.migration_id)) {
        const hasRouteGrouping=appliedLedger.rows[0].migration_id==='0034_company_route_grouping_policy';
        const configuredLocations=await migrationClient.query(`SELECT count(*)::int AS count FROM rotamoto.companies
          WHERE operational_latitude IS NOT NULL OR operational_location_version<>0 OR company_settings_version<>0${hasRouteGrouping?" OR route_grouping_policy<>'nearest_extension'":''}`);
        assert.equal(configuredLocations.rows[0].count,0,'E2E migration rollback is attempted only before any operator setting exists');
        const locationDown=runMigrationSync('down');
        assert.notEqual(locationDown.status,0,'E2E migration runner refuses destructive rollback even when the additive location fields are empty');
        assert.match(locationDown.stderr,/Uso: node backend\/postgres\/migrate\.js/u,'rollback denial is the runner guard, not an SQL failure');
        const stillLatest=await migrationClient.query(`SELECT migration_id FROM rotamoto.schema_migrations ORDER BY migration_id DESC LIMIT 1`);
        assert.equal(stillLatest.rows[0].migration_id,appliedLedger.rows[0].migration_id,'blocked rollback leaves the E2E schema at the approved latest migration');
      } else if (['0028_external_account_secret_least_privilege','0029_logistics_human_decisions','0030_logistics_decision_stale_approval','0031_logistics_decision_worker_projection','0032_logistics_route_origin_settings',
        '0035_marketplace_runtime','0036_marketplace_lifecycle_hardening','0037_marketplace_worker_secret_boundary','0038_marketplace_resolver_lifecycle_grants'].includes(appliedLedger.rows[0]?.migration_id)) {
        assert.match(getMigrations().at(-1).down, /rollback bloqueado/u, 'provider integration data migrations explicitly block rollback');
        const blockedDown = runMigrationSync('down');
        assert.notEqual(blockedDown.status,0,'approved provider/decision persistence rollback stays blocked');
        const stillLatest = await migrationClient.query(`SELECT migration_id FROM rotamoto.schema_migrations ORDER BY migration_id DESC LIMIT 1`);
        assert.equal(stillLatest.rows[0].migration_id, appliedLedger.rows[0].migration_id, 'blocked rollback preserves approved schema');
      } else {
      const bindingDown = runMigrationSync('down');
      assert.equal(bindingDown.status,0,'empty additive driver binding migration can be rolled back safely');
      assert.match(bindingDown.stdout,/revertida 0013_membership_driver_binding/);
      const bindingReapplied=runMigrationSync('up');
      assert.equal(bindingReapplied.status,0,'driver binding migration reapplies after an empty rollback');
      const bindingDownForLifecycle=runMigrationSync('down');
      assert.equal(bindingDownForLifecycle.status,0,'empty driver binding is removed before testing the preceding migration rollback');
      assert.match(bindingDownForLifecycle.stdout,/revertida 0013_membership_driver_binding/);
      const reversibleDown = runMigrationSync('down');
      assert.equal(reversibleDown.status,0,'identity lifecycle migration has a safe reversible down');
      assert.match(reversibleDown.stdout,/revertida 0012_identity_rbac_lifecycle/);
      const lifecycleRevoked=await runtimeClient.query(`SELECT
        has_column_privilege(current_user,'rotamoto.roles','display_name','UPDATE') AS role_name_update,
        has_table_privilege(current_user,'rotamoto.role_permissions','DELETE') AS role_permission_delete`);
      assert.deepEqual(lifecycleRevoked.rows[0], { role_name_update: false, role_permission_delete: false },
        'down migration removes additive role-management privileges');
      const lifecycleReapplied=runMigrationSync('up');
      assert.equal(lifecycleReapplied.status,0,'identity lifecycle migration reapplies cleanly');
      const stillThere=await tenantQuery(client,rollbackGuardId,'SELECT id FROM rotamoto.companies WHERE id=$1',[rollbackGuardId]);
      assert.equal(stillThere.rowCount,1,'schema-only rollback preserves tenant data');
      const lifecycleRollbackAgain = runMigrationSync('down');
      assert.equal(lifecycleRollbackAgain.status,0,'empty driver binding rolls back after the lifecycle migration is reapplied');
      assert.match(lifecycleRollbackAgain.stdout,/revertida 0013_membership_driver_binding/);
      const lifecycleRollbackSecond = runMigrationSync('down');
      assert.equal(lifecycleRollbackSecond.status,0,'identity lifecycle grants roll back safely a second time');
      assert.match(lifecycleRollbackSecond.stdout,/revertida 0012_identity_rbac_lifecycle/);
      const previousGrantDown = runMigrationSync('down');
      assert.equal(previousGrantDown.status,0,'runtime integration read grant rolls back safely');
      assert.match(previousGrantDown.stdout,/revertida 0011_runtime_integration_read/);
      const runtimeReadRevoked=await runtimeClient.query("SELECT has_table_privilege(current_user,'rotamoto.integrations','SELECT') AS can_read");
      assert.equal(runtimeReadRevoked.rows[0].can_read,false,'down migration revokes the additive integration read privilege');
      const routeGrantDown=runMigrationSync('down');
      assert.equal(routeGrantDown.status,0,'previous route validation grant rolls back safely');
      assert.match(routeGrantDown.stdout,/revertida 0010_route_validation_runtime_grant/);
      const constraintDown=runMigrationSync('down');
      assert.equal(constraintDown.status,0,'domain constraints and index roll back without deleting data');
      const guardedDown = runMigrationSync('down');
      assert.notEqual(guardedDown.status, 0, 'foundation rollback remains guarded');
      assert.match(guardedDown.stderr, /(P0001|42501)/, 'migration runner reports the guarded rollback failure without row contents');
      const preserved = await tenantQuery(client, rollbackGuardId, `SELECT id FROM rotamoto.companies WHERE id=$1`, [rollbackGuardId]);
      assert.equal(preserved.rowCount, 1, 'rollback guard preserves existing rows');
      const restored=runMigrationSync('up');
      assert.equal(restored.status,0,'full schema is restored after rollback guard verification');
      }
    } finally {
      await client.query(`DELETE FROM rotamoto.provisioning_requests WHERE idempotency_key_digest=$1`, [rollbackGuardDigest]);
      await tenantQuery(client, rollbackGuardId, `DELETE FROM rotamoto.memberships WHERE id=$1`, [rollbackGuardMembershipId]);
      await tenantQuery(client, rollbackGuardId, `DELETE FROM rotamoto.roles WHERE id=$1`, [rollbackGuardRoleId]);
      await tenantQuery(client, rollbackGuardId, `DELETE FROM rotamoto.users WHERE id=$1`, [rollbackGuardUserId]);
      await tenantQuery(client, rollbackGuardId, `DELETE FROM rotamoto.companies WHERE id=$1`, [rollbackGuardId]);
    }
    console.log('PostgreSQL migrations and default-deny RLS tests: OK');
  } finally {
    await client.end();
    await runtimeClient.end();
    await migrationClient.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
