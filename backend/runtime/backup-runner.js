'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const MAGIC = Buffer.from('RMOBK1');
function parseSafeUrl(value, { restore = false } = {}) {
  let url; try { url = new URL(value); } catch (_) { throw new Error('Database target inválido.'); }
  const database = decodeURIComponent(url.pathname.slice(1));
  const username = decodeURIComponent(url.username);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.password || url.search || url.hash ||
      username !== (restore ? 'rotamoto_restore' : 'rotamoto_backup') ||
      restore && !/^rotamoto_disposable_[a-z0-9_]{1,40}$/u.test(database)) {
    throw new Error(restore ? 'Restore exige alvo descartável explícito fora de rotamoto.' : 'Backup exige URL sem senha e role administrativa separada.');
  }
  return { url, database, username };
}
async function readKey(file) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) || stat.size !== 32) throw new Error('Chave de backup insegura ou inválida.');
  return fs.readFile(file);
}
async function* encryptedStream(source, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  yield Buffer.concat([MAGIC, iv]);
  for await (const chunk of source) { const data = cipher.update(chunk); if (data.length) yield data; }
  const final = cipher.final(); if (final.length) yield final;
  yield cipher.getAuthTag();
}
function spawnStream(command, args, { env = process.env } = {}) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => {});
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => {
    if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
  });
  const done = new Promise((resolve, reject) => child.once('close', code => {
    if (code === 0) return resolve();
    const error = new Error(`${path.basename(command)} falhou (${code ?? 'sinal'}).`);
    error.code = 'PG_COMMAND_FAILED';
    error.safeDiagnostic = classifyPgDiagnostic(stderr);
    reject(error);
  }));
  done.catch(() => {});
  return { stream: child.stdout, done, child };
}
function classifyPgDiagnostic(stderr) {
  const firstError = String(stderr).split(/\r?\n/u).find(line => /\b(?:ERROR|FATAL):/iu.test(line) || /pg_restore: error:/iu.test(line)) || '';
  if (/permission denied|must be member of role|must be owner of/iu.test(firstError)) return 'PostgreSQL authorization/ownership failure';
  if (/extension .* (?:does not exist|is not available)|could not open extension control file/iu.test(firstError)) return 'PostgreSQL extension unavailable';
  if (/already exists|duplicate key/iu.test(firstError)) return 'PostgreSQL duplicate object/data conflict';
  if (/violates .*constraint|constraint .*failed/iu.test(firstError)) return 'PostgreSQL data constraint failure';
  if (/could not connect|connection .*failed|authentication failed|no password supplied/iu.test(firstError)) return 'PostgreSQL connection/authentication failure';
  return firstError ? 'PostgreSQL restore/backup error (details withheld)' : 'PostgreSQL process failed without a safe diagnostic';
}
async function createEncryptedBackup({ databaseUrl, keyFile, directory, retentionDays = 30, includeObjects = false, pgDump = 'pg_dump', pgRestore = 'pg_restore', now = new Date() }) {
  const target = parseSafeUrl(databaseUrl);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('Retenção inválida.');
  const key = await readKey(keyFile);
  const absolute = path.resolve(directory); await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('Diretório de backup inseguro.');
  if (includeObjects) throw new Error('Backup de objetos ainda exige integração de provider dedicada.');
  const started = spawnStream(pgDump, ['--format=custom', '--no-password', `--dbname=${databaseUrl}`]);
  let written = null;
  try {
    const { createFilesystemBackupProvider } = require('./backup-provider');
    const provider = await createFilesystemBackupProvider({ directory: absolute });
    written = await provider.write(Readable.from(encryptedStream(started.stream, key)));
    await started.done;
    const plainTemp = path.join(require('node:os').tmpdir(), `rotamoto-backup-verify-${crypto.randomUUID()}.dump`);
    try {
      await pipeline(Readable.from(decryptedStream(path.join(absolute, `${written.id}.dump`), key,
        await readArtifactHeader(path.join(absolute, `${written.id}.dump`)))), require('node:fs').createWriteStream(plainTemp, { flags: 'wx', mode: 0o600 }));
      const list = spawn(pgRestore, ['--list', plainTemp], { stdio: ['ignore', 'ignore', 'ignore'] });
      await new Promise((resolve, reject) => list.once('close', code => code === 0 ? resolve() : reject(new Error('pg_restore não validou o dump.'))));
    } finally { await fs.unlink(plainTemp).catch(() => {}); }
    const unsigned = { version: 1, id: written.id, format: 'pg_dump-custom+a256gcm', database: target.database,
      createdAt: now.toISOString(), sizeBytes: written.sizeBytes, sha256: written.sha256, retentionDays, objectsIncluded: includeObjects };
    const manifest = Object.freeze({ ...unsigned, manifestMac: crypto.createHmac('sha256', key).update(JSON.stringify(unsigned)).digest('hex') });
    const manifestPath = path.join(absolute, `${written.id}.manifest.json`), temp = `${manifestPath}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(manifest)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, manifestPath);
    const directoryHandle = await fs.open(absolute, require('node:fs').constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    key.fill(0);
    await pruneExpiredBackups({ directory: absolute, retentionDays, now });
    return manifest;
  } catch (error) {
    started.child.kill('SIGTERM'); key.fill(0);
    if (written) { await fs.unlink(path.join(absolute, `${written.id}.dump`)).catch(() => {}); await fs.unlink(path.join(absolute, `${written.id}.manifest.json`)).catch(() => {}); }
    throw error;
  }
}
async function readArtifactHeader(file) {
  const handle = await fs.open(file, 'r'), header = Buffer.alloc(MAGIC.length + 12);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Envelope de backup inválido.');
  return header;
}
async function pruneExpiredBackups({ directory, retentionDays, now = new Date() }) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('Retenção inválida.');
  const root = path.resolve(directory), cutoff = now.getTime() - retentionDays * 86_400_000;
  const removed = [];
  for (const name of await fs.readdir(root)) {
    if (!/^[0-9a-f-]{36}\.manifest\.json$/u.test(name)) continue;
    const id = name.slice(0, -'.manifest.json'.length), manifestPath = path.join(root, name), dumpPath = path.join(root, `${id}.dump`);
    const stat = await fs.lstat(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) continue;
    let manifest; try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch (_) { continue; }
    if (manifest.version !== 1 || manifest.id !== id || !Number.isFinite(Date.parse(manifest.createdAt)) || Date.parse(manifest.createdAt) > cutoff) continue;
    let dumpStat; try { dumpStat = await fs.lstat(dumpPath); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (dumpStat.isSymbolicLink() || !dumpStat.isFile() || (dumpStat.mode & 0o077) || (typeof process.getuid === 'function' && dumpStat.uid !== process.getuid())) continue;
    await fs.unlink(dumpPath); await fs.unlink(manifestPath); removed.push(id);
  }
  return removed.length;
}
async function verifyArtifact({ directory, id, keyFile = null }) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id)) throw new Error('Identificador de backup inválido.');
  const root = path.resolve(directory), manifestPath = path.join(root, `${id}.manifest.json`), artifactPath = path.join(root, `${id}.dump`);
  const mstat = await fs.lstat(manifestPath), astat = await fs.lstat(artifactPath);
  if (mstat.isSymbolicLink() || astat.isSymbolicLink() || (mstat.mode & 0o077) || (astat.mode & 0o077) || mstat.nlink !== 1 || astat.nlink !== 1 ||
      (typeof process.getuid === 'function' && (mstat.uid !== process.getuid() || astat.uid !== process.getuid()))) throw new Error('Artefato possui permissões inseguras.');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.id !== id || manifest.format !== 'pg_dump-custom+a256gcm' || !Number.isSafeInteger(manifest.sizeBytes)) throw new Error('Manifesto inválido.');
  if (astat.size !== manifest.sizeBytes) throw new Error('Checksum do backup inválido.');
  const hash = crypto.createHash('sha256'); for await (const chunk of require('node:fs').createReadStream(artifactPath)) hash.update(chunk);
  if (hash.digest('hex') !== manifest.sha256) throw new Error('Checksum do backup inválido.');
  if (keyFile) {
    const key = await readKey(keyFile);
    try {
      const { manifestMac, ...unsigned } = manifest;
      const expected = crypto.createHmac('sha256', key).update(JSON.stringify(unsigned)).digest();
      const saved = Buffer.from(String(manifestMac || ''), 'hex');
      if (saved.length !== expected.length || !crypto.timingSafeEqual(saved, expected)) throw new Error('Autenticidade do manifesto inválida.');
    } finally { key.fill(0); }
  }
  const handle = await fs.open(artifactPath, 'r'); const header = Buffer.alloc(MAGIC.length + 12);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (astat.size < header.length + 16 || !header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Envelope de backup inválido.');
  return { manifest, artifactPath, header, root };
}
async function* decryptedStream(file, key, header) {
  const iv = header.subarray(MAGIC.length), decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  let pending = Buffer.alloc(0), started = false;
  for await (const chunk of require('node:fs').createReadStream(file)) {
    let data = chunk;
    if (!started) { data = data.subarray(header.length); started = true; }
    pending = Buffer.concat([pending, data]);
    if (pending.length > 16) { const available = pending.length - 16; const plain = decipher.update(pending.subarray(0, available)); if (plain.length) yield plain; pending = pending.subarray(available); }
  }
  if (pending.length !== 16) throw new Error('Envelope de backup truncado.');
  decipher.setAuthTag(pending); const final = decipher.final(); if (final.length) yield final;
}
async function restoreEncryptedBackup({ directory, id, targetUrl, keyFile, pgRestore = 'pg_restore', tempDirectory = require('node:os').tmpdir() }) {
  const target = parseSafeUrl(targetUrl, { restore: true }), { manifest, artifactPath, header } = await verifyArtifact({ directory, id, keyFile });
  const key = await readKey(keyFile);
  const temp = path.join(tempDirectory, `rotamoto-restore-${crypto.randomUUID()}.dump`);
  try {
    await pipeline(Readable.from(decryptedStream(artifactPath, key, header)), require('node:fs').createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    const list = spawn(pgRestore, ['--list', temp], { stdio: ['ignore', 'ignore', 'ignore'] });
    await new Promise((resolve, reject) => list.once('close', code => code === 0 ? resolve() : reject(new Error('Dump inválido para restore.'))));
    // Restores run as the disposable database owner, not as the source object
    // owners. Do not replay source ACL/default-ACL commands (which can require
    // membership in rotamoto_migrator); stop at the first SQL restore error.
    const restore = spawnStream(pgRestore, ['--no-password', '--no-owner', '--no-acl', '--exit-on-error', '--clean', '--if-exists', `--dbname=${targetUrl}`, temp]);
    restore.stream.resume(); await restore.done;
    return Object.freeze({ restored: true, database: target.database, backupId: manifest.id });
  } finally { key.fill(0); await fs.unlink(temp).catch(() => {}); }
}

module.exports = { parseSafeUrl, createEncryptedBackup, verifyArtifact, restoreEncryptedBackup, encryptedStream, pruneExpiredBackups, classifyPgDiagnostic };
