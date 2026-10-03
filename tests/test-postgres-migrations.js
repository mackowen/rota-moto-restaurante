'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const { Client } = require('pg');
const { assertChecksums, getMigrations } = require('../backend/postgres/migrate');

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

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Defina DATABASE_URL para o banco PostgreSQL de desenvolvimento configurado por pgpass; não use produção.');
  }
  const migration = getMigrations()[0];
  assert.equal(migration.id, '0001_identity_tenant_foundation');
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

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await assert.rejects(assertChecksums(client, [{ ...migration, checksum: '0'.repeat(64) }]),
      /Checksum divergente/, 'applied migration files cannot be edited silently');
    const tables = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'rotamoto' AND table_type = 'BASE TABLE'
    `);
    assert.deepEqual(new Set(tables.rows.map(row => row.table_name)), new Set([
      'schema_migrations','users','credentials','recovery_tokens','companies','permissions',
      'roles','role_permissions','memberships','sessions','integrations','external_accounts',
      'local_id_maps','audit_log','sync_inbox','sync_outbox'
    ]));
    const rls = await client.query(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relkind='r' AND c.relname <> 'schema_migrations'
    `);
    const tenantTables = rls.rows.filter(row => row.relrowsecurity);
    assert.equal(tenantTables.length, 10);
    assert(tenantTables.every(row => row.relforcerowsecurity), 'all tenant-scoped tables enforce RLS');
    const noTenant = await client.query(`SELECT count(*)::int AS count FROM rotamoto.companies`);
    assert.equal(noTenant.rows[0].count, 0, 'missing tenant context denies visibility');
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    await tenantQuery(client, tenantA, `INSERT INTO rotamoto.companies (id,name) VALUES ($1,'QA tenant A')`, [tenantA]);
    await tenantQuery(client, tenantB, `INSERT INTO rotamoto.companies (id,name) VALUES ($1,'QA tenant B')`, [tenantB]);
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantA]);
      const visible = await client.query(`SELECT id::text FROM rotamoto.companies ORDER BY id`);
      assert.deepEqual(visible.rows.map(row => row.id), [tenantA], 'tenant context reveals only the selected company');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantA]);
      await assert.rejects(client.query(`INSERT INTO rotamoto.companies (id,name) VALUES ($1,'cross-tenant')`, [tenantB]), /row-level security|policy/i, 'tenant context rejects cross-tenant writes');
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await tenantQuery(client, tenantA, `DELETE FROM rotamoto.companies WHERE id=$1`, [tenantA]);
      await tenantQuery(client, tenantB, `DELETE FROM rotamoto.companies WHERE id=$1`, [tenantB]);
    }
    const rollbackGuardId = crypto.randomUUID();
    await tenantQuery(client, rollbackGuardId, `INSERT INTO rotamoto.companies (id,name) VALUES ($1,'QA rollback guard')`, [rollbackGuardId]);
    try {
      const rollback = spawnSync(process.execPath, [path.join(__dirname, '../backend/postgres/migrate.js'), 'down'], {
        env: process.env, encoding: 'utf8', timeout: 10000
      });
      assert.notEqual(rollback.status, 0, 'application role cannot run a destructive down migration');
      assert.match(rollback.stderr, /(P0001|42501)/, 'migration runner reports the guarded rollback failure without row contents');
      const preserved = await tenantQuery(client, rollbackGuardId, `SELECT id FROM rotamoto.companies WHERE id=$1`, [rollbackGuardId]);
      assert.equal(preserved.rowCount, 1, 'rollback guard preserves existing rows');
    } finally {
      await tenantQuery(client, rollbackGuardId, `DELETE FROM rotamoto.companies WHERE id=$1`, [rollbackGuardId]);
    }
    console.log('PostgreSQL migrations and default-deny RLS tests: OK');
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
