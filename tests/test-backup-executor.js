'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupExecutor } = require('../backend/runtime/backup-executor');

const ID = '09a9b439-7047-4b58-9682-8753da4a809f';
function fixtureStore(kind, config = { retentionDays: 3, destination: 'external' }) {
  const calls = [], updates = [];
  let claimed = { id: ID, kind, recoverySetId: ID };
  return { calls, updates,
    async claimNext() { const job = claimed; claimed = null; return job; },
    async updateJob(id, update) { assert.equal(id, ID); updates.push(update); },
    async read() { return { config }; },
    async recoverInterrupted() { return []; }, async dueSchedule() { return null; }
  };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-backup-executor-'));
  const previous = Object.fromEntries(['ROTAMOTO_OPERATOR_AUDIT_LOG', 'ROTAMOTO_OPERATOR_ACTOR_REF'].map(key => [key, process.env[key]]));
  process.env.ROTAMOTO_OPERATOR_AUDIT_LOG = path.join(root, 'operator-audit.jsonl');
  process.env.ROTAMOTO_OPERATOR_ACTOR_REF = 'campaign:0228-test';
  const env = { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0228', BACKUP_DATABASE_URL: 'postgresql://rotamoto_backup@127.0.0.1:55440/rotamoto_disposable_0228_source',
    ROTAMOTO_BACKUP_CONTROL_DIRECTORY: root, ROTAMOTO_BACKUP_KEY_FILE: path.join(root, 'key'), ROTAMOTO_BACKUP_DIRECTORY: path.join(root, 'sets'),
    ROTAMOTO_MEDIA_DIRECTORY: path.join(root, 'media'), ROTAMOTO_BACKUP_REMOTE_URL: 'http://127.0.0.1:55440/', ROTAMOTO_BACKUP_REMOTE_TOKEN: 'synthetic-test-token-that-is-not-a-secret',
    ROTAMOTO_DISPOSABLE_RESTORE_DATABASE_URL: 'postgresql://rotamoto_restore@127.0.0.1:55440/rotamoto_disposable_0228_restore' };
  for (const key of ['ROTAMOTO_BACKUP_CONTROL_DIRECTORY', 'ROTAMOTO_BACKUP_KEY_FILE', 'ROTAMOTO_BACKUP_DIRECTORY', 'ROTAMOTO_MEDIA_DIRECTORY'])
    if (key.endsWith('DIRECTORY')) await fs.mkdir(env[key], { recursive: true, mode: 0o700 });
  await fs.writeFile(env.ROTAMOTO_BACKUP_KEY_FILE, Buffer.alloc(32, 7), { mode: 0o600 });
  try {
    const forbidden = fixtureStore('backup', { retentionDays: 3, destination: 'local' });
    const badExecutor = createBackupExecutor({ store: forbidden, env: { ...env, BACKUP_DATABASE_URL: 'postgresql://rotamoto_backup@127.0.0.1:5432/rotamoto' }, operations: { create: async () => { throw new Error('must not run'); } } });
    await badExecutor.runOne();
    assert(forbidden.updates.some(update => update.type === 'errorCode' && update.code === 'BACKUP_SOURCE_NOT_AUTHORIZED'));

    const store = fixtureStore('backup'); const order = [];
    const executor = createBackupExecutor({ store, env, operations: {
      create: async options => { assert.equal(options.prune, false); order.push('create'); return { id: ID, database: { sizeBytes: 10 } }; },
      verify: async () => { order.push('verify'); return { id: ID }; },
      remoteFactory: () => ({ publishSet: async () => { order.push('publish'); return { published: true }; } }),
      prune: async () => { order.push('prune'); return 0; }
    } });
    await executor.runOne();
    assert.deepEqual(order, ['create', 'verify', 'publish', 'prune']);
    assert(store.updates.some(update => update.lastRun?.externalPublished === true));

    const failedStore = fixtureStore('backup'); const failedOrder = [];
    const failed = createBackupExecutor({ store: failedStore, env, operations: {
      create: async () => { failedOrder.push('create'); return { id: ID, database: { sizeBytes: 10 } }; },
      verify: async () => { failedOrder.push('verify'); return { id: ID }; },
      remoteFactory: () => ({ publishSet: async () => { failedOrder.push('publish'); throw Object.assign(new Error(), { code: 'BACKUP_REMOTE_UNAVAILABLE' }); } }),
      prune: async () => { failedOrder.push('prune'); }
    } });
    await failed.runOne();
    assert.deepEqual(failedOrder, ['create', 'verify', 'publish'], 'old recovery sets remain when new external publication fails');

    const restoreStore = fixtureStore('restore_test', { retentionDays: 3, destination: 'local' });
    const restoreOrder = [];
    const restoreExecutor = createBackupExecutor({ store: restoreStore, env, operations: {
      preflightRestore: async target => { assert.equal(target, env.ROTAMOTO_DISPOSABLE_RESTORE_DATABASE_URL); restoreOrder.push('empty-target'); },
      restore: async () => { restoreOrder.push('restore'); return { id: ID }; },
      verifyRestored: async () => { restoreOrder.push('verify-restored'); return { database: 'rotamoto_disposable_0228_restore', migrationCount: 44, latestMigration: '0044_99food_distributed_rate_limit', rlsTables: 10, policies: 10, invalidIndexes: 0, unvalidatedConstraints: 0 }; }
    } });
    await restoreExecutor.runOne();
    assert.deepEqual(restoreOrder, ['empty-target', 'restore', 'verify-restored']);
    assert(restoreStore.updates.some(update => update.lastRun?.status === 'restore_verified' && update.lastRun.durationMs >= 0));
    const audit = await fs.readFile(process.env.ROTAMOTO_OPERATOR_AUDIT_LOG, 'utf8');
    assert(!audit.includes(env.ROTAMOTO_BACKUP_REMOTE_TOKEN));
    process.stdout.write('Backup executor: synthetic source guard, verify/publish-before-retention, failure preservation and isolated restore validation PASS\n');
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
