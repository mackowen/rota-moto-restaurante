'use strict';

// Security regression against the isolated E2E database and runtime role.
// Synthetic fixtures are manifested, isolated by generated IDs and removed at teardown.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createE2eClients, assertConnectedIdentity } = require('./e2e-support/guards');
const { createFixtureManifest } = require('./e2e-support/fixture-manifest');

if (process.env.NODE_ENV !== 'test') throw new Error('Tenant RLS E2E exige NODE_ENV=test.');

const clients = createE2eClients();
const { runtime, migrator } = clients;
const database = clients.database || 'rotamoto_e2e';
const tenantIds = [crypto.randomUUID(), crypto.randomUUID()];
const roleIds = [crypto.randomUUID(), crypto.randomUUID()];
const campaign = process.env.ROTAMOTO_E2E_CAMPAIGN || '0160';
const fixtureNames = tenantIds.map(id => `__campaign_${campaign}_tenant_security_${id}`);

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

async function removeSyntheticTenant(client, index) {
  const companyId = tenantIds[index], roleId = roleIds[index];
  await transaction(client, async () => {
    await setTenant(client, companyId);
    const company = await client.query('SELECT name FROM rotamoto.companies WHERE id=$1 FOR UPDATE', [companyId]);
    if (!company.rowCount) return;
    const originalName = fixtureNames[index];
    assert([originalName, `${originalName}_updated`].includes(company.rows[0].name),
      'cleanup may remove only the uniquely named synthetic tenant created by this test');
    const permissions = await client.query('DELETE FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2', [companyId, roleId]);
    assert.equal(permissions.rowCount, 1, 'cleanup removes only the synthetic role permission');
    const role = await client.query("DELETE FROM rotamoto.roles WHERE id=$1 AND company_id=$2 AND role_key='audit' AND display_name='Security fixture'", [roleId, companyId]);
    assert.equal(role.rowCount, 1, 'cleanup removes only the synthetic role');
    const removed = await client.query('DELETE FROM rotamoto.companies WHERE id=$1', [companyId]);
    assert.equal(removed.rowCount, 1, 'cleanup removes only the synthetic company created by this test');
  });
  await transaction(client, async () => {
    await setTenant(client, companyId);
    const residual = await client.query(`SELECT
      (SELECT count(*)::int FROM rotamoto.companies WHERE id=$1) AS companies,
      (SELECT count(*)::int FROM rotamoto.roles WHERE id=$2 AND company_id=$1) AS roles,
      (SELECT count(*)::int FROM rotamoto.role_permissions WHERE role_id=$2 AND company_id=$1) AS permissions`, [companyId, roleId]);
    assert.deepEqual(residual.rows[0], { companies: 0, roles: 0, permissions: 0 }, 'synthetic tenant cleanup leaves no database rows');
  });
}

