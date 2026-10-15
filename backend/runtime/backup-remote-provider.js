'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function validateRemoteUrl(value, { test = false } = {}) {
  let url; try { url = new URL(value); } catch (_) { throw new Error('BACKUP_REMOTE_CONFIGURATION_INVALID'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (!['https:', ...(test ? ['http:'] : [])].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      !url.pathname.endsWith('/') || url.pathname.includes('..') || url.protocol === 'http:' && !loopback || !test && loopback)
    throw new Error('BACKUP_REMOTE_CONFIGURATION_INVALID');
  return url;
}
async function listSafeFiles(root) {
  const result = [];
  async function visit(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) throw new Error('BACKUP_REMOTE_SET_INVALID');
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name, full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('BACKUP_REMOTE_SET_INVALID');
      if (entry.isDirectory()) await visit(full, rel);
      else if (entry.isFile()) result.push({ rel, full });
      else throw new Error('BACKUP_REMOTE_SET_INVALID');
    }
  }
  await visit(root);
  return result.sort((a, b) => Number(a.rel === 'set.json') - Number(b.rel === 'set.json') || a.rel.localeCompare(b.rel));
}
function createHttpBackupRemote({ baseUrl, token, test = false, fetchImpl = globalThis.fetch }) {
  const base = validateRemoteUrl(baseUrl, { test });
  if (typeof token !== 'string' || token.length < 24 || /[\r\n]/u.test(token)) throw new Error('BACKUP_REMOTE_CREDENTIAL_REQUIRED');
  if (typeof fetchImpl !== 'function') throw new Error('BACKUP_REMOTE_FETCH_UNAVAILABLE');
  async function request(method, url, body, headers = {}) {
    let response;
    try { response = await fetchImpl(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch (_) { throw new Error('BACKUP_REMOTE_UNAVAILABLE'); }
    if (!response.ok) throw new Error(response.status === 429 || response.status >= 500 ? 'BACKUP_REMOTE_RETRYABLE' : 'BACKUP_REMOTE_REJECTED');
    return response;
  }
  return Object.freeze({
    async publishSet({ directory, id }) {
      if (!/^[0-9a-f-]{36}$/iu.test(id || '')) throw new Error('RECOVERY_SET_ID_INVALID');
      const setRoot = path.join(path.resolve(directory), `${id}.set`);
      const files = await listSafeFiles(setRoot);
      if (!files.some(file => file.rel === 'set.json')) throw new Error('RECOVERY_SET_INCOMPLETE');
      for (const file of files) {
        const bytes = await fs.readFile(file.full), sha = crypto.createHash('sha256').update(bytes).digest('hex');
        const url = new URL(`sets/${id}/${file.rel.split('/').map(encodeURIComponent).join('/')}`, base);
        await request('PUT', url, bytes, { 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': sha, 'X-Set-State': 'staging' });
        const head = await request('HEAD', url);
        if (head.headers.get('x-content-sha256') !== sha || Number(head.headers.get('content-length')) !== bytes.length)
          throw new Error('BACKUP_REMOTE_VERIFY_FAILED');
      }
      const setFile = files.find(file => file.rel === 'set.json');
      const manifest = await fs.readFile(setFile.full);
      const publishUrl = new URL(`sets/${id}/publish`, base);
      await request('POST', publishUrl, JSON.stringify({ manifestSha256: crypto.createHash('sha256').update(manifest).digest('hex') }),
        { 'Content-Type': 'application/json' });
      return { published: true, fileCount: files.length };
    }
  });
}
module.exports = { validateRemoteUrl, listSafeFiles, createHttpBackupRemote };
