'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupExecutor, safeSyntheticSource } = require('../backend/runtime/backup-executor');
const { validateDestination } = require('../backend/runtime/backup-destination-store');

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
  assert.equal(safeSyntheticSource('postgresql://rotamoto_backup@127.0.0.1/rotamoto', { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0228', ROTAMOTO_BACKUP_OPERATIONAL_SOURCE_ENABLED: 'true' }), false,
    'test mode never authorizes the official database, even with the operational opt-in');
  assert.equal(safeSyntheticSource('postgresql://rotamoto_backup@127.0.0.1/rotamoto', { NODE_ENV: 'production', ROTAMOTO_BACKUP_OPERATIONAL_SOURCE_ENABLED: 'true' }), true,
    'production requires an explicit opt-in and the dedicated backup role for the official source');
  assert.equal(safeSyntheticSource('postgresql://rotamoto_backup@127.0.0.1/rotamoto', { NODE_ENV: 'production' }), false);
  assert.equal(safeSyntheticSource('postgresql://rotamoto_backup:password@127.0.0.1/rotamoto', { NODE_ENV: 'production', ROTAMOTO_BACKUP_OPERATIONAL_SOURCE_ENABLED: 'true' }), false);
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

    const destination = validateDestination({ name: 'Synthetic S3', provider: 's3', endpoint: 'https://storage.example.net/', bucket: 'synthetic-backups', region: 'us-east-1', prefix: 'qa/rotamoto', accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-key-material-12345', active: true, retentionDays: 3 });
    const remoteRoot = path.join(root, 'remote-source'); await fs.mkdir(remoteRoot, { mode: 0o700 });
    let remotePublished = false; const remoteCalls = [];
    const remoteProvider = {
      async publishSet(options) { remoteCalls.push(['publish', options.prefix]); remotePublished = true; return { published: true }; },
      async listRecoverySets(prefix) { remoteCalls.push(['list', prefix]); return remotePublished ? [{ id: ID }] : []; },
      async downloadSet({ directory, id, prefix }) { remoteCalls.push(['download', prefix]); const set = path.join(directory, `${id}.set`); await fs.mkdir(set, { mode: 0o700 }); await fs.writeFile(path.join(set, 'set.json'), '{}', { mode: 0o600 }); return { directory: set }; },
      async deleteSet() { remoteCalls.push(['delete']); return { deleted: true }; }
    };
    const destinationStore = { async getActive() { return [{ ...destination, credentials: { accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-key-material-12345' } }]; },
      async credentials(id) { assert.equal(id, destination.id); return { ...destination, credentials: { accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-key-material-12345' } }; } };
    const remoteBackupStore = fixtureStore('backup', { retentionDays: 3, destination: 'external', destinationPolicies: [{ destinationId: destination.id, role: 'primary', retentionDays: 3 }] });
    const remoteExecutor = createBackupExecutor({ store: remoteBackupStore, destinationStore, env, operations: {
      create: async () => ({ id: ID, database: { sizeBytes: 10 } }), verify: async () => ({ id: ID, createdAt: new Date().toISOString(), database: { sizeBytes: 10 }, schemaMigrations: [], media: { objectCount: 0 } }),
      s3Factory: options => { assert.equal(options.prefix, 'qa/rotamoto'); return remoteProvider; }, prune: async () => 0
    } });
    await remoteExecutor.runOne();
    assert(remoteCalls.some(call => call[0] === 'publish' && call[1] === 'qa/rotamoto'));
    assert(remoteBackupStore.updates.some(update => update.lastRun?.externalPublished === true));

    const inventoryStore = fixtureStore('inventory', { retentionDays: 3, destination: 'external' });
    const inventoryExecutor = createBackupExecutor({ store: inventoryStore, destinationStore, env, operations: {
      inventory: async () => ({ counts: { verified: 0, incomplete: 0 }, items: [] }),
      s3Factory: () => remoteProvider,
      verify: async () => ({ id: ID, createdAt: new Date().toISOString(), database: { sizeBytes: 10 }, schemaMigrations: [], media: { objectCount: 0 } })
    } });
    await inventoryExecutor.runOne();
    const remoteInventory = inventoryStore.updates.find(update => update.inventory)?.inventory;
    assert.equal(remoteInventory.remoteVerified, 1); assert.equal(remoteInventory.sets[0].destinationId, destination.id);

    const remoteRestoreStore = fixtureStore('restore_test', { retentionDays: 3, destination: 'external' });
    remoteRestoreStore.calls = [];
    const remoteRestoreExecutor = createBackupExecutor({ store: remoteRestoreStore, destinationStore, env, operations: {
      preflightRestore: async () => {}, s3Factory: () => remoteProvider,
      verify: async () => ({ id: ID, createdAt: new Date().toISOString(), database: { sizeBytes: 10 }, schemaMigrations: [], media: { objectCount: 0 } }),
      restore: async options => { assert.notEqual(options.directory, env.ROTAMOTO_BACKUP_DIRECTORY); remoteRestoreStore.calls.push('restore-remote'); return { id: ID }; },
      verifyRestored: async () => ({ database: 'rotamoto_disposable_0228_restore', migrationCount: 44, latestMigration: '0044_99food_distributed_rate_limit', rlsTables: 10, policies: 10, invalidIndexes: 0, unvalidatedConstraints: 0 })
    } });
    remoteRestoreStore.claimNext = async () => ({ id: ID, kind: 'restore_test', recoverySetId: ID, destinationId: destination.id });
    await remoteRestoreExecutor.runOne(); assert(remoteRestoreStore.calls.includes('restore-remote'));

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
