'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sourceText = file => require('node:fs').readFileSync(path.join(__dirname, '..', file), 'utf8');
const { Readable } = require('node:stream');
const { createFilesystemObjectStore } = require('../backend/domain/filesystem-object-store');
const { createRecoverySet, verifyRecoverySet, restoreRecoverySet, withSnapshotLock, pruneRecoverySets } = require('../backend/runtime/recovery-set');

const uuid = () => crypto.randomUUID();
async function copyTree(source, target) { await fs.cp(source, target, { recursive: true, preserveTimestamps: true }); }
async function makeExecutable(file, text) { await fs.writeFile(file, `#!${process.execPath}\n${text}\n`, { mode: 0o700 }); await fs.chmod(file, 0o700); }
async function rejects(fn) { await assert.rejects(fn); }

(async () => {
  for (const file of ['backend/domain/proof-media-http.js', 'backend/domain/proof-media-gc.js', 'backend/domain/sync-service.js'])
    assert.match(sourceText(file), /rotamoto:proof-media:snapshot:v1/u, `${file} must use the shared snapshot barrier`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-recovery-test-'));
  const keyFile = path.join(root, 'backup.key'), backups = path.join(root, 'backups'), media = path.join(root, 'media');
  await fs.writeFile(keyFile, crypto.randomBytes(32), { mode: 0o600 }); await fs.mkdir(backups, { mode: 0o700 }); await fs.mkdir(media, { mode: 0o700 });
  const key = await fs.readFile(keyFile);
  const companyId = uuid(), deliveryId = uuid(), proofId = uuid();
  const png = Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
  const store = await createFilesystemObjectStore({ directory: media });
  const stored = await store.putProof({ companyId, deliveryId, contentType: 'image/png', source: Readable.from(png) });
  const row = { company_id: companyId, delivery_id: deliveryId, related_entity_type: 'Delivery', existing_delivery_id: deliveryId,
    media: { storageRef: stored.reference, mimeType: stored.contentType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, proofId } };
  const dumpExe = path.join(root, 'pg-dump'), restoreExe = path.join(root, 'pg-restore');
  await makeExecutable(dumpExe, 'process.stdout.write(Buffer.from("fake-custom-dump"));');
  await makeExecutable(restoreExe, 'process.exit(process.argv.includes("--list") ? 0 : 0);');
  const clientFactory = () => ({ async connect() {}, async end() {}, async query(sql) {
    if (sql.includes('pg_advisory_lock')) return { rows: [] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [] };
    if (sql.includes('FROM rotamoto.domain_records')) return { rows: [row] };
    return { rows: [] };
  } });
  const set = await createRecoverySet({ databaseUrl: 'postgresql://rotamoto_backup@localhost/rotamoto', keyFile, backupDirectory: backups,
    mediaDirectory: media, pgDump: dumpExe, pgRestore: restoreExe, clientFactory });
  assert.equal(set.media.objectCount, 1);
  assert.deepEqual(await verifyRecoverySet({ directory: backups, id: set.id, keyFile }), {
    id: set.id, format: 'rotamoto-recovery-set-v1', createdAt: set.createdAt,
    database: set.database, media: { objectCount: 1, plaintextBytes: png.length }
  });

  const badManifest = path.join(root, 'bad-manifest'); await copyTree(backups, badManifest);
  const setFile = path.join(badManifest, `${set.id}.set`, 'set.json'); const setValue = JSON.parse(await fs.readFile(setFile, 'utf8'));
  setValue.manifestMac = '0'.repeat(64); await fs.writeFile(setFile, JSON.stringify(setValue), { mode: 0o600 });
  await rejects(() => verifyRecoverySet({ directory: badManifest, id: set.id, keyFile }));

  let hardlinkTestable = true;
  for (const mode of ['missing', 'corrupt', 'extra', 'symlink', 'hardlink', 'incomplete']) {
    const candidate = path.join(root, `bad-${mode}`); await copyTree(backups, candidate);
    const object = path.join(candidate, `${set.id}.set`, 'media', '00000000.blob');
    if (mode === 'missing') await fs.unlink(object);
    if (mode === 'corrupt') { const value = await fs.readFile(object); value[value.length - 17] ^= 0xff; await fs.writeFile(object, value, { mode: 0o600 }); }
    if (mode === 'extra') await fs.writeFile(path.join(candidate, `${set.id}.set`, 'media', 'unexpected'), 'extra', { mode: 0o600 });
    if (mode === 'symlink') { await fs.unlink(object); await fs.symlink(path.join(media, ...stored.reference.objectKey.split('/')), object); }
    if (mode === 'hardlink') { await fs.unlink(object); try { await fs.link(path.join(media, ...stored.reference.objectKey.split('/')), object); }
      catch (error) { if (!['EPERM', 'EACCES', 'EXDEV', 'ENOTSUP'].includes(error.code)) throw error; hardlinkTestable = false; } }
    if (mode === 'incomplete') await fs.unlink(path.join(candidate, `${set.id}.set`, 'set.json'));
    if (mode !== 'hardlink' || hardlinkTestable) await rejects(() => verifyRecoverySet({ directory: candidate, id: set.id, keyFile }));
  }

  const traversal = { ...row, media: { ...row.media, storageRef: { provider: 'filesystem-v1', objectKey: '../../etc/passwd' } } };
  await assert.rejects(require('../backend/runtime/recovery-set').canonicalReferences({ async query() { return { rows: [traversal] }; } }));

  const parent = path.join(os.tmpdir(), `rotamoto-disposable-media-parent-${uuid()}`); await fs.mkdir(parent, { mode: 0o700 });
  const mediaTarget = path.join(parent, `rotamoto-disposable-media-${uuid()}`), productionMedia = path.join(root, 'production-media');
  await fs.mkdir(productionMedia, { mode: 0o700 });
  await rejects(() => restoreRecoverySet({ directory: backups, id: set.id, targetUrl: 'postgresql://rotamoto_restore@localhost/rotamoto',
    keyFile, disposableMediaDirectory: mediaTarget, productionMediaDirectory: productionMedia }));
  await rejects(() => restoreRecoverySet({ directory: backups, id: set.id, targetUrl: 'postgresql://rotamoto_restore@localhost/rotamoto_e2e',
    keyFile, disposableMediaDirectory: mediaTarget, productionMediaDirectory: productionMedia }));
  await rejects(() => restoreRecoverySet({ directory: backups, id: set.id, targetUrl: 'postgresql://rotamoto_restore@localhost/rotamoto_disposable_test',
    keyFile, disposableMediaDirectory: path.join(root, 'production-media', `rotamoto-disposable-media-${uuid()}`), productionMediaDirectory: productionMedia }));

  let databaseRestored = false;
  const restored = await restoreRecoverySet({ directory: backups, id: set.id, targetUrl: 'postgresql://rotamoto_restore@localhost/rotamoto_disposable_test',
    keyFile, disposableMediaDirectory: mediaTarget, productionMediaDirectory: productionMedia,
    restoreDatabase: async ({ directory }) => { assert.equal(path.basename(directory), `${set.id}.set`); databaseRestored = true; }, clientFactory });
  assert.equal(databaseRestored, true); assert.equal(restored.mediaPromoted, true);
  const restoredProof = await createFilesystemObjectStore({ directory: mediaTarget }).then(obj => obj.get(stored.reference,
    { contentType: stored.contentType, sizeBytes: stored.sizeBytes, sha256: stored.sha256 }));
  assert.deepEqual(restoredProof.data, png);

  const failParent = path.join(os.tmpdir(), `rotamoto-disposable-media-parent-${uuid()}`); await fs.mkdir(failParent, { mode: 0o700 });
  const failTarget = path.join(failParent, `rotamoto-disposable-media-${uuid()}`);
  await rejects(() => restoreRecoverySet({ directory: backups, id: set.id, targetUrl: 'postgresql://rotamoto_restore@localhost/rotamoto_disposable_test',
    keyFile, disposableMediaDirectory: failTarget, productionMediaDirectory: productionMedia,
    restoreDatabase: async () => { await fs.mkdir(failTarget, { mode: 0o700 }); }, clientFactory }));
  assert.deepEqual((await fs.readdir(failParent)).sort(), [path.basename(failTarget)]);

  let active = 0, peak = 0, tail = Promise.resolve();
  const lockFactory = () => { let release; return { async connect() {}, async end() {}, async query(sql) {
    if (sql.includes('pg_advisory_lock')) { const previous = tail; tail = new Promise(resolve => { release = resolve; }); await previous; active++; peak = Math.max(peak, active); }
    if (sql.includes('pg_advisory_unlock')) { active--; release(); }
    return { rows: [] };
  } }; };
  await Promise.all([1,2].map(() => withSnapshotLock('postgresql://rotamoto_backup@localhost/rotamoto', async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
  }, lockFactory)));
  assert.equal(peak, 1, 'snapshot lock serializes simultaneous backup operations');

  const badDump = path.join(root, 'pg-dump-interrupted'); await makeExecutable(badDump, 'process.stderr.write("dump interrupted"); process.exit(9);');
  await rejects(() => createRecoverySet({ databaseUrl: 'postgresql://rotamoto_backup@localhost/rotamoto', keyFile, backupDirectory: backups,
    mediaDirectory: media, pgDump: badDump, pgRestore: restoreExe, clientFactory }));
  const remaining = await fs.readdir(backups);
  assert.equal(remaining.some(name => name.startsWith('.staging-set-')), false);
  assert.equal(remaining.some(name => name.endsWith('.tmp')), false);
  assert.equal(await pruneRecoverySets({ directory: backups, retentionDays: 30, now: new Date(Date.now() + 31 * 86400000), keyFile }), 1);
  await assert.rejects(fs.lstat(path.join(backups, `${set.id}.set`)));

  key.fill(0); await fs.rm(root, { recursive: true, force: true }); await fs.rm(parent, { recursive: true, force: true }); await fs.rm(failParent, { recursive: true, force: true });
  console.log(`coordinated recovery set adversarial tests: OK${hardlinkTestable ? '' : ' (hardlink creation unavailable on this filesystem)'}`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
