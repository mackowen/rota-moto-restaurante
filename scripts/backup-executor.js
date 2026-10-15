'use strict';

const { createBackupControlStore } = require('../backend/runtime/backup-control');
const { createBackupExecutor } = require('../backend/runtime/backup-executor');
const { backupExecutorProcessAllowed, parseGid } = require('../backend/runtime/backup-process-guard');

async function main() {
  const directory = process.env.ROTAMOTO_BACKUP_CONTROL_DIRECTORY;
  if (!directory) throw new Error('BACKUP_EXECUTOR_CONFIGURATION_REQUIRED');
  if (!backupExecutorProcessAllowed()) throw Object.assign(new Error('BACKUP_EXECUTOR_IDENTITY_INVALID'), { code: 'BACKUP_EXECUTOR_IDENTITY_INVALID' });
  const store = createBackupControlStore({ directory, sharedGroupGid: parseGid(process.env.ROTAMOTO_BACKUP_CONTROL_GROUP_GID) });
  const executor = createBackupExecutor({ store });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stdout.write(`${JSON.stringify({ event: 'backup.executor.started' })}\n`);
  await executor.start({ signal: controller.signal });
  process.stdout.write(`${JSON.stringify({ event: 'backup.executor.stopped' })}\n`);
}
main().catch(error => {
  const code = /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'BACKUP_EXECUTOR_FAILED';
  process.stderr.write(`${JSON.stringify({ event: 'backup.executor.failed', code })}\n`); process.exitCode = 1;
});
