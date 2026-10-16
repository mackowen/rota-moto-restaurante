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
function canonicalQuery(query = {}) {
  const pairs = [];
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) pairs.push([awsEncode(key), awsEncode(String(item))]);
  }
  return pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([key, value]) => `${key}=${value}`).join('&');
}
function xmlText(value) { return value.replace(/&(?:amp|lt|gt|quot|apos);/gu, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]); }
function createS3BackupProvider({ endpoint, bucket, region = 'us-east-1', accessKeyId, secretAccessKey, sessionToken = '', test = false, fetchImpl = globalThis.fetch, clock = () => new Date() }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,62}$/u.test(bucket || '') || !/^[a-z0-9-]{1,64}$/u.test(region || '') ||
      !/^[A-Z0-9]{8,128}$/u.test(accessKeyId || '') || typeof secretAccessKey !== 'string' || secretAccessKey.length < 16 || /[\r\n]/u.test(secretAccessKey) ||
      sessionToken && /[\r\n]/u.test(sessionToken) || typeof fetchImpl !== 'function') fail('BACKUP_S3_CONFIGURATION_INVALID');
  let basePromise;
  async function signed(method, key, body, extra = {}, query = {}) {
    const base = await (basePromise ||= validatePublicEndpoint(endpoint, { test }));
    const objectKey = key === null ? '' : validateObjectPath(key);
    const basePath = `${base.pathname.replace(/\/$/u, '')}/${awsEncode(bucket)}`;
    const url = new URL(`${basePath}${objectKey ? `/${objectKey.split('/').map(awsEncode).join('/')}` : ''}`, base.origin);
    const queryString = canonicalQuery(query); if (queryString) url.search = queryString;
    const now = clock().toISOString().replace(/[:-]|\.\d{3}/gu, ''), date = now.slice(0, 8);
    const payloadHash = body ? sha256(body) : sha256('');
    const headers = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': now, ...extra };
    if (sessionToken) headers['x-amz-security-token'] = sessionToken;
    const names = Object.keys(headers).map(x => x.toLowerCase()).sort(), canonicalHeaders = names.map(name => `${name}:${String(headers[name]).trim().replace(/\s+/gu, ' ')}\n`).join('');
    const canonical = [method, url.pathname, queryString, canonicalHeaders, names.join(';'), payloadHash].join('\n');
    const scope = `${date}/${region}/s3/aws4_request`, toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${sha256(canonical)}`;
    const hmac = (keyBytes, value) => crypto.createHmac('sha256', keyBytes).update(value).digest();
    const signingKey = hmac(hmac(hmac(hmac(Buffer.from(`AWS4${secretAccessKey}`), date), region), 's3'), 'aws4_request');
    const signature = hmac(signingKey, toSign).toString('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await fetchImpl(url, { method, headers, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
      catch (_) { if (attempt === 2) fail('BACKUP_REMOTE_RETRYABLE'); await new Promise(resolve => setTimeout(resolve, 100 * (2 ** attempt))); continue; }
      if (response.ok) return response;
      if ([408, 429].includes(response.status) || response.status >= 500) {
        if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 100 * (2 ** attempt))); continue; }
        fail('BACKUP_REMOTE_RETRYABLE');
      }
      if ([401, 403].includes(response.status)) fail('BACKUP_REMOTE_AUTH_REJECTED');
      if (response.status === 404) fail('BACKUP_REMOTE_OBJECT_NOT_FOUND');
      fail('BACKUP_REMOTE_REJECTED');
    }
    fail('BACKUP_REMOTE_RETRYABLE');
  }
  async function listObjects(prefix, continuationToken) {
    const query = { 'list-type': '2', prefix };
    if (continuationToken) query['continuation-token'] = continuationToken;
    const response = await signed('GET', null, null, {}, query), xml = await response.text();
    if (xml.length > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/iu.test(xml)) fail('BACKUP_REMOTE_RESPONSE_INVALID');
    const contents = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)].map(([, node]) => {
      const read = name => { const found = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'u').exec(node); return found ? xmlText(found[1]) : ''; };
      const key = read('Key'), sizeBytes = Number(read('Size'));
      validateObjectPath(key); if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) fail('BACKUP_REMOTE_RESPONSE_INVALID');
      return { key, sizeBytes, etag: read('ETag') };
    });
    const truncated = /<IsTruncated>true<\/IsTruncated>/u.test(xml);
    const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(xml)?.[1];
    if (truncated && !token) fail('BACKUP_REMOTE_RESPONSE_INVALID');
    return { objects: contents, nextToken: token ? xmlText(token) : null, truncated };
  }
  return Object.freeze({
    async put(key, bytes) { if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes); const digest = sha256(bytes); await signed('PUT', key, bytes, { 'content-type': 'application/octet-stream' }); return { sha256: digest, sizeBytes: bytes.length }; },
    async get(key) { return Buffer.from(await (await signed('GET', key)).arrayBuffer()); },
    async verify(key, expected) { const response = await signed('HEAD', key); const len = Number(response.headers.get('content-length')); if (len !== expected.sizeBytes || response.headers.get('x-amz-meta-sha256') !== expected.sha256) fail('BACKUP_REMOTE_VERIFY_FAILED'); const bytes = Buffer.from(await (await signed('GET', key)).arrayBuffer()); if (bytes.length !== expected.sizeBytes || sha256(bytes) !== expected.sha256) fail('BACKUP_REMOTE_VERIFY_FAILED'); return { verified: true, sizeBytes: len, sha256: expected.sha256 }; },
    async test() { const key = `rotamoto-backups/health/probe-${crypto.randomUUID()}`, bytes = crypto.randomBytes(32), expected = { sha256: sha256(bytes), sizeBytes: bytes.length }; await signed('PUT', key, bytes, { 'content-type': 'application/octet-stream', 'x-amz-meta-sha256': expected.sha256 }); try { await this.verify(key, expected); } finally { await signed('DELETE', key); } return { reachable: true, readWriteVerified: true }; },
    async publishSet({ directory, id, prefix = 'rotamoto-backups' }) { if (!ID.test(id || '')) fail('RECOVERY_SET_ID_INVALID'); validateObjectPath(prefix); const files = await listSafeFiles(path.join(path.resolve(directory), `${id}.set`)); if (!files.some(item => item.rel === 'set.json')) fail('RECOVERY_SET_INCOMPLETE');
      for (const file of files.filter(item => item.rel !== 'set.json')) { const bytes = await fs.readFile(file.full), hash = sha256(bytes), key = `${prefix}/${id}/${file.rel}`; await signed('PUT', key, bytes, { 'content-type': 'application/octet-stream', 'x-amz-meta-sha256': hash }); await this.verify(key, { sha256: hash, sizeBytes: bytes.length }); }
      const manifest = await fs.readFile(files.find(item => item.rel === 'set.json').full), key = `${prefix}/${id}/set.json`, hash = sha256(manifest); await signed('PUT', key, manifest, { 'content-type': 'application/json', 'x-amz-meta-sha256': hash }); await this.verify(key, { sha256: hash, sizeBytes: manifest.length }); return { published: true, fileCount: files.length, manifestSha256: hash }; }
    ,async listObjects(prefix = 'rotamoto-backups/') { validateObjectPath(prefix.replace(/\/$/u, '')); const objects = []; let token = null, pages = 0; do { if (++pages > 1000) fail('BACKUP_REMOTE_RESPONSE_INVALID'); const page = await listObjects(prefix, token); objects.push(...page.objects); token = page.nextToken; } while (token); return objects; }
    ,async listRecoverySets(prefix = 'rotamoto-backups') { validateObjectPath(prefix); const objects = await this.listObjects(`${prefix}/`), ids = [...new Set(objects.map(item => { const parts = item.key.slice(`${prefix}/`.length).split('/'); return parts.length === 2 && ID.test(parts[0]) && parts[1] === 'set.json' ? parts[0] : null; }).filter(Boolean))]; return ids.map(id => ({ id, manifestKey: `${prefix}/${id}/set.json` })); }
    ,async downloadSet({ id, directory, prefix = 'rotamoto-backups' }) { if (!ID.test(id || '') || !path.isAbsolute(directory || '')) fail('RECOVERY_SET_ID_INVALID'); const target = path.join(path.resolve(directory), `${id}.set`); try { await fs.lstat(target); fail('RECOVERY_SET_ALREADY_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const objects = await this.listObjects(`${prefix}/${id}/`); if (!objects.some(item => item.key === `${prefix}/${id}/set.json`) || objects.length > 10001) fail('RECOVERY_SET_INCOMPLETE');
      const stage = `${target}.staging-${crypto.randomUUID()}`; await fs.mkdir(stage, { mode: 0o700 });
      try { for (const item of objects) { const relative = item.key.slice(`${prefix}/${id}/`.length); validateObjectPath(relative); const bytes = await this.get(item.key); if (bytes.length !== item.sizeBytes) fail('BACKUP_REMOTE_VERIFY_FAILED'); const output = path.join(stage, ...relative.split('/')); await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 }); const handle = await fs.open(output, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
        await fs.mkdir(path.join(stage, 'media'), { recursive: true, mode: 0o700 });
        await fs.rename(stage, target); return { directory: target, fileCount: objects.length, downloaded: true };
      } catch (error) { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); throw error; } }
    ,async deleteSet({ id, prefix = 'rotamoto-backups', retainIds = [] }) { if (!ID.test(id || '') || retainIds.includes(id)) fail('BACKUP_REMOTE_RETENTION_BLOCKED'); const objects = await this.listObjects(`${prefix}/${id}/`); if (!objects.length) return { deleted: false, missing: true }; for (const item of objects.filter(item => !item.key.endsWith('/set.json'))) await signed('DELETE', item.key); const manifest = objects.find(item => item.key.endsWith('/set.json')); if (manifest) await signed('DELETE', manifest.key); return { deleted: true, id }; }
  });
}
async function listSafeFiles(root) { const result = []; async function visit(dir, prefix = '') { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (!SAFE_NAME.test(entry.name) || entry.name.startsWith('.')) fail('BACKUP_REMOTE_SET_INVALID'); const rel = prefix ? `${prefix}/${entry.name}` : entry.name, full = path.join(dir, entry.name); if (entry.isSymbolicLink()) fail('BACKUP_REMOTE_SET_INVALID'); if (entry.isDirectory()) await visit(full, rel); else if (entry.isFile()) result.push({ rel, full }); else fail('BACKUP_REMOTE_SET_INVALID'); } } await visit(root); return result.sort((a,b) => Number(a.rel === 'set.json') - Number(b.rel === 'set.json') || a.rel.localeCompare(b.rel)); }
function createSftpBackupProvider({ host, port = 22, username, identityFile, knownHostsFile, hostKey, remoteDirectory, execFile = spawn }) {
  if (!/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(host || '') || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^[a-zA-Z0-9._-]{1,64}$/u.test(username || '') || !path.isAbsolute(identityFile || '') || !path.isAbsolute(knownHostsFile || '') || !/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/u.test(hostKey || '')) fail('BACKUP_SFTP_CONFIGURATION_INVALID');
  validateRemoteDirectory(remoteDirectory);
  async function checkHostKey() { if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/u.test(hostKey || '')) fail('BACKUP_SFTP_HOST_KEY_REQUIRED'); const stat = await fs.lstat(knownHostsFile); if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('BACKUP_SFTP_HOST_KEY_REQUIRED'); const text = await fs.readFile(knownHostsFile, 'utf8'), knownHost = port !== 22 ? `[${host}]:${port}` : host; const valid = text.split(/\r?\n/u).some(line => { const parts = line.trim().split(/\s+/u); if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('|') || !parts[0].split(',').includes(knownHost)) return false; return `SHA256:${crypto.createHash('sha256').update(Buffer.from(parts[2], 'base64')).digest('base64').replace(/=+$/u, '')}` === hostKey; }); if (!valid) fail('BACKUP_SFTP_HOST_KEY_MISMATCH'); }
  const quote = value => { if (typeof value !== 'string' || /[\r\n"\\]/u.test(value)) fail('BACKUP_REMOTE_PATH_INVALID'); return `"${value}"`; };
  const run = async commands => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await checkHostKey();
      try { return await new Promise((resolve, reject) => {
      const args = ['-b', '-', '-P', String(port), '-i', identityFile, '-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oStrictHostKeyChecking=yes',
        '-oUserKnownHostsFile=' + knownHostsFile, '-oPasswordAuthentication=no', '-oKbdInteractiveAuthentication=no', '-oConnectTimeout=15', `${username}@${host}`];
      const child = execFile('sftp', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false }); let stdout = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill('SIGTERM'); finish(Object.assign(new Error('BACKUP_REMOTE_TIMEOUT'), { code: 'BACKUP_REMOTE_TIMEOUT' })); }, 30_000);
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 8 * 1024 * 1024) { child.kill('SIGTERM'); finish(Object.assign(new Error('BACKUP_REMOTE_RESPONSE_INVALID'), { code: 'BACKUP_REMOTE_RESPONSE_INVALID' })); } });
      child.stderr?.resume?.();
      child.on('error', () => finish(Object.assign(new Error('BACKUP_REMOTE_RETRYABLE'), { code: 'BACKUP_REMOTE_RETRYABLE' })));
      child.on('close', code => code === 0 ? finish(null, stdout) : finish(Object.assign(new Error(code === 255 ? 'BACKUP_REMOTE_RETRYABLE' : 'BACKUP_REMOTE_REJECTED'), { code: code === 255 ? 'BACKUP_REMOTE_RETRYABLE' : 'BACKUP_REMOTE_REJECTED' })));
      child.stdin.end(commands.join('\n') + '\n');
      }); } catch (error) {
        if (error.code !== 'BACKUP_REMOTE_RETRYABLE' || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * (2 ** attempt)));
      }
    }
    fail('BACKUP_REMOTE_RETRYABLE');
  };
  async function listDirectory(remote, baseKey, out, depth = 0) {
    if (depth > 12) fail('BACKUP_REMOTE_RESPONSE_INVALID');
    const output = await run([`ls -la ${quote(remote)}`]);
    for (const line of output.split(/\r?\n/u)) {
      const trimmed = line.trim(); if (!trimmed || /^(?:Connected to |sftp>)/u.test(trimmed)) continue;
      const parts = trimmed.split(/\s+/u), mode = parts[0];
      if (!/^[bcdlps-][rwxStTs-]{9}$/u.test(mode) || parts.length < 9) fail('BACKUP_REMOTE_RESPONSE_INVALID');
      let name = parts.slice(8).join(' ');
      const listedPrefix = `${remote.replace(/\/$/u, '')}/`; if (name.startsWith(listedPrefix)) name = name.slice(listedPrefix.length);
      if (name === '.' || name === '..') continue;
      if (mode[0] === 'd' && name.endsWith('/')) name = name.slice(0, -1);
      if (!SAFE_NAME.test(name) || name.startsWith('.')) fail('BACKUP_REMOTE_PATH_INVALID');
      const key = baseKey ? `${baseKey}/${name}` : name; validateObjectPath(key);
      if (mode[0] === 'l') fail('BACKUP_REMOTE_SYMLINK_REJECTED');
      if (mode[0] === 'd') await listDirectory(`${remote}/${name}`, key, out, depth + 1);
      else if (mode[0] === '-') out.push({ key, sizeBytes: Number(parts[4]) });
      else fail('BACKUP_REMOTE_PATH_INVALID');
    }
    return out;
  }
  async function listObjects(prefix = '') {
    if (prefix) validateObjectPath(prefix.replace(/\/$/u, ''));
    const rows = await listDirectory(remoteDirectory, '', []);
    return rows.filter(item => !prefix || item.key === prefix.replace(/\/$/u, '') || item.key.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));
  }
  return Object.freeze({
    async test() { await run(['pwd']); return { reachable: true, hostKeyVerified: true }; },
    async listObjects(prefix = '') { return listObjects(prefix); },
    async listRecoverySets() { const objects = await listObjects(), ids = [...new Set(objects.map(item => { const parts = item.key.split('/'); return parts.length === 2 && ID.test(parts[0]) && parts[1] === 'set.json' ? parts[0] : null; }).filter(Boolean))]; return ids.map(id => ({ id, manifestKey: `${id}/set.json` })); },
    async publishSet({ directory, id }) {
      if (!ID.test(id || '')) fail('RECOVERY_SET_ID_INVALID');
      const root = path.join(path.resolve(directory), `${id}.set`), files = await listSafeFiles(root);
      if (!files.some(file => file.rel === 'set.json')) fail('RECOVERY_SET_INCOMPLETE');
      const publishedPath = `${remoteDirectory}/${id}`, base = `${remoteDirectory}/${id}.staging`;
      const current = await listObjects(id);
      if (current.some(item => item.key.startsWith(`${id}/`))) {
        const manifest = current.find(item => item.key === `${id}/set.json`);
        if (manifest && current.length === files.length) {
          const probe = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'rotamoto-sftp-replay-'));
          try { for (const item of current) { const out = path.join(probe, ...item.key.split('/').slice(1)); await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 }); await run([`get ${quote(`${remoteDirectory}/${item.key}`)} ${quote(out)}`]); }
            const same = await Promise.all(files.map(async file => sha256(await fs.readFile(file.full)) === sha256(await fs.readFile(path.join(probe, ...file.rel.split('/'))))));
            if (same.every(Boolean)) return { published: true, alreadyPublished: true, fileCount: files.length };
          } finally { await fs.rm(probe, { recursive: true, force: true }); }
        }
        fail('BACKUP_REMOTE_CONFLICT');
      }
      await run([`-mkdir ${quote(base)}`]);
      for (const file of files.filter(item => item.rel !== 'set.json')) {
        const parts = file.rel.split('/');
        for (let index = 1; index < parts.length; index++) await run([`-mkdir ${quote(`${base}/${parts.slice(0, index).join('/')}`)}`]);
        await run([`put ${quote(file.full)} ${quote(`${base}/${validateObjectPath(file.rel)}`)}`]);
      }
      const temp = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'rotamoto-sftp-'));
      try {
        for (const file of files.filter(item => item.rel !== 'set.json')) {
          const out = path.join(temp, ...file.rel.split('/')); await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 });
          await run([`get ${quote(`${base}/${validateObjectPath(file.rel)}`)} ${quote(out)}`]);
          if (sha256(await fs.readFile(file.full)) !== sha256(await fs.readFile(out))) fail('BACKUP_REMOTE_VERIFY_FAILED');
        }
        const manifest = files.find(item => item.rel === 'set.json'); await run([`put ${quote(manifest.full)} ${quote(`${base}/set.json`)}`]);
        const manifestBytes = await fs.readFile(manifest.full), remoteManifest = path.join(temp, 'set.json');
        await run([`get ${quote(`${base}/set.json`)} ${quote(remoteManifest)}`]);
        if (sha256(manifestBytes) !== sha256(await fs.readFile(remoteManifest))) fail('BACKUP_REMOTE_VERIFY_FAILED');
        await run([`-rename ${quote(base)} ${quote(publishedPath)}`]);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
      return { published: true, fileCount: files.length };
    },
    async get(key) { const relative = validateObjectPath(key), temp = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'rotamoto-sftp-get-')), output = path.join(temp, 'object'); try { await run([`get ${quote(`${remoteDirectory}/${relative}`)} ${quote(output)}`]); return await fs.readFile(output); } finally { await fs.rm(temp, { recursive: true, force: true }); } },
    async downloadSet({ id, directory }) {
      if (!ID.test(id || '') || !path.isAbsolute(directory || '')) fail('RECOVERY_SET_ID_INVALID');
      const target = path.join(path.resolve(directory), `${id}.set`); try { await fs.lstat(target); fail('RECOVERY_SET_ALREADY_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const objects = await listObjects(id); if (!objects.some(item => item.key === `${id}/set.json`) || objects.length > 10001) fail('RECOVERY_SET_INCOMPLETE');
      const stage = `${target}.staging-${crypto.randomUUID()}`; await fs.mkdir(stage, { mode: 0o700 });
      try { for (const item of objects) { const relative = validateObjectPath(item.key.slice(id.length + 1)), output = path.join(stage, ...relative.split('/')); await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 }); await run([`get ${quote(`${remoteDirectory}/${item.key}`)} ${quote(output)}`]); const stat = await fs.lstat(output); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.sizeBytes) fail('BACKUP_REMOTE_VERIFY_FAILED'); }
        await fs.mkdir(path.join(stage, 'media'), { recursive: true, mode: 0o700 });
        await fs.rename(stage, target); return { directory: target, fileCount: objects.length, downloaded: true };
      } catch (error) { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); throw error; }
    },
    async deleteSet({ id, retainIds = [] }) {
      if (!ID.test(id || '') || retainIds.includes(id)) fail('BACKUP_REMOTE_RETENTION_BLOCKED');
      const objects = await listObjects(id); if (!objects.length) return { deleted: false, missing: true };
      const root = `${remoteDirectory}/${id}`;
      for (const item of objects.filter(item => !item.key.endsWith('/set.json')).sort((a, b) => b.key.split('/').length - a.key.split('/').length)) await run([`rm ${quote(`${remoteDirectory}/${item.key}`)}`]);
      const manifest = objects.find(item => item.key.endsWith('/set.json')); if (manifest) await run([`rm ${quote(`${remoteDirectory}/${manifest.key}`)}`]);
      const dirs = [...new Set(objects.map(item => item.key.split('/').slice(0, -1).join('/')).filter(dir => dir && dir !== id))].sort((a,b)=>b.length-a.length);
      for (const dir of dirs) await run([`rmdir ${quote(`${remoteDirectory}/${dir}`)}`]); await run([`rmdir ${quote(root)}`]); return { deleted: true, id };
    }
  });
}
module.exports = { createS3BackupProvider, createSftpBackupProvider, validatePublicEndpoint, validateObjectPath, validateRemoteDirectory, listSafeFiles, sha256 };
