'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const dns = require('node:dns/promises');
const { spawn } = require('node:child_process');

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
function fail(code) { throw Object.assign(new Error(code), { code }); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function validateObjectPath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..' || !SAFE_NAME.test(p))) fail('BACKUP_REMOTE_PATH_INVALID');
  return value;
}
function validateRemoteDirectory(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.endsWith('/') || value.slice(1).split('/').some(part => !SAFE_NAME.test(part) || part === '.' || part === '..')) fail('BACKUP_REMOTE_PATH_INVALID');
  return value;
}
function privateAddress(address) {
  const ip = address.toLowerCase();
  return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:') || ip.startsWith('::ffff:') ||
    /^127\./u.test(ip) || /^10\./u.test(ip) || /^192\.168\./u.test(ip) || /^169\.254\./u.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./u.test(ip) || ip === '0.0.0.0';
}
async function validatePublicEndpoint(value, { test = false, protocols = ['https:'] } = {}) {
  let url; try { url = new URL(value); } catch (_) { fail('BACKUP_REMOTE_ENDPOINT_INVALID'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (![...protocols, ...(test ? ['http:'] : [])].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.port && !/^\d{1,5}$/u.test(url.port) ||
      (url.protocol === 'http:' || loopback) && (!test || !loopback)) fail('BACKUP_REMOTE_ENDPOINT_INVALID');
  if (!loopback && !test) {
    const records = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => fail('BACKUP_REMOTE_ENDPOINT_INVALID'));
    if (!records.length || records.some(item => privateAddress(item.address))) fail('BACKUP_REMOTE_ENDPOINT_INVALID');
  }
  return url;
}
function awsEncode(value) { return encodeURIComponent(value).replace(/[!'()*]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); }
function createS3BackupProvider({ endpoint, bucket, region = 'us-east-1', accessKeyId, secretAccessKey, sessionToken = '', test = false, fetchImpl = globalThis.fetch, clock = () => new Date() }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/u.test(bucket || '') || !/^[a-z0-9-]{1,64}$/u.test(region || '') ||
      !/^[A-Z0-9]{8,128}$/u.test(accessKeyId || '') || typeof secretAccessKey !== 'string' || secretAccessKey.length < 16 || /[\r\n]/u.test(secretAccessKey) ||
      sessionToken && /[\r\n]/u.test(sessionToken) || typeof fetchImpl !== 'function') fail('BACKUP_S3_CONFIGURATION_INVALID');
  let basePromise;
  async function signed(method, key, body, extra = {}) {
    const base = await (basePromise ||= validatePublicEndpoint(endpoint, { test }));
    const objectKey = validateObjectPath(key);
    const url = new URL(`${base.pathname.replace(/\/$/u, '')}/${awsEncode(bucket)}/${objectKey.split('/').map(awsEncode).join('/')}`, base.origin);
    const now = clock().toISOString().replace(/[:-]|\.\d{3}/gu, ''), date = now.slice(0, 8);
    const payloadHash = body ? sha256(body) : sha256('');
    const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now, ...extra };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;
    const names = Object.keys(headers).map(x => x.toLowerCase()).sort(), canonicalHeaders = names.map(name => `${name}:${String(headers[name]).trim().replace(/\s+/gu, ' ')}\n`).join('');
    const canonical = [method, url.pathname, '', canonicalHeaders, names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`, toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha256(canonical)}`;
    const hmac = (keyBytes, value) => crypto.createHmac('sha256', keyBytes).update(value).digest();
    const signingKey = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${secretAccessKey}`), date), region), 's3'), 'aws4_request');
    const signature = hmac(signingKey, toSign).toString('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    let response; try { response = await fetchImpl(url, { method, headers, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch (_) { fail('BACKUP_REMOTE_RETRYABLE'); }
    if (!response.ok) fail(response.status === 429 || response.status >= 500 ? 'BACKUP_REMOTE_RETRYABLE' : 'BACKUP_REMOTE_REJECTED');
    return response;
  }
  return Object.freeze({
    async put(key, bytes) { if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes); const digest = sha256(bytes); await signed('PUT', key, bytes, { 'content-type': 'application/octet-stream' }); return { sha256: digest, sizeBytes: bytes.length }; },
    async get(key) { return Buffer.from(await (await signed('GET', key)).arrayBuffer()); },
    async verify(key, expected) { const response = await signed('HEAD', key); const len = Number(response.headers.get('content-length')); if (len !== expected.sizeBytes || response.headers.get('x-amz-meta-sha256') !== expected.sha256) fail('BACKUP_REMOTE_VERIFY_FAILED'); return { verified: true, sizeBytes: len, sha256: expected.sha256 }; },
    async test() { const key = `rotamoto-backups/health/probe-${crypto.randomUUID()}`, bytes = crypto.randomBytes(32), expected = { sha256: sha256(bytes), sizeBytes: bytes.length }; await signed('PUT', key, bytes, { 'content-type': 'application/octet-stream', 'x-amz-meta-sha256': expected.sha256 }); try { await this.verify(key, expected); } finally { await signed('DELETE', key); } return { reachable: true, readWriteVerified: true }; },
    async publishSet({ directory, id, prefix = 'rotamoto-backups' }) { if (!ID.test(id || '')) fail('RECOVERY_SET_ID_INVALID'); validateObjectPath(prefix); const files = await listSafeFiles(path.join(path.resolve(directory), `${id}.set`)); if (!files.some(item => item.rel === 'set.json')) fail('RECOVERY_SET_INCOMPLETE');
      for (const file of files.filter(item => item.rel !== 'set.json')) { const bytes = await fs.readFile(file.full), hash = sha256(bytes), key = `${prefix}/${id}/${file.rel}`; await signed('PUT', key, bytes, { 'content-type': 'application/octet-stream', 'x-amz-meta-sha256': hash }); await this.verify(key, { sha256: hash, sizeBytes: bytes.length }); }
      const manifest = await fs.readFile(files.find(item => item.rel === 'set.json').full), key = `${prefix}/${id}/set.json`, hash = sha256(manifest); await signed('PUT', key, manifest, { 'content-type': 'application/json', 'x-amz-meta-sha256': hash }); await this.verify(key, { sha256: hash, sizeBytes: manifest.length }); return { published: true, fileCount: files.length, manifestSha256: hash }; }
  });
}
async function listSafeFiles(root) { const result = []; async function visit(dir, prefix = '') { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (!SAFE_NAME.test(entry.name) || entry.name.startsWith('.')) fail('BACKUP_REMOTE_SET_INVALID'); const rel = prefix ? `${prefix}/${entry.name}` : entry.name, full = path.join(dir, entry.name); if (entry.isSymbolicLink()) fail('BACKUP_REMOTE_SET_INVALID'); if (entry.isDirectory()) await visit(full, rel); else if (entry.isFile()) result.push({ rel, full }); else fail('BACKUP_REMOTE_SET_INVALID'); } } await visit(root); return result.sort((a,b) => Number(a.rel === 'set.json') - Number(b.rel === 'set.json') || a.rel.localeCompare(b.rel)); }
function createSftpBackupProvider({ host, port = 22, username, identityFile, knownHostsFile, hostKey, remoteDirectory, execFile = spawn }) {
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(host || '') || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^[a-zA-Z0-9._-]{1,64}$/u.test(username || '') || !path.isAbsolute(identityFile || '') || !path.isAbsolute(knownHostsFile || '') || !/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/u.test(hostKey || '')) fail('BACKUP_SFTP_CONFIGURATION_INVALID');
  validateRemoteDirectory(remoteDirectory);
  async function checkHostKey() { if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/u.test(hostKey || '')) fail('BACKUP_SFTP_HOST_KEY_REQUIRED'); const stat = await fs.lstat(knownHostsFile); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('BACKUP_SFTP_HOST_KEY_REQUIRED'); const text = await fs.readFile(knownHostsFile, 'utf8'), knownHost = port !== 22 ? `[${host}]:${port}` : host; const valid = text.split(/\r?\n/u).some(line => { const parts = line.trim().split(/\s+/u); if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('|') || !parts[0].split(',').includes(knownHost)) return false; return `SHA256:${crypto.createHash('sha256').update(Buffer.from(parts[2], 'base64')).digest('base64').replace(/=+$/u, '')}` === hostKey; }); if (!valid) fail('BACKUP_SFTP_HOST_KEY_MISMATCH'); }
  const run = async (commands) => { await checkHostKey(); return new Promise((resolve, reject) => { const args = ['-b', '-', '-P', String(port), '-i', identityFile, '-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oStrictHostKeyChecking=yes', '-oUserKnownHostsFile=' + knownHostsFile, '-oPasswordAuthentication=no', '-oKbdInteractiveAuthentication=no', '-oConnectTimeout=15', `${username}@${host}`]; const child = execFile('sftp', args, { stdio: ['pipe', 'ignore', 'pipe'], shell: false }); child.on('error', () => reject(Object.assign(new Error('BACKUP_REMOTE_RETRYABLE'), { code: 'BACKUP_REMOTE_RETRYABLE' }))); child.on('close', code => code === 0 ? resolve() : reject(Object.assign(new Error(code === 255 ? 'BACKUP_REMOTE_RETRYABLE' : 'BACKUP_REMOTE_REJECTED'), { code: code === 255 ? 'BACKUP_REMOTE_RETRYABLE' : 'BACKUP_REMOTE_REJECTED' }))); child.stdin.end(commands.join('\n') + '\n'); }); };
  return Object.freeze({ async test() { await run(['pwd']); return { reachable: true }; }, async publishSet({ directory, id }) { if (!ID.test(id || '')) fail('RECOVERY_SET_ID_INVALID'); const root = path.join(path.resolve(directory), `${id}.set`), files = await listSafeFiles(root); if (!files.some(file => file.rel === 'set.json')) fail('RECOVERY_SET_INCOMPLETE'); const base = `${remoteDirectory}/${id}.staging`; await run([`-mkdir "${base}"`]); for (const file of files.filter(item => item.rel !== 'set.json')) { if (/[\r\n"\\]/u.test(file.full)) fail('BACKUP_REMOTE_PATH_INVALID'); const parts = file.rel.split('/'); for (let index = 1; index < parts.length; index++) await run([`-mkdir "${base}/${parts.slice(0, index).join('/')}"`]); const local = file.full; const remote = `${base}/${validateObjectPath(file.rel)}`; await run([`put "${local}" "${remote}"`]); }
      // OpenSSH sftp supports hashing inconsistently; download every transferred object to a private temporary file and compare before publication.
      const temp = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'rotamoto-sftp-'));
      try { for (const file of files.filter(item => item.rel !== 'set.json')) { const out = path.join(temp, path.basename(file.rel)); await run([`get "${base}/${validateObjectPath(file.rel)}" "${out}"`]); const expected = await fs.readFile(file.full), actual = await fs.readFile(out); if (!crypto.timingSafeEqual(Buffer.from(sha256(expected)), Buffer.from(sha256(actual)))) fail('BACKUP_REMOTE_VERIFY_FAILED'); await fs.unlink(out); }
        const manifest = files.find(item => item.rel === 'set.json'); if (/[\r\n"\\]/u.test(manifest.full)) fail('BACKUP_REMOTE_PATH_INVALID'); await run([`put "${manifest.full}" "${base}/set.json"`, `-rename "${base}" "${remoteDirectory}/${id}"`]);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
      return { published: true, fileCount: files.length };
    } });
}
module.exports = { createS3BackupProvider, createSftpBackupProvider, validatePublicEndpoint, validateObjectPath, validateRemoteDirectory, listSafeFiles, sha256 };
