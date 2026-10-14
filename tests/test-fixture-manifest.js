'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createFixtureManifest, inventoryFixtureManifests, markFixtureInterrupted, resumeFixtureManifest, updateFixtureManifest } = require('./e2e-support/fixture-manifest');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-fixture-manifests-'));
  try {
    const completed = await createFixtureManifest({ campaign: '0150', directory });
    assert.equal((await JSON.parse(await fs.readFile(completed.file, 'utf8'))).status, 'PREPARING');
    await completed.update({ status: 'RUNNING', tenants: [{ id: 'tenant-a', userIds: ['user-a'],
      sessionIds: ['session-a'], counts: { companies: 1, users: 1, sessions: 1 } }],
      records: { companies: ['tenant-a'], users: ['user-a'], sessions: ['session-a'] } });
    await assert.rejects(markFixtureInterrupted({ runId: completed.runId, directory }), /still running/u,
      'recovery refuses to interrupt a live owner');
    await Promise.all([
      completed.update({ evidence: [{ kind: 'trace', path: '/tmp/trace-a' }] }),
      completed.update({ counts: { domain_records: 2, audit_log: 3 } })
    ]);
    await completed.update({ status: 'COMPLETED' });
    const view = await inventoryFixtureManifests({ directory });
    assert.equal(view.length, 1);
    assert.equal(view[0].counts.audit_log, 3);
    assert.equal(view[0].tenants[0].counts.sessions, 1);
    await assert.rejects(completed.update({ status: 'RUNNING' }), /Terminal fixture status/u);
    await assert.rejects(completed.update({ evidence: [{ token: 'must-not-serialize' }] }), /sensitive field/u);

    const interruptedId = 'b4c76c64-7f31-44eb-a771-16b17b502781';
    const modulePath = path.resolve(__dirname, 'e2e-support/fixture-manifest.js');
    const child = spawnSync(process.execPath, ['-e',
      `const {createFixtureManifest}=require(${JSON.stringify(modulePath)});` +
      `createFixtureManifest({campaign:'0150',directory:${JSON.stringify(directory)},runId:${JSON.stringify(interruptedId)}})` +
      `.then(m=>m.update({status:'RUNNING',databaseCommitted:true,retentionReason:'commit-before-crash'})).then(()=>process.exit(0));`],
    { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const recovered = await markFixtureInterrupted({ runId: interruptedId, directory, reason: 'child exited unexpectedly' });
    assert.equal(recovered.status, 'INTERRUPTED');
    assert.equal(recovered.databaseCommitted, true);
    assert.equal(recovered.retentionReason, 'commit-before-crash');
    assert.equal((await markFixtureInterrupted({ runId: interruptedId, directory })).status, 'INTERRUPTED',
      'interruption recovery is replay-safe');
    assert.equal((await resumeFixtureManifest({ runId: interruptedId, directory })).recoveryStage, 'inventory-only');
    await updateFixtureManifest({ runId: interruptedId, directory, status: 'RETAINED',
      retentionReason: 'Recovered inventory; original database content remains retained.', records: { residualEvents: ['event-a'] } });
    const inventory = await inventoryFixtureManifests({ directory });
    assert.deepEqual(inventory.map(row => row.status).sort(), ['COMPLETED', 'RETAINED']);
    assert.deepEqual(inventory.find(row => row.runId === interruptedId).statusHistory.map(row => row.status),
      ['PREPARING', 'RUNNING', 'INTERRUPTED', 'RUNNING', 'RETAINED']);
    const recoveredManifest = await require('./e2e-support/fixture-manifest').readFixtureManifest(path.join(directory, `${interruptedId}.json`));
    assert.deepEqual(recoveredManifest.records.residualEvents, ['event-a']);

    const concurrent = await Promise.all(Array.from({ length: 4 }, () => createFixtureManifest({ campaign: '0150', directory })));
    await Promise.all(concurrent.map((item, index) => item.update({ status: 'RUNNING', records: { marker: [`record-${index}`] } })));
    assert.equal((await inventoryFixtureManifests({ directory })).length, 6, 'concurrent runs remain separately inventoried');
    const failedBeforeCommit = await createFixtureManifest({ campaign: '0150', directory });
    await failedBeforeCommit.update({ status: 'RUNNING' });
    await failedBeforeCommit.update({ status: 'FAILED', databaseCommitted: false, lastError: { message: 'injected pre-commit failure' } });
    const failedAfterCommit = await createFixtureManifest({ campaign: '0150', directory });
    await failedAfterCommit.update({ status: 'RUNNING', databaseCommitted: true });
    await failedAfterCommit.update({ status: 'FAILED', databaseCommitted: true, retentionReason: 'must remain for inspection' });
    assert.equal((await inventoryFixtureManifests({ directory })).find(row => row.runId === failedAfterCommit.runId).databaseCommitted, true);
    await assert.rejects(createFixtureManifest({ campaign: '0150', directory, environment: 'rotamoto' }), /only rotamoto_e2e/u);
    console.log('Fixture manifest lifecycle: PASS (atomic files, redaction guard, concurrent runs, interrupted recovery, no cleanup authority)');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
})().catch(error => { console.error('Fixture manifest lifecycle: FAIL:', error); process.exitCode = 1; });
