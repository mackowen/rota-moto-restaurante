'use strict';

// Security regression against the real E2E database and the production runtime
// role. Fixtures are unique, tenant-scoped and removed in finally.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createE2eClients, assertConnectedIdentity } = require('./e2e-support/guards');

if (process.env.NODE_ENV !== 'test') throw new Error('Tenant RLS E2E exige NODE_ENV=test.');

const { runtime, migrator } = createE2eClients();
const tenantIds = [crypto.randomUUID(), crypto.randomUUID()];
const roleIds = [crypto.randomUUID(), crypto.randomUUID()];
const fixtureNames = tenantIds.map(id => `__campaign_0117_security_${id}`);

async function transaction(client, operation) {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function setTenant(client, id) {
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [id]);
}

async function main() {
  const created = [];
  try {
    await Promise.all([runtime.connect(), migrator.connect()]);
    await Promise.all([
      assertConnectedIdentity(runtime, { database: 'rotamoto_e2e', role: 'rotamoto_app' }),
      assertConnectedIdentity(migrator, { database: 'rotamoto_e2e', role: 'rotamoto_migrator' })
    ]);

    const relations = (await migrator.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='rotamoto' AND p.tablename=c.relname) policy_count,
        EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='company_id'
          AND a.attnum>0 AND NOT a.attisdropped) has_company_id,
        EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='id'
          AND a.attnum>0 AND NOT a.attisdropped) has_id
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows;
    assert.equal(relations.length, 45, 'the audit baseline is 45 application tables');
    const expectedWithoutRls = new Set(['credentials','identity_tokens','marketplace_account_routes',
      'permissions','provisioning_requests','recovery_tokens','schema_migrations','sessions','users']);
    assert.deepEqual(new Set(relations.filter(row => !row.relrowsecurity).map(row => row.relname)), expectedWithoutRls);
    assert(relations.filter(row => row.relrowsecurity).every(row => row.relforcerowsecurity),
      'every RLS table must also FORCE RLS');
    assert.equal(relations.filter(row => row.relrowsecurity).length, 36);

    const policies = (await migrator.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
      FROM pg_policies WHERE schemaname='rotamoto' ORDER BY tablename,policyname`)).rows;
    assert.equal(policies.length, 36, 'each RLS table has one tenant policy');
    for (const relation of relations.filter(row => row.relrowsecurity)) {
      const tablePolicies = policies.filter(policy => policy.tablename === relation.relname);
      assert.equal(tablePolicies.length, 1, `${relation.relname} has exactly one policy`);
      const policy = tablePolicies[0];
      assert.equal(policy.policyname, 'tenant_isolation');
      assert.equal(policy.permissive, 'PERMISSIVE');
      assert.equal(policy.roles, '{public}');
      assert.equal(policy.cmd, 'ALL');
      const scopeColumn = relation.has_company_id ? 'company_id' : 'id';
      assert.match(policy.qual, new RegExp(`${scopeColumn} = rotamoto\\.current_tenant_id\\(\\)`));
      assert.match(policy.with_check, new RegExp(`${scopeColumn} = rotamoto\\.current_tenant_id\\(\\)`));
    }

    const roleAudit = (await migrator.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,
        rolreplication,rolbypassrls,rolinherit FROM pg_roles
      WHERE rolname IN ('rotamoto_app','rotamoto_migrator','rotamoto_provider_worker','rotamoto_provider_resolver')
      ORDER BY rolname`)).rows;
    assert.equal(roleAudit.length, 4);
    assert(roleAudit.every(role => !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole &&
      !role.rolreplication && !role.rolbypassrls), 'runtime and migration roles have no bypass privileges');
    assert.equal((await migrator.query(`SELECT has_table_privilege('rotamoto_app',
      'rotamoto.marketplace_account_routes','SELECT') AS can_read,
      has_table_privilege('rotamoto_app','rotamoto.marketplace_account_routes','INSERT') AS can_insert,
      has_table_privilege('rotamoto_provider_worker','rotamoto.marketplace_account_routes','SELECT') AS worker_can_read`))
      .rows[0].can_read, false);
    const internalAccess = (await migrator.query(`SELECT
      has_table_privilege('rotamoto_app','rotamoto.marketplace_account_routes','INSERT') AS app_insert,
      has_table_privilege('rotamoto_provider_worker','rotamoto.marketplace_account_routes','SELECT') AS worker_select`)).rows[0];
    assert.deepEqual(internalAccess, { app_insert: false, worker_select: false });

    for (let index = 0; index < tenantIds.length; index += 1) {
      await transaction(migrator, async () => {
        await setTenant(migrator, tenantIds[index]);
        await migrator.query('INSERT INTO rotamoto.companies(id,name,status) VALUES($1,$2,\'active\')',
          [tenantIds[index], fixtureNames[index]]);
        await migrator.query(`INSERT INTO rotamoto.roles(id,company_id,role_key,display_name)
          VALUES($1,$2,'audit','Security fixture')`, [roleIds[index], tenantIds[index]]);
        await migrator.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
          VALUES($1,$2,'orders.read',1)`, [tenantIds[index], roleIds[index]]);
      });
      created.push(index);
    }

    await transaction(runtime, async () => {
      await setTenant(runtime, tenantIds[0]);
      const visible = await runtime.query('SELECT id::text FROM rotamoto.companies WHERE id=ANY($1::uuid[]) ORDER BY id',
        [tenantIds]);
      assert.deepEqual(visible.rows.map(row => row.id), [tenantIds[0]]);
      const scopedPermission = await runtime.query('SELECT company_id::text FROM rotamoto.role_permissions WHERE company_id=ANY($1::uuid[])',
        [tenantIds]);
      assert.deepEqual(scopedPermission.rows.map(row => row.company_id), [tenantIds[0]]);

      await runtime.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
        VALUES($1,$2,'sync.pull',1)`, [tenantIds[0], roleIds[0]]);
      const positiveUpdate = await runtime.query(`UPDATE rotamoto.companies SET name=$2
        WHERE id=$1`, [tenantIds[0], `${fixtureNames[0]}_updated`]);
      assert.equal(positiveUpdate.rowCount, 1);
      const positiveDelete = await runtime.query(`DELETE FROM rotamoto.role_permissions
        WHERE company_id=$1 AND role_id=$2 AND permission_key='sync.pull'`, [tenantIds[0], roleIds[0]]);
      assert.equal(positiveDelete.rowCount, 1);
    });

    await transaction(runtime, async () => {
      await setTenant(runtime, tenantIds[0]);
      await assert.rejects(runtime.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
        VALUES($1,$2,'sync.pull',1)`, [tenantIds[1], roleIds[1]]), error => error.code === '42501');
    });
    await transaction(runtime, async () => {
      await setTenant(runtime, tenantIds[0]);
      const result = await runtime.query('UPDATE rotamoto.companies SET name=$2 WHERE id=$1',
        [tenantIds[1], `${fixtureNames[1]}_tampered`]);
      assert.equal(result.rowCount, 0, 'cross-tenant UPDATE cannot see or change the row');
      const deleted = await runtime.query('DELETE FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2',
        [tenantIds[1], roleIds[1]]);
      assert.equal(deleted.rowCount, 0, 'cross-tenant DELETE cannot see or remove the row');
    });
    await transaction(runtime, async () => {
      const current = await runtime.query('SELECT rotamoto.current_tenant_id()::text AS tenant');
      assert.equal(current.rows[0].tenant, null, 'tenant context starts absent on a fresh runtime session');
      const result = await runtime.query('SELECT id FROM rotamoto.companies WHERE id=ANY($1::uuid[])', [tenantIds]);
      assert.equal(result.rowCount, 0, 'missing tenant context fails closed');
    });
    await transaction(runtime, async () => {
      await setTenant(runtime, 'not-a-uuid');
      await assert.rejects(runtime.query('SELECT id FROM rotamoto.companies'), error => error.code === '22P02');
    });
    await transaction(runtime, async () => {
      await assert.rejects(runtime.query('SELECT company_id FROM rotamoto.marketplace_account_routes'),
        error => error.code === '42501');
    });

    console.log('Tenant RLS E2E: PASS (45-table catalog, 36 forced tenant policies, two-tenant SELECT/INSERT/UPDATE/DELETE, positive writes, missing/invalid context, runtime/internal ACLs)');
  } finally {
    if (migrator.readyForQuery) {
      for (const index of created) {
        await transaction(migrator, async () => {
          await setTenant(migrator, tenantIds[index]);
          await migrator.query('DELETE FROM rotamoto.role_permissions WHERE company_id=$1', [tenantIds[index]]);
          await migrator.query('DELETE FROM rotamoto.roles WHERE company_id=$1', [tenantIds[index]]);
          await migrator.query('DELETE FROM rotamoto.companies WHERE id=$1', [tenantIds[index]]);
        }).catch(() => {});
      }
    }
    await Promise.all([runtime.end().catch(() => {}), migrator.end().catch(() => {})]);
  }
}

main().catch(error => {
  console.error(`Tenant RLS E2E failed: ${error.message}`);
  process.exitCode = 1;
});
