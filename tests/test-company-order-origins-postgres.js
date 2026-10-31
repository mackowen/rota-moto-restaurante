'use strict';

const assert = require('node:assert/strict');
const { createClient, connectionTarget } = require('../backend/postgres/connection');
const { createAdminRepository } = require('../backend/admin/repository');

const databaseUrl = process.env.E2E_RUNTIME_DATABASE_URL;
assert(databaseUrl, 'E2E_RUNTIME_DATABASE_URL is required');
assert.equal(connectionTarget(databaseUrl).database, 'rotamoto_e2e', 'writes are restricted to the existing E2E database');
assert.equal(connectionTarget(databaseUrl).user, 'rotamoto_app', 'exercise the least-privilege runtime role');
const companyId = '01a14b34-2f79-7b57-a29d-9535574e3806';
const actorId = '3d776f10-42a2-4abf-844d-9df769103c52';
const repository = createAdminRepository();

async function main() {
  const client = createClient({ connectionString: databaseUrl, application_name: 'rotamoto-order-origins-e2e-test' });
  await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database,current_user AS role');
    assert.deepEqual(identity.rows[0], { database: 'rotamoto_e2e', role: 'rotamoto_app' });
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    const original = await repository.companyOrderOrigins(client, companyId);
    await assert.rejects(repository.companyOrderOrigins(client, '10000000-0000-4000-8000-000000000001'),
      error => error.code === 'NOT_FOUND', 'RLS does not expose another tenant through the same runtime role');
    const changed = [...original.origins, { id: 'qa_order_origin', name: 'Origem QA transacional', active: true }];
    const saved = await repository.updateCompanyOrderOrigins(client, { company_id: companyId, user_id: actorId },
      { expectedVersion: original.version, origins: changed });
    assert.equal(saved.version, original.version + 1);
    assert.deepEqual(saved.origins, changed);
    const readback = await repository.companyOrderOrigins(client, companyId);
    assert.equal(readback.version, saved.version);
    assert.deepEqual(readback.origins, changed);

    const renamed = changed.map(item => item.id === 'qa_order_origin' ? { ...item, name: 'Origem QA atualizada', active: false } : item);
    const secondSave = await repository.updateCompanyOrderOrigins(client, { company_id: companyId, user_id: actorId },
      { expectedVersion: saved.version, origins: renamed });
    assert.equal(secondSave.version, saved.version + 1, 'consecutive edits can persist against the updated revision');
    assert.deepEqual((await repository.companyOrderOrigins(client, companyId)).origins, renamed);
    assert.equal((await repository.companyOrderOrigins(client, companyId)).origins.find(item => item.id === 'qa_order_origin').active,false,
      'deactivation preserves the historical identifier instead of deleting it');

    await assert.rejects(repository.updateCompanyOrderOrigins(client, { company_id: companyId, user_id: actorId },
      { expectedVersion: saved.version, origins: changed }), error => error.code === 'REVISION_CONFLICT');
    assert.deepEqual((await repository.companyOrderOrigins(client, companyId)).origins, renamed,
      'a stale writer cannot overwrite the current canonical state');

    await assert.rejects(repository.updateCompanyOrderOrigins(client, { company_id: companyId, user_id: actorId },
      { expectedVersion: secondSave.version, origins: original.origins }), error => error.code === 'INVALID_INPUT',
      'removing an existing origin is rejected to retain historical references');
    await client.query('ROLLBACK');
    process.stdout.write('E2E order origins tenant RLS, write/readback, consecutive revisions, stale conflict, history-preserving deactivation rule and rollback: PASS\n');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
