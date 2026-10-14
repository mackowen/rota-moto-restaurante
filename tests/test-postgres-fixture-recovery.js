'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createE2eClients, assertConnectedIdentity } = require('./e2e-support/guards');
const { markFixtureInterrupted, readFixtureManifest, resumeFixtureManifest, updateFixtureManifest } = require('./e2e-support/fixture-manifest');

async function main() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Fixture recovery E2E requires NODE_ENV=test.');
  const clients = createE2eClients(process.env); // Rejects every target except the dedicated loopback E2E database.
  const lifecyclePath = path.resolve(__dirname, 'e2e-support/fixture-lifecycle.js');
  const childSource = `const {runFixtureLifecycle}=require(${JSON.stringify(lifecyclePath)});` +
    `runFixtureLifecycle({env:process.env,businessFixture:false,independentRequestTransactions:true,retainIndependentFixture:true,` +
    `exercise:async fixture=>{await fixture.enableIndependentRequestTransactions();` +
    `process.stdout.write(JSON.stringify(fixture.fixtureManifest)+'\\n',()=>process.exit(0));}})` +
    `.catch(()=>{process.exitCode=2});`;
  const child = spawn(process.execPath, ['-e', childSource], { env: { ...process.env, ROTAMOTO_E2E_CAMPAIGN: '0150' },
    stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture recovery child timed out.')); }, 180000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
  assert.equal(exit.code, 0, `fixture process should terminate abruptly after database commit (${exit.signal || exit.code})`);
  const metadata = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.match(metadata.runId, /^[0-9a-f-]{36}$/iu);
  let manifest = await readFixtureManifest(metadata.file);
  assert.equal(manifest.status, 'RUNNING', 'abrupt process exit leaves a recoverable in-progress manifest');
  assert.equal(manifest.databaseCommitted, true, 'manifest durably records the pre-crash commit');
  assert.equal(manifest.tenants.length, 1);
  const tenantId = manifest.tenants[0].id;
  const userId = manifest.tenants[0].userIds[0];

  const recovered = await markFixtureInterrupted({ runId: metadata.runId, directory: path.dirname(metadata.file),
    reason: 'E2E child exited immediately after the independent-session fixture commit.' });
  assert.equal(recovered.status, 'INTERRUPTED');
  assert.equal(recovered.databaseCommitted, true);
  assert.equal((await markFixtureInterrupted({ runId: metadata.runId, directory: path.dirname(metadata.file) })).status, 'INTERRUPTED',
    'recovery replay is idempotent');
  assert.equal((await resumeFixtureManifest({ runId: metadata.runId, directory: path.dirname(metadata.file) })).status, 'RUNNING',
    'an interrupted manifest resumes only for inventory reconciliation');

  const { migrator } = clients;
  await migrator.connect();
  try {
    const identity = await assertConnectedIdentity(migrator, { role: 'rotamoto_migrator', database: 'rotamoto_e2e' });
    assert.equal(identity.database, 'rotamoto_e2e');
    await migrator.query('BEGIN READ ONLY');
    try {
      await migrator.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const counts = await migrator.query(`SELECT
        (SELECT count(*)::int FROM rotamoto.companies WHERE id=$1) AS companies,
        (SELECT count(*)::int FROM rotamoto.users WHERE id=$2) AS users,
        (SELECT count(*)::int FROM rotamoto.credentials WHERE user_id=$2) AS auth_records,
        (SELECT count(*)::int FROM rotamoto.memberships WHERE company_id=$1) AS memberships,
        (SELECT count(*)::int FROM rotamoto.sessions WHERE user_id=$2) AS sessions,
        (SELECT count(*)::int FROM rotamoto.audit_log WHERE company_id=$1) AS audit_rows`, [tenantId, userId]);
      assert.equal(counts.rows[0].companies, 1);
      assert.equal(counts.rows[0].users, 1);
      assert.equal(counts.rows[0].auth_records, 1);
      assert.equal(counts.rows[0].memberships, 1);
      assert(counts.rows[0].sessions >= 1);
      manifest = await readFixtureManifest(metadata.file);
      assert.equal(manifest.status, 'RUNNING');
      await updateFixtureManifest({ runId: metadata.runId, directory: path.dirname(metadata.file),
        status: 'RETAINED', retentionReason: 'Read-only reconciliation completed; database rows and audit history are retained.',
        tenantDatabaseCounts: [{ tenantId, counts: counts.rows[0] }] });
      const finalManifest = await readFixtureManifest(metadata.file);
      assert.deepEqual(finalManifest.history.map(event => event.status), ['PREPARING', 'RUNNING', 'INTERRUPTED', 'RUNNING', 'RETAINED']);
      process.stdout.write(`PostgreSQL fixture recovery: PASS (rotamoto_e2e only; interrupted after commit; tenant rows retained; audit rows=${counts.rows[0].audit_rows}; no cleanup)\n`);
    } finally { await migrator.query('ROLLBACK'); }
  } finally { await migrator.end(); }
}

main().catch(error => { process.stderr.write(`PostgreSQL fixture recovery: FAIL (${error.message})\n`); process.exitCode = 1; });
