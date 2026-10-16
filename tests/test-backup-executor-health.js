'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createBackupControlStore } = require('../backend/runtime/backup-control');
const { inspect, waitLimit } = require('../scripts/backup-executor-health');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-backup-health-'));
  try {
    const store = createBackupControlStore({ directory: path.join(root, 'control') });
    const worker = `backup-executor:${'a'.repeat(8)}-${'b'.repeat(4)}-4abc-8abc-${'c'.repeat(12)}`;
    await store.read();
    assert.equal((await inspect(path.join(root, 'control'))).state, 'UNKNOWN');
    await store.updateExecutorHeartbeat(worker, 'ONLINE', 'termux-shared-uid');
    const online = await inspect(path.join(root, 'control'));
    assert.equal(online.ok, true); assert.equal(online.state, 'ONLINE'); assert.equal(online.isolation, 'termux-shared-uid');
    const stale = await inspect(path.join(root, 'control'), { now: Date.now() + 15_000 });
    assert.equal(stale.ok, false); assert.equal(stale.state, 'STALE');
    await store.updateExecutorHeartbeat(worker, 'STOPPED', 'termux-shared-uid');
    assert.equal((await inspect(path.join(root, 'control'))).state, 'OFFLINE');
    assert.throws(() => waitLimit(['--wait-ms=30001']), /BACKUP_HEALTH_WAIT_INVALID/u);
    const unsafeDirectory = path.join(root, 'unsafe'); await fs.mkdir(unsafeDirectory, { mode: 0o700 });
    await fs.chmod(unsafeDirectory, 0o755);
    await fs.writeFile(path.join(unsafeDirectory, 'control.json'), '{}', { mode: 0o600 });
    await assert.rejects(inspect(unsafeDirectory), /BACKUP_CONTROL_DIRECTORY_UNSAFE/u);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/backup-executor-health.js')], {
      env: { PATH: process.env.PATH, ROTAMOTO_BACKUP_CONTROL_DIRECTORY: path.join(root, 'control') }, encoding: 'utf8' });
    assert.equal(cli.status, 1); assert.match(cli.stdout, /"state":"OFFLINE"/u);
    process.stdout.write('Backup executor health CLI: private-file checks, heartbeat freshness and offline states PASS\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
