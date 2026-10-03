'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
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
    const child = spawn(process.execPath, [path.join(__dirname, '../backend/postgres/migrate.js'), command], {
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

async function main() {
  if (!process.env.DATABASE_URL || !process.env.MIGRATOR_DATABASE_URL) {
    throw new Error('Defina DATABASE_URL (rotamoto_app) e MIGRATOR_DATABASE_URL (rotamoto_migrator) via pgpass.');
  }
  const runtimeUrl = new URL(process.env.DATABASE_URL);
  const migratorUrl = new URL(process.env.MIGRATOR_DATABASE_URL);
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

  const client = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  const runtimeClient = new Client({ connectionString: process.env.DATABASE_URL });
  const migrationClient = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
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
    const ownership = await migrationClient.query(`SELECT
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','S','v','m')
         AND pg_get_userbyid(c.relowner)='rotamoto_migrator') AS owned_relations,
      (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='rotamoto' AND pg_get_userbyid(p.proowner)='rotamoto_migrator') AS owned_routines,
      (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'
         AND pg_get_userbyid(c.relowner)='rotamoto_migrator') AS migrator_ledger,
      (SELECT count(*)::int FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto'
         AND c.relrowsecurity AND c.relforcerowsecurity) AS forced_policies,
      NOT EXISTS (SELECT 1 FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclrole='rotamoto_migrator'::regrole AND d.defaclobjtype='f'
          AND a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute_default`);
    assert.equal(ownership.rows[0].owned_relations, 18);
    assert.equal(ownership.rows[0].owned_routines, 2);
    assert.equal(ownership.rows[0].migrator_ledger, 1);
    assert.equal(ownership.rows[0].forced_policies, 10);
    assert.equal(ownership.rows[0].no_public_execute_default, true,
      'future migrator functions do not receive PUBLIC EXECUTE by default');
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
        await client.query(item.up.replaceAll('rotamoto', cleanSchema));
      }
      const cleanTables = await client.query('SELECT count(*)::int AS count FROM pg_tables WHERE schemaname=$1', [cleanSchema]);
      assert.equal(cleanTables.rows[0].count, 17, 'all domain tables install into an empty schema');
      const cleanRls = await client.query(`SELECT count(*)::int AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relrowsecurity AND c.relforcerowsecurity`, [cleanSchema]);
      assert.equal(cleanRls.rows[0].count, 10, 'fresh schema has all forced tenant RLS policies');
      const cleanForeignKeys = await client.query(`SELECT count(*)::int AS count FROM pg_constraint c
        JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype='f'`, [cleanSchema]);
      assert.equal(cleanForeignKeys.rows[0].count, 25, 'fresh schema installs all expected foreign keys');
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
      'local_id_maps','audit_log','sync_inbox','sync_outbox','provisioning_requests','identity_tokens'
    ]));
    const rls = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relkind='r' AND c.relname <> 'schema_migrations'
    `);
    const tenantTables = rls.rows.filter(row => row.relrowsecurity);
    assert.equal(tenantTables.length, 10);
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
      const rollback = spawnSync(process.execPath, [path.join(__dirname, '../backend/postgres/migrate.js'), 'down'], {
        env: process.env, encoding: 'utf8', timeout: 10000
      });
      assert.notEqual(rollback.status, 0, 'application role cannot run a destructive down migration');
      assert.match(rollback.stderr, /(P0001|42501)/, 'migration runner reports the guarded rollback failure without row contents');
      const preserved = await tenantQuery(client, rollbackGuardId, `SELECT id FROM rotamoto.companies WHERE id=$1`, [rollbackGuardId]);
      assert.equal(preserved.rowCount, 1, 'rollback guard preserves existing rows');
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
