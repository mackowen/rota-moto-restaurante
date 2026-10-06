'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { e2eMigrationConnectionString, getMigrations } = require('../backend/postgres/migrate');

function runtimeConnectionString() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Este teste exige NODE_ENV=test.');
  const value = process.env.E2E_RUNTIME_DATABASE_URL;
  if (!value) throw new Error('E2E_RUNTIME_DATABASE_URL não configurada.');
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== 'rotamoto_app' || parsed.password ||
      parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' || parsed.pathname !== '/rotamoto_e2e' || parsed.search || parsed.hash)
    throw new Error('O teste de privilégio aceita somente rotamoto_app em rotamoto_e2e, sem senha na URL.');
  return value;
}

function psqlRuntime(sql) {
  return spawnSync('psql', ['-X','-w','-q','-h','127.0.0.1','-p','5432','-U','rotamoto_app','-d','rotamoto_e2e',
    '-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-A','-t','-c',sql],
  { encoding: 'utf8', timeout: 10000 });
}

async function main() {
  const migrationUrl = e2eMigrationConnectionString(process.env);
  runtimeConnectionString();
  const admin = new Client({ connectionString: migrationUrl, application_name: 'rotamoto-0019-privilege-catalog-test' });
  await admin.connect();
  try {
    const migration = getMigrations().find(item => item.id === '0019_logistics_provider_secret_least_privilege');
    assert.ok(migration, '0019 migration is present in the local migration set');
    const state = await admin.query(`SELECT current_user AS role,current_database() AS database,
      (SELECT checksum_sha256 FROM rotamoto.schema_migrations WHERE migration_id=$1) AS checksum,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='rotamoto_app') AS runtime_elevated,
      has_table_privilege('rotamoto_app','rotamoto.logistics_providers','SELECT') AS table_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','provider_id','SELECT') AS provider_id_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','configuration','SELECT') AS configuration_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','secret_ref','SELECT') AS secret_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','secret_ref','UPDATE') AS secret_update`,
    ['0019_logistics_provider_secret_least_privilege']);
    assert.deepEqual(state.rows[0], { role: 'rotamoto_migrator', database: 'rotamoto_e2e', checksum: migration.checksum,
      runtime_elevated: false,
      table_select: false, provider_id_select: true, configuration_select: true, secret_select: false, secret_update: false });
    const identity = psqlRuntime('SELECT current_user||\':\'||current_database()');
    assert.equal(identity.status, 0, 'psql -w authenticates runtime using the locally provisioned credential');
    assert.equal(identity.stdout.trim(), 'rotamoto_app:rotamoto_e2e');
    const tenant = crypto.randomUUID();
    const allowed = psqlRuntime(`BEGIN; SET LOCAL app.tenant_id='${tenant}'; SELECT company_id,provider_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at FROM rotamoto.logistics_providers LIMIT 0; COMMIT;`);
    assert.equal(allowed.status, 0, 'runtime executes the operational provider projection in tenant context');
    const deniedSelect = psqlRuntime(`BEGIN; SET LOCAL app.tenant_id='${tenant}'; SELECT secret_ref FROM rotamoto.logistics_providers LIMIT 0; COMMIT;`);
    assert.notEqual(deniedSelect.status, 0, 'runtime cannot select secret_ref');
    assert.match(deniedSelect.stderr, /42501/u, 'secret_ref SELECT fails specifically for insufficient privilege');
    const deniedUpdate = psqlRuntime(`BEGIN; SET LOCAL app.tenant_id='${tenant}'; UPDATE rotamoto.logistics_providers SET secret_ref=NULL WHERE false; COMMIT;`);
    assert.notEqual(deniedUpdate.status, 0, 'runtime cannot update secret_ref');
    assert.match(deniedUpdate.stderr, /42501/u, 'secret_ref UPDATE fails specifically for insufficient privilege');
    console.log('0019 E2E runtime least-privilege checks: PASS (operational projection allowed; secret_ref SELECT/UPDATE denied)');
  } finally {
    await admin.end();
  }
}

main().catch(error => {
  if (error?.code === '42501') console.error('0019 privilege test: expected access denial observed');
  else console.error(`0019 privilege test failed: ${error.message}`);
  process.exitCode = 1;
});
