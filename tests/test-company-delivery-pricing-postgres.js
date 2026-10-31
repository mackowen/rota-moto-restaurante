'use strict';

const assert = require('node:assert/strict');
const { createClient, connectionTarget } = require('../backend/postgres/connection');
const { createAdminRepository } = require('../backend/admin/repository');

const databaseUrl = process.env.E2E_RUNTIME_DATABASE_URL;
assert(databaseUrl, 'E2E_RUNTIME_DATABASE_URL is required');
const target = connectionTarget(databaseUrl);
assert.equal(target.database, 'rotamoto_e2e', 'writes are restricted to the existing E2E database');
assert.equal(target.user, 'rotamoto_app', 'exercise the same least-privilege role as the API');

const companyId = '01a14b34-2f79-7b57-a29d-9535574e3806';
const actorId = '3d776f10-42a2-4abf-844d-9df769103c52';
const repository = createAdminRepository();

async function main() {
  const client = createClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database, current_user AS role');
    assert.deepEqual(identity.rows[0], { database: 'rotamoto_e2e', role: 'rotamoto_app' });
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);

    const original = await repository.companyDeliveryPricing(client, companyId);
    assert.equal(original.configured, true, 'Chico has canonical pricing');
    const changed = structuredClone(original.settings);
    changed.perKm = Number((Number(changed.perKm) + 0.01).toFixed(2));

    const saved = await repository.updateCompanyDeliveryPricing(client,
      { company_id: companyId, user_id: actorId },
      { expectedVersion: original.version, settings: changed });
    assert.equal(saved.version, original.version + 1, 'current revision updates instead of false conflict');
    assert.deepEqual(saved.settings, changed);

    const readback = await repository.companyDeliveryPricing(client, companyId);
    assert.equal(readback.version, saved.version);
    assert.deepEqual(readback.settings, changed);

    await assert.rejects(
      repository.updateCompanyDeliveryPricing(client,
        { company_id: companyId, user_id: actorId },
        { expectedVersion: original.version, settings: original.settings }),
      error => error.code === 'REVISION_CONFLICT',
      'stale revision remains rejected');

    const afterConflict = await repository.companyDeliveryPricing(client, companyId);
    assert.equal(afterConflict.version, saved.version, 'stale update did not overwrite current revision');
    assert.deepEqual(afterConflict.settings, changed);
    await client.query('ROLLBACK');
    process.stdout.write('E2E tenant-RLS pricing update/readback/stale-conflict/rollback: PASS\n');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