async function main() {
  const created = [];
  let completed = false;
  let cleanupComplete = true, cleanupError = null;
  const schemaOnly = process.env.ROTAMOTO_RLS_SCHEMA_ONLY === '1';
  const manifest = schemaOnly ? null : await createFixtureManifest({ campaign, evidence: [
    { kind: 'test', name: 'tenant-rls-isolation-e2e' },
    { kind: 'cleanup', reason: 'Generated synthetic identifiers are verified absent before setup and removed by exact ID after tests.' }
  ] });
  if (manifest) await manifest.update({ status: 'RUNNING', tenants: tenantIds.map(id => ({ id, counts: { companies: 1, roles: 1, role_permissions: 1 } })),
    records: { companies: tenantIds, roles: roleIds, schema: 'rotamoto' } });
  try {
    await Promise.all([runtime.connect(), migrator.connect()]);
    await Promise.all([
      assertConnectedIdentity(runtime, { database, role: 'rotamoto_app' }),
      assertConnectedIdentity(migrator, { database, role: 'rotamoto_migrator' })
    ]);

    const relations = (await migrator.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='rotamoto' AND p.tablename=c.relname) policy_count,
        EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='company_id'
          AND a.attnum>0 AND NOT a.attisdropped) has_company_id,
        EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='id'
          AND a.attnum>0 AND NOT a.attisdropped) has_id
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') ORDER BY c.relname`)).rows;
    assert.equal(relations.length, 55, 'the audit baseline includes the financial ledger and platform administration migrations through 0061');
    const expectedWithoutRls = new Set(['credentials','identity_tokens','marketplace_account_routes',
      'bootstrap_authorizations','installation_bootstrap','mfa_recovery_challenges','platform_administrators',
      'platform_admin_bootstrap_latch','platform_admin_audit_log','permissions',
      'provisioning_requests','recovery_tokens','schema_migrations','sessions','users']);
    assert.deepEqual(new Set(relations.filter(row => !row.relrowsecurity).map(row => row.relname)), expectedWithoutRls);
    assert(relations.filter(row => row.relrowsecurity).every(row => row.relforcerowsecurity),
      'every RLS table must also FORCE RLS');
    assert.equal(relations.filter(row => row.relrowsecurity).length, 40);
    assert(relations.some(row => row.relname === 'financial_events' && row.relrowsecurity && row.relforcerowsecurity),
      'financial ledger rows remain protected by forced tenant RLS');

    const policies = (await migrator.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
      FROM pg_policies WHERE schemaname='rotamoto' ORDER BY tablename,policyname`)).rows;
    assert.equal(policies.length, 43, 'financial tenant policy remains alongside the three explicit platform-admin policies');
    for (const relation of relations.filter(row => row.relrowsecurity)) {
      const tablePolicies = policies.filter(policy => policy.tablename === relation.relname);
      if (relation.relname === 'marketplace_99food_rate_limits') {
        assert.equal(tablePolicies.length,1);
        const policy=tablePolicies[0];
        assert.equal(policy.policyname, 'marketplace_99food_rate_limits_owner_policy');
        assert.equal(policy.roles, '{rotamoto_migrator}');
        assert.equal(policy.cmd, 'ALL');
        assert.equal(policy.qual, 'true');
        assert.equal(policy.with_check, 'true');
        continue;
      }
      const platformPolicies = relation.relname==='companies'?['platform_admin_read_companies','platform_admin_update_companies']:
        relation.relname==='memberships'?['platform_admin_read_memberships']:[];
      assert.equal(tablePolicies.length, 1+platformPolicies.length, `${relation.relname} has its tenant policy and only the explicit platform policies`);
      const policy = tablePolicies.find(item=>item.policyname==='tenant_isolation');
      assert.ok(policy,`${relation.relname} retains tenant isolation`);
      assert.equal(policy.permissive, 'PERMISSIVE');
      assert.equal(policy.roles, '{public}');
      assert.equal(policy.cmd, 'ALL');
      const scopeColumn = relation.has_company_id ? 'company_id' : 'id';
      assert.match(policy.qual, new RegExp(`${scopeColumn} = rotamoto\\.current_tenant_id\\(\\)`));
      assert.match(policy.with_check, new RegExp(`${scopeColumn} = rotamoto\\.current_tenant_id\\(\\)`));
      for(const name of platformPolicies){const globalPolicy=tablePolicies.find(item=>item.policyname===name);assert.ok(globalPolicy,`${name} exists`);assert.match(globalPolicy.qual,/platform_admin_context_is_active/u);if(name==='platform_admin_update_companies')assert.match(globalPolicy.with_check,/platform_admin_context_is_active/u)}
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
    const bootstrapRuntimeAccess=(await migrator.query(`SELECT
      has_schema_privilege('rotamoto_app','rotamoto','USAGE') AS schema_usage,
      has_table_privilege('rotamoto_app','rotamoto.provisioning_requests','SELECT') AS provisioning_read,
      has_table_privilege('rotamoto_app','rotamoto.provisioning_requests','INSERT') AS provisioning_insert,
      has_table_privilege('rotamoto_app','rotamoto.provisioning_requests','UPDATE') AS provisioning_update`)).rows[0];
    assert.deepEqual(bootstrapRuntimeAccess,{schema_usage:true,provisioning_read:true,provisioning_insert:true,provisioning_update:true},
      'fresh-install identity runtime grants match the least-privilege bootstrap contract');

    if (schemaOnly) {
      console.log('Tenant RLS schema audit: PASS (55-table catalog through migration 0063, 40 forced-RLS tables, financial-event tenant policy, platform policies and runtime/internal ACLs); data-plane fixtures skipped to preserve E2E state.');
      completed = true;
      return;
    }

    for (let index = 0; index < tenantIds.length; index += 1) {
      const collision = await migrator.query(`SELECT
        EXISTS(SELECT 1 FROM rotamoto.companies WHERE id=$1) AS company_exists,
        EXISTS(SELECT 1 FROM rotamoto.roles WHERE id=$2) AS role_exists`, [tenantIds[index], roleIds[index]]);
      assert.equal(collision.rows[0].company_exists || collision.rows[0].role_exists, false,
        'generated fixture identifiers must be absent before insertion');
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
      cleanupComplete = false;
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

    completed = true;
  } finally {
    if (created.length && !schemaOnly) {
      try {
        for (const index of created) await removeSyntheticTenant(migrator, index);
        cleanupComplete = true;
      } catch (error) { cleanupError = error; }
    }
    await Promise.all([runtime.end().catch(() => {}), migrator.end().catch(() => {})]);
    if (manifest) await manifest.update({ status: completed && cleanupComplete ? 'COMPLETED' : cleanupError ? 'RETAINED' : 'FAILED',
      databaseCommitted: Boolean(created.length && !cleanupComplete),
      retentionReason: cleanupError ? 'Cleanup of an exact synthetic fixture failed; inspect the manifest before any manual action.' : null,
      evidence: [{ kind: 'test_result', result: completed && cleanupComplete ? 'PASS_ROLLED_BACK' : cleanupError ? 'CLEANUP_FAILED' : 'FAILED_NO_RESIDUALS' }],
      lastError: cleanupError ? 'Exact synthetic tenant cleanup failed; no automatic broader cleanup was attempted.' : null,
      counts: { companies: cleanupComplete ? 0 : created.length, roles: cleanupComplete ? 0 : created.length, role_permissions: cleanupComplete ? 0 : created.length } });
    if (cleanupError) throw cleanupError;
  }
  if (completed && cleanupComplete && !schemaOnly) console.log('Tenant RLS E2E: PASS (55-table catalog through migration 0063, 40 forced-RLS tables, financial-event tenant policy, three explicit platform policies, two-tenant isolation, fresh-install identity runtime grants and runtime/internal ACLs; synthetic fixtures removed and absence verified)');
}

main().catch(error => {
  console.error(`Tenant RLS E2E failed: ${error.message}`);
  process.exitCode = 1;
});
