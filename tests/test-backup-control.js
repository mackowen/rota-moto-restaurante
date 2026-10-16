'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupControlStore, validateConfig, nextSchedule, publicState } = require('../backend/runtime/backup-control');
const { safeDisposableTarget, safeSyntheticSource } = require('../backend/runtime/backup-executor');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-backup-control-'));
  let now = new Date('2026-10-15T01:00:00Z');
  const store = createBackupControlStore({ directory: root, clock: () => new Date(now) });
  const releaseExecutor = await store.acquireExecutorLease(`backup-executor:${'a'.repeat(8)}-${'b'.repeat(4)}-${'4abc'}-${'8abc'}-${'a'.repeat(12)}`);
  await assert.rejects(store.acquireExecutorLease(`backup-executor:${'c'.repeat(8)}-${'d'.repeat(4)}-${'4abc'}-${'8abc'}-${'c'.repeat(12)}`), /BACKUP_EXECUTOR_ALREADY_RUNNING/u);
  await releaseExecutor();
  assert.throws(() => validateConfig({ frequency: 'hourly', timeUtc: '02:00', retentionDays: 5, destination: 'local' }), /BACKUP_CONFIG_INVALID/u);
  assert.deepEqual(validateConfig({ frequency: 'daily', timeUtc: '02:30', retentionDays: 7, destination: 'external' }),
    { frequency: 'daily', timeUtc: '02:30', retentionDays: 7, destination: 'external', destinationPolicies: [], rpoHours: null, rtoMinutes: null });
  assert.throws(() => validateConfig({ frequency: 'daily', timeUtc: '02:30', retentionDays: 7, destination: 'external',
    destinationPolicies: [{ destinationId: '09a9b439-7047-4b58-9682-8753da4a809f', role: 'secondary', retentionDays: 10 }] }), /BACKUP_CONFIG_INVALID/u);
  assert.equal(nextSchedule({ frequency: 'daily', timeUtc: '02:00' }, now), '2026-10-15T02:00:00.000Z');
  await store.configure({ frequency: 'daily', timeUtc: '02:00', retentionDays: 7, destination: 'local' }, 'admin-a');
  assert.equal((await store.read()).executor.state, 'UNKNOWN');
  const heartbeatWorker = `backup-executor:${'e'.repeat(8)}-${'f'.repeat(4)}-${'4abc'}-${'8abc'}-${'e'.repeat(12)}`;
  await store.updateExecutorHeartbeat(heartbeatWorker, 'ONLINE', 'termux-shared-uid');
  assert.equal((await store.read()).executor.state, 'ONLINE');
  await store.updateExecutorHeartbeat(heartbeatWorker, 'STOPPED', 'termux-shared-uid');
  assert.equal((await store.read()).executor.state, 'OFFLINE');
  await assert.rejects(store.updateExecutorHeartbeat('invalid', 'ONLINE', 'termux-shared-uid'), /BACKUP_EXECUTOR_HEARTBEAT_INVALID/u);
  const key = 'request-key-0228-000001';
  const queued = await store.enqueue('backup', 'admin-a', { idempotencyKey: key });
  const duplicate = await store.enqueue('backup', 'admin-a', { idempotencyKey: key });
  assert.equal(duplicate.id, queued.id); assert.equal(duplicate.duplicate, true);
  const concurrentStore = createBackupControlStore({ directory: root, clock: () => new Date(now) });
  const concurrentJobs = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    (index % 2 ? store : concurrentStore).enqueue('inventory', 'admin-concurrent',
      { idempotencyKey: `backup-concurrent-${String(index).padStart(4, '0')}` })));
  assert.equal(new Set(concurrentJobs.map(job => job.id)).size, 32,
    'independent store instances serialize concurrent IPC writes without losing or duplicating jobs');
  assert.equal((await store.read()).jobs.filter(job => job.actorRef === 'admin-concurrent').length, 32);
  assert.equal((await store.claimNext('worker-a')).id, queued.id);
  await store.enqueue('inventory', 'admin-a');
  assert.equal(await store.claimNext('worker-b'), null, 'only one persistent job may run at a time');
  assert.deepEqual(await store.recoverInterrupted(), [queued.id]);
  assert.equal((await store.read()).jobs.find(job => job.id === queued.id).status, 'UNKNOWN_OUTCOME');
  const staleLock = path.join(root, '.control.lock');
  await fs.writeFile(staleLock, JSON.stringify({ pid: 2_147_483_647, at: new Date().toISOString() }), { mode: 0o600 });
  assert.equal((await store.read()).jobs.find(job => job.id === queued.id).status, 'UNKNOWN_OUTCOME');
  assert.equal(await fs.stat(staleLock).then(() => true, () => false), false, 'dead executor lock is recovered safely');
  const request = await store.requestRestore('09a9b439-7047-4b58-9682-8753da4a809f', 'admin-a', '19a9b439-7047-4b58-9682-8753da4a809f');
  await assert.rejects(store.approveRestore(request.id, 'admin-a', true), /BACKUP_DUAL_APPROVAL_REQUIRED/u);
  await assert.rejects(store.approveRestore(request.id, 'admin-b', false), /BACKUP_REAUTH_REQUIRED/u);
  const approved = await store.approveRestore(request.id, 'admin-b', true);
  assert.equal(approved.request.status, 'APPROVED'); assert.equal(approved.job.kind, 'restore_test');
  assert.equal(approved.job.destinationId, request.destinationId, 'remote restore approval retains the selected destination');
  assert.equal(publicState(await store.read()).restoreRequests[0].jobId, approved.job.id,
    'administrative status responses link approved restore requests to their executor job');
  const due = await store.dueSchedule(new Date('2026-10-15T02:01:00Z'));
  assert.equal(due.kind, 'backup'); assert.equal((await store.dueSchedule(new Date('2026-10-15T02:02:00Z'))), null);
  assert.equal(safeDisposableTarget('postgresql://rotamoto_restore@127.0.0.1:55440/rotamoto_disposable_0228_test',
    { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0228' }), true);
  assert.equal(safeSyntheticSource('postgresql://rotamoto_backup@127.0.0.1:55440/rotamoto_disposable_0228_test',
    { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0228' }), true);
  assert.equal(safeDisposableTarget('postgresql://rotamoto_restore@127.0.0.1:55440/rotamoto_disposable_0231_synthetic_restore',
    { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0231' }), true);
  assert.equal(safeSyntheticSource('postgresql://rotamoto_backup@127.0.0.1:55440/rotamoto_disposable_0231_synthetic_source',
    { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0231' }), true);
  assert.equal(safeSyntheticSource('postgresql://rotamoto_backup@127.0.0.1:5432/rotamoto',
    { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0228' }), false);
  for (const target of ['postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto',
    'postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto_e2e',
    'postgresql://rotamoto_restore@remote.invalid/db']) {
    assert.equal(safeDisposableTarget(target, { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0228' }), false);
  }
  assert.equal((await fs.stat(root)).mode & 0o077, 0);
  const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-backup-shared-'));
  try {
    await fs.chmod(sharedRoot, 0o2770);
    const shared = createBackupControlStore({ directory: sharedRoot, sharedGroupGid: process.getgid() });
    await shared.read();
    const stateStat = await fs.stat(path.join(sharedRoot, 'control.json'));
    assert.equal(stateStat.gid, process.getgid()); assert.equal(stateStat.mode & 0o007, 0);
    assert.equal(stateStat.mode & 0o060, 0o060, 'shared control state is group readable and writable');
  } finally { await fs.chmod(sharedRoot, 0o700); await fs.rm(sharedRoot, { recursive: true, force: true }); }
  await fs.rm(root, { recursive: true, force: true });
  process.stdout.write('Backup control: config, schedule, persistent queue, idempotency, interruption, dual approval and target guards PASS\n');
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
