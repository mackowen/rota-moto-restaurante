'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsc = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { Client } = require('pg');
const { createEncryptedBackup, verifyArtifact, restoreEncryptedBackup, readKey, parseSafeUrl } = require('./backup-runner');

const LOCK = 'rotamoto:proof-media:snapshot:v1';
const MAX_OBJECTS = 10000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
const KEY_RE = /^tenant\/([0-9a-f-]{36})\/delivery\/([0-9a-f-]{36})\/proof\/([0-9a-f-]{36})\.(png|jpg)$/iu;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function bad(message, code = 'RECOVERY_SET_INVALID') { return Object.assign(new Error(message), { code }); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function privateDirectory(directory, { create = false } = {}) {
  if (!path.isAbsolute(directory || '')) throw bad('Recovery directory must be absolute.');
  await rejectSymlinkPath(directory);
  const full = path.resolve(directory);
  if (create) await fs.mkdir(full, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw bad('Recovery directory permissions are unsafe.');
  return full;
}
async function rejectSymlinkPath(pathname) {
  const resolved = path.resolve(pathname); let current = path.parse(resolved).root;
  const parts = resolved.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    current = path.join(current, part);
    let stat; try { stat = await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw bad('Symlink in recovery path is not permitted.');
  }
  return resolved;
}
async function writePrivate(file, data) {
  const handle = await fs.open(file, fsc.constants.O_CREAT | fsc.constants.O_EXCL | fsc.constants.O_WRONLY | (fsc.constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
async function readPrivateFile(file, maxBytes) {
  const handle = await fs.open(file, fsc.constants.O_RDONLY | (fsc.constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > maxBytes ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw bad('Private recovery file is unsafe.');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw bad('Private recovery file changed while being read.');
    return bytes;
  } finally { await handle.close(); }
}
function mediaPath(root, objectKey) {
  const match = KEY_RE.exec(objectKey || '');
  if (!match) throw bad('Storage reference is invalid.');
  return path.join(root, ...objectKey.split('/'));
}
function archivePath(root, fileName) {
  if (!/^\d{8}\.blob$/u.test(fileName || '')) throw bad('Encrypted media component key is invalid.');
  return path.join(root, fileName);
}
async function canonicalReferences(client) {
  const { rows } = await client.query(`SELECT proof.company_id::text, proof.related_record_id::text AS delivery_id,
    proof.related_entity_type, delivery.record_id::text AS existing_delivery_id, proof.payload->'media' AS media
    FROM rotamoto.domain_records proof LEFT JOIN rotamoto.domain_records delivery
      ON delivery.company_id=proof.company_id AND delivery.record_id=proof.related_record_id AND delivery.entity_type='Delivery'
    WHERE proof.entity_type='DeliveryProof' AND proof.deleted_at IS NULL
      AND proof.payload->'media'->'storageRef'->>'provider'='filesystem-v1' ORDER BY proof.company_id,proof.record_id`);
  if (rows.length > MAX_OBJECTS) throw bad('Recovery object count exceeds safety limit.');
  const seen = new Set(); let total = 0;
  const refs = rows.map(row => {
    const media = row.media || {}, ref = media.storageRef || {}, match = KEY_RE.exec(ref.objectKey || '');
    if (!match || ref.provider !== 'filesystem-v1' || row.related_entity_type !== 'Delivery' || row.existing_delivery_id !== row.delivery_id ||
      match[1].toLowerCase() !== row.company_id.toLowerCase() ||
      match[2].toLowerCase() !== String(row.delivery_id).toLowerCase() || !ID_RE.test(row.company_id) ||
      !ID_RE.test(row.delivery_id) || !['image/png', 'image/jpeg'].includes(media.mimeType) ||
      !Number.isSafeInteger(media.sizeBytes) || media.sizeBytes < 1 || media.sizeBytes > MAX_OBJECT_BYTES ||
      !/^[a-f0-9]{64}$/iu.test(media.sha256 || '') || seen.has(ref.objectKey)) throw bad('Canonical media metadata is invalid or duplicated.');
    seen.add(ref.objectKey); total += media.sizeBytes;
    if (total > MAX_TOTAL_BYTES) throw bad('Recovery media size exceeds safety limit.');
    return { companyId: row.company_id.toLowerCase(), deliveryId: row.delivery_id.toLowerCase(), objectKey: ref.objectKey,
      mimeType: media.mimeType, sizeBytes: media.sizeBytes, sha256: media.sha256.toLowerCase() };
  });
  return refs;
}
async function withSnapshotLock(databaseUrl, action, clientFactory = options => new Client(options)) {
  const client = clientFactory({ connectionString: databaseUrl }); await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [LOCK]);
    try { return await action(client); }
    finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [LOCK]); }
  } finally { await client.end(); }
}
async function encryptObject(data, key, objectKey) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(objectKey));
  return Buffer.concat([Buffer.from('RMOM1'), iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
}
function decryptObject(envelope, key, objectKey) {
  if (envelope.length < 33 || !envelope.subarray(0, 5).equals(Buffer.from('RMOM1'))) throw bad('Encrypted media envelope is invalid.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.subarray(5, 17));
  decipher.setAAD(Buffer.from(objectKey));
  decipher.setAuthTag(envelope.subarray(envelope.length - 16));
  try { return Buffer.concat([decipher.update(envelope.subarray(17, -16)), decipher.final()]); }
  catch (_) { throw bad('Encrypted media authentication failed.', 'RECOVERY_MEDIA_AUTH_FAILED'); }
}
function validatePlainObject(plain, entry) {
  const validType = entry.mimeType === 'image/png'
    ? plain.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : entry.mimeType === 'image/jpeg' && plain.length >= 3 && plain[0] === 0xff && plain[1] === 0xd8 && plain[2] === 0xff;
  if (plain.length !== entry.sizeBytes || digest(plain) !== entry.sha256 || !validType) throw bad('Recovery media content integrity failed.');
}
function manifestMac(key, value) { return crypto.createHmac('sha256', key).update(JSON.stringify(value)).digest('hex'); }
function openSetManifest(envelope, key, id) {
  if (envelope.version !== 1 || envelope.format !== 'rotamoto-recovery-set-v1' || envelope.id !== id ||
      !/^[a-f0-9]{64}$/iu.test(envelope.manifestMac || '') || typeof envelope.payload !== 'string' || envelope.payload.length > 24 * 1024 * 1024) throw bad('Recovery set manifest envelope is invalid.');
  let value;
  try { value = JSON.parse(decryptObject(Buffer.from(envelope.payload, 'base64'), key, `recovery-set:${id}`).toString('utf8')); }
  catch (_) { throw bad('Recovery set manifest authentication failed.'); }
  const expected = Buffer.from(manifestMac(key, value), 'hex'), saved = Buffer.from(envelope.manifestMac, 'hex');
  if (saved.length !== expected.length || !crypto.timingSafeEqual(saved, expected) || value.id !== id ||
      value.format !== envelope.format || value.version !== envelope.version || value.createdAt !== envelope.createdAt) throw bad('Recovery set manifest authentication failed.');
  return value;
}
function safeId(id) { if (!ID_RE.test(id || '')) throw bad('Recovery set id is invalid.'); return id; }
async function createRecoverySet({ databaseUrl, keyFile, backupDirectory, mediaDirectory, retentionDays = 30, now = new Date(), pgDump, pgRestore, clientFactory }) {
  if (parseSafeUrl(databaseUrl).database !== 'rotamoto') throw bad('Recovery backup source must be rotamoto.');
  const root = await privateDirectory(backupDirectory, { create: true });
  const mediaRoot = await privateDirectory(mediaDirectory);
  if (root === mediaRoot || root.startsWith(`${mediaRoot}${path.sep}`) || mediaRoot.startsWith(`${root}${path.sep}`)) throw bad('Backup and media roots must be separate.');
  const key = await readKey(keyFile); let dbManifest, mediaCount = 0;
  try {
    await withSnapshotLock(databaseUrl, async client => {
      const refs = await canonicalReferences(client);
      const stage = path.join(root, `.staging-set-${crypto.randomUUID()}`);
      await fs.mkdir(stage, { mode: 0o700 });
      try {
        dbManifest = await createEncryptedBackup({ databaseUrl, keyFile, directory: stage, retentionDays, now, pgDump, pgRestore, prune: false });
        const mediaRootStage = path.join(stage, 'media');
        await fs.mkdir(mediaRootStage, { mode: 0o700 });
        const entries = []; let total = 0;
        const objectStore = await require('../domain/filesystem-object-store').createFilesystemObjectStore({ directory: mediaRoot });
        for (const ref of refs) {
          const source = await objectStore.get({ provider: 'filesystem-v1', objectKey: ref.objectKey },
            { contentType: ref.mimeType, sizeBytes: ref.sizeBytes, sha256: ref.sha256 });
          const encrypted = await encryptObject(source.data, key, ref.objectKey); total += source.sizeBytes;
          if (entries.length >= MAX_OBJECTS || total > MAX_TOTAL_BYTES) throw bad('Recovery media limits exceeded.');
          const file = `${String(entries.length).padStart(8, '0')}.blob`;
          const target = archivePath(mediaRootStage, file);
          await writePrivate(target, encrypted);
          entries.push({ ...ref, file, encryptedSizeBytes: encrypted.length, encryptedSha256: digest(encrypted) });
        }
        const unsigned = { version: 1, format: 'rotamoto-recovery-set-v1', id: dbManifest.id, createdAt: dbManifest.createdAt,
          database: { name: 'rotamoto', id: dbManifest.id, sizeBytes: dbManifest.sizeBytes, sha256: dbManifest.sha256 },
          media: { objectCount: entries.length, plaintextBytes: total, entries } };
        const payload = await encryptObject(Buffer.from(JSON.stringify(unsigned)), key, `recovery-set:${dbManifest.id}`);
        const set = { version: 1, format: unsigned.format, id: unsigned.id, createdAt: unsigned.createdAt,
          manifestMac: manifestMac(key, unsigned), payload: payload.toString('base64') };
        await writePrivate(path.join(stage, 'set.json'), Buffer.from(`${JSON.stringify(set)}\n`));
        const finalSet = path.join(root, `${dbManifest.id}.set`);
        try { await fs.lstat(finalSet); throw bad('Recovery set id collision.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(stage, finalSet);
        const dir = await fs.open(root, fsc.constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
        mediaCount = (await verifyRecoverySet({ directory: root, id: dbManifest.id, keyFile })).media.objectCount;
        await pruneRecoverySets({ directory: root, retentionDays, now, keyFile });
      } catch (error) { await fs.rm(stage, { recursive: true, force: true }); throw error; }
    }, clientFactory);
  } catch (error) {
    throw error;
  } finally { key.fill(0); }
  return Object.freeze({ id: dbManifest.id, format: 'rotamoto-recovery-set-v1', createdAt: dbManifest.createdAt,
    database: { sizeBytes: dbManifest.sizeBytes, sha256: dbManifest.sha256 }, media: { objectCount: mediaCount } });
}
async function verifyRecoverySet({ directory, id, keyFile }) {
  id = safeId(id); const root = await privateDirectory(directory);
  const setRoot = path.join(root, `${id}.set`), setStat = await fs.lstat(setRoot);
  if (setStat.isSymbolicLink() || !setStat.isDirectory() || (setStat.mode & 0o077) || (typeof process.getuid === 'function' && setStat.uid !== process.getuid())) throw bad('Recovery set directory is unsafe.');
  const setFile = path.join(setRoot, 'set.json');
  const [{ manifest: database }, key, setText] = await Promise.all([
    verifyArtifact({ directory: setRoot, id, keyFile }), readKey(keyFile), readPrivateFile(setFile, 16 * 1024 * 1024).then(value => value.toString('utf8'))
  ]);
  try {
    const envelope = JSON.parse(setText), set = openSetManifest(envelope, key, id);
    if (set.createdAt !== database.createdAt ||
        set.database?.name !== 'rotamoto' || database.database !== 'rotamoto' || set.database?.id !== database.id ||
        set.database?.sha256 !== database.sha256 || set.database?.sizeBytes !== database.sizeBytes ||
        !Array.isArray(set.media?.entries) || set.media.objectCount !== set.media.entries.length || set.media.entries.length > MAX_OBJECTS) throw bad('Recovery set manifest is invalid or unauthenticated.');
    if (!Number.isFinite(Date.parse(set.createdAt)) || !Number.isSafeInteger(set.media.plaintextBytes) || set.media.plaintextBytes < 0 || set.media.plaintextBytes > MAX_TOTAL_BYTES) throw bad('Recovery set timestamp or size is invalid.');
    const mediaDir = path.join(setRoot, 'media'), stat = await fs.lstat(mediaDir);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw bad('Recovery media component is unsafe.');
    let total = 0; const keys = new Set();
    for (const [index, entry] of set.media.entries.entries()) {
      const parsedKey = KEY_RE.exec(entry.objectKey || '');
      if (!parsedKey || parsedKey[1].toLowerCase() !== String(entry.companyId).toLowerCase() || parsedKey[2].toLowerCase() !== String(entry.deliveryId).toLowerCase() ||
          parsedKey[4] !== (entry.mimeType === 'image/png' ? 'png' : entry.mimeType === 'image/jpeg' ? 'jpg' : 'invalid') || entry.file !== `${String(index).padStart(8, '0')}.blob`) throw bad('Recovery media association metadata is invalid.');
      const full = archivePath(mediaDir, entry.file);
      if (keys.has(entry.objectKey) || !Number.isSafeInteger(entry.encryptedSizeBytes) || entry.encryptedSizeBytes < 33 ||
          entry.encryptedSizeBytes > MAX_OBJECT_BYTES + 33 || !ID_RE.test(entry.companyId) || !ID_RE.test(entry.deliveryId)) throw bad('Recovery media component is incomplete or unsafe.');
      if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > MAX_OBJECT_BYTES || !/^[a-f0-9]{64}$/iu.test(entry.sha256 || '') || !/^[a-f0-9]{64}$/iu.test(entry.encryptedSha256 || '')) throw bad('Recovery media entry metadata is invalid.');
      const bytes = await readPrivateFile(full, MAX_OBJECT_BYTES + 33);
      if (bytes.length !== entry.encryptedSizeBytes) throw bad('Recovery media component size mismatch.');
      if (digest(bytes) !== entry.encryptedSha256) throw bad('Recovery media checksum failed.');
      const plain = decryptObject(bytes, key, entry.objectKey);
      validatePlainObject(plain, entry);
      if (plain.length > MAX_OBJECT_BYTES) throw bad('Recovery media size exceeds safety limit.');
      keys.add(entry.objectKey); total += plain.length;
      if (total > MAX_TOTAL_BYTES) throw bad('Recovery media size exceeds safety limit.');
    }
    if (total !== set.media.plaintextBytes) throw bad('Recovery media manifest size mismatch.');
    const actualFiles = await listFiles(mediaDir), expectedFiles = set.media.entries.map(entry => entry.file);
    if (actualFiles.length !== expectedFiles.length || actualFiles.some(file => !expectedFiles.includes(file))) throw bad('Recovery media contains missing or unexpected files.');
    return Object.freeze({ id, format: set.format, createdAt: set.createdAt, database: { sizeBytes: database.sizeBytes, sha256: database.sha256 }, media: { objectCount: keys.size, plaintextBytes: total } });
  } finally { key.fill(0); }
}
async function listFiles(root, base = root, out = []) {
  for (const ent of await fs.readdir(base, { withFileTypes: true })) {
    const file = path.join(base, ent.name), stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw bad('Recovery media tree contains unsafe entries.');
    if (stat.isDirectory()) await listFiles(root, file, out);
    else if (stat.isFile() && stat.nlink === 1) out.push(path.relative(root, file).split(path.sep).join('/'));
    else throw bad('Recovery media tree contains unexpected entries.');
  }
  return out;
}
async function restoreRecoverySet({ directory, id, targetUrl, keyFile, disposableMediaDirectory, productionMediaDirectory, pgRestore, restoreDatabase = restoreEncryptedBackup, clientFactory = options => new Client(options) }) {
  id = safeId(id);
  const parsedTarget = parseSafeUrl(targetUrl, { restore: true });
  if (!productionMediaDirectory) throw bad('Configured production media root is required to authorize a disposable restore target.');
  const target = await rejectSymlinkPath(disposableMediaDirectory || '');
  if (!/^rotamoto-disposable-media-[0-9a-f-]{36}$/u.test(path.basename(target))) throw bad('Restore media target must be explicitly disposable.');
  const parent = await privateDirectory(path.dirname(target));
  const productionRoot = await rejectSymlinkPath(productionMediaDirectory);
  if (target === productionRoot || target.startsWith(`${productionRoot}${path.sep}`) || productionRoot.startsWith(`${target}${path.sep}`)) throw bad('Disposable media target overlaps operational storage.');
  const tempRoot = await fs.realpath(os.tmpdir());
  const parentReal = await fs.realpath(parent);
  if (path.dirname(parentReal) !== tempRoot || !/^rotamoto-disposable-media-parent-[0-9a-f-]{36}$/u.test(path.basename(parentReal))) throw bad('Restore media parent must be a dedicated private temporary directory.');
  try { await fs.lstat(target); throw bad('Restore media target already exists.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let key, stage, targetReserved = false, phase = 'verify';
  try {
    const verified = await verifyRecoverySet({ directory, id, keyFile });
    const root = path.resolve(directory), setRoot = path.join(root, `${id}.set`);
    key = await readKey(keyFile);
    const set = openSetManifest(JSON.parse((await readPrivateFile(path.join(setRoot, 'set.json'), 16 * 1024 * 1024)).toString('utf8')), key, id);
    stage = path.join(parent, `.rotamoto-stage-${crypto.randomUUID()}`);
    phase = 'media staging'; await fs.mkdir(stage, { mode: 0o700 });
    for (const entry of set.media.entries) {
      const encrypted = await readPrivateFile(archivePath(path.join(setRoot, 'media'), entry.file), MAX_OBJECT_BYTES + 33);
      if (encrypted.length !== entry.encryptedSizeBytes || digest(encrypted) !== entry.encryptedSha256) throw bad('Recovery media component changed after verification.');
      const plain = decryptObject(encrypted, key, entry.objectKey);
      validatePlainObject(plain, entry);
      const output = mediaPath(stage, entry.objectKey);
      await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 }); await writePrivate(output, plain);
    }
    phase = 'PostgreSQL restore';
    await restoreDatabase({ directory: setRoot, id, targetUrl, keyFile, pgRestore });
    phase = 'reference validation';
    const client = clientFactory({ connectionString: targetUrl }); await client.connect();
    let refs; try { refs = await canonicalReferences(client); } finally { await client.end(); }
    const expected = new Map(set.media.entries.map(entry => [entry.objectKey, entry]));
    if (refs.length !== expected.size || refs.some(ref => {
      const saved = expected.get(ref.objectKey);
      return !saved || saved.companyId !== ref.companyId || saved.deliveryId !== ref.deliveryId || saved.mimeType !== ref.mimeType || saved.sha256 !== ref.sha256 || saved.sizeBytes !== ref.sizeBytes;
    })) throw bad('Restored database media references do not match the recovery set.');
    const restoredFiles = await listFiles(stage);
    if (restoredFiles.length !== expected.size || restoredFiles.some(file => !expected.has(file))) throw bad('Restored media staging has unexpected files.');
    // mkdir is the no-replace reservation: unlike rename(stage, target), it
    // cannot silently replace a directory created by a concurrent actor.
    phase = 'media promotion'; await fs.mkdir(target, { mode: 0o700 });
    targetReserved = true;
    for (const name of await fs.readdir(stage)) await fs.rename(path.join(stage, name), path.join(target, name));
    await fs.rmdir(stage);
    const d = await fs.open(parent, fsc.constants.O_RDONLY); try { await d.sync(); } finally { await d.close(); }
    return Object.freeze({ restored: true, database: parsedTarget.database, mediaPromoted: true, id, objectCount: verified.media.objectCount });
  } catch (error) {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    if (targetReserved) await fs.rm(target, { recursive: true, force: true });
    error.safeDiagnostic = `Recovery set ${phase} failed`;
    throw error;
  }
  finally { key?.fill(0); }
}
async function pruneRecoverySets({ directory, retentionDays, now = new Date(), keyFile }) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw bad('Retention is invalid.');
  const root = await privateDirectory(directory), cutoff = now.getTime() - retentionDays * 86400000;
  const lock = path.join(root, '.retention.lock'); let handle;
  try { handle = await fs.open(lock, fsc.constants.O_CREAT | fsc.constants.O_EXCL | fsc.constants.O_WRONLY | (fsc.constants.O_NOFOLLOW || 0), 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw bad('Recovery retention is already running.', 'BACKUP_RETENTION_LOCKED'); throw error; }
  try {
    let count = 0;
    for (const name of await fs.readdir(root)) {
      if (/^\.staging-set-/u.test(name)) throw bad('Incomplete recovery set staging requires operator review.', 'BACKUP_SET_INCOMPLETE');
      if (/^\.expired-/u.test(name)) throw bad('Quarantined recovery set requires operator review.', 'BACKUP_SET_INCOMPLETE');
      if (!/^[0-9a-f-]{36}\.set$/u.test(name)) continue;
      const id = name.slice(0, -'.set'.length), file = path.join(root, name, 'set.json');
      let set; try { set = JSON.parse((await readPrivateFile(file, 16 * 1024 * 1024)).toString('utf8')); } catch (_) { throw bad('Incomplete or corrupt recovery set detected.', 'BACKUP_SET_INCOMPLETE'); }
      const verified = await verifyRecoverySet({ directory: root, id, keyFile });
      if (set.id !== id || set.format !== verified.format || set.createdAt !== verified.createdAt || !Number.isFinite(Date.parse(verified.createdAt))) throw bad('Recovery set metadata is inconsistent.', 'BACKUP_SET_INCOMPLETE');
      if (Date.parse(verified.createdAt) > cutoff) continue;
      const tomb = path.join(root, `.expired-${id}-${crypto.randomUUID()}`);
      await fs.rename(path.join(root, `${id}.set`), tomb);
      count++;
      await fs.rm(tomb, { recursive: true, force: true });
    }
    return count;
  } finally { await handle.close(); await fs.unlink(lock).catch(() => {}); }
}

module.exports = { createRecoverySet, verifyRecoverySet, restoreRecoverySet, pruneRecoverySets, canonicalReferences, withSnapshotLock };
