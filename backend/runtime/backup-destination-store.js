'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { validatePublicEndpoint, validateRemoteDirectory } = require('./backup-storage-providers');

function bad(code) { throw Object.assign(new Error(code), { code }); }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function publicDestination(item) { const { credentials, identityFile, knownHostsFile, ...safe } = item; return { ...safe, credentialConfigured: Boolean(credentials || identityFile), credentials: undefined, identityFile: undefined, knownHostsFile: undefined }; }
async function verifyPinnedHostKey({ host, port, knownHostsFile, expectedFingerprint }) {
  let stat, text;
  try { stat = await fs.lstat(knownHostsFile); text = await fs.readFile(knownHostsFile, 'utf8'); } catch (_) { bad('BACKUP_SFTP_HOST_KEY_REQUIRED'); }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid()) bad('BACKUP_SFTP_HOST_KEY_REQUIRED');
  const knownHost = port && port !== 22 ? `[${host}]:${port}` : host;
  const found = text.split(/\r?\n/u).some(line => {
    const parts = line.trim().split(/\s+/u); if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('|')) return false;
    if (!parts[0].split(',').includes(knownHost)) return false;
    try { return `SHA256:${crypto.createHash('sha256').update(Buffer.from(parts[2], 'base64')).digest('base64').replace(/=+$/u, '')}` === expectedFingerprint; } catch (_) { return false; }
  });
  if (!found) bad('BACKUP_SFTP_HOST_KEY_MISMATCH');
}
function validateDestination(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['id','name','provider','endpoint','bucket','region','prefix','username','host','port','remoteDirectory','identityFile','knownHostsFile','hostKey','hostKeyConfirmed','accessKeyId','secretAccessKey','sessionToken','active','retentionDays','minimumCopies','priority'].includes(k))) bad('BACKUP_DESTINATION_INVALID');
  const provider = input.provider, name = String(input.name || '').trim();
  if (!['s3','sftp'].includes(provider) || !name || name.length > 80 || /[\x00-\x1f]/u.test(name)) bad('BACKUP_DESTINATION_INVALID');
  const id = input.id || previous?.id || crypto.randomUUID(); if (!ID.test(id)) bad('BACKUP_DESTINATION_INVALID');
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650 || !Number.isInteger(input.minimumCopies ?? 1) || (input.minimumCopies ?? 1) < 1 || (input.minimumCopies ?? 1) > 10 || !Number.isInteger(input.priority ?? 100) || (input.priority ?? 100) < 1 || (input.priority ?? 100) > 10000) bad('BACKUP_DESTINATION_INVALID');
  if (provider === 's3') {
    if (typeof input.endpoint !== 'string' || !input.bucket || !input.region || !(input.accessKeyId || previous?.credentials?.accessKeyId) || !(input.secretAccessKey || previous?.credentials?.secretAccessKey)) bad('BACKUP_DESTINATION_CREDENTIAL_REQUIRED');
    if (input.secretAccessKey && (input.secretAccessKey.length < 16 || /[\r\n]/u.test(input.secretAccessKey)) || /[\r\n]/u.test(input.accessKeyId)) bad('BACKUP_DESTINATION_INVALID');
  } else {
    if (!(input.host || previous?.host) || !(input.username || previous?.username) || !(input.identityFile || previous?.identityFile) || !(input.knownHostsFile || previous?.knownHostsFile) || !(input.hostKey || previous?.hostKey) || !(input.remoteDirectory || previous?.remoteDirectory)) bad('BACKUP_DESTINATION_CREDENTIAL_REQUIRED');
    const port = Number(input.port || previous?.port || 22);
    if (!Number.isInteger(port) || port < 1 || port > 65535) bad('BACKUP_DESTINATION_INVALID');
    if (!/^SHA256:[A-Za-z0-9+/]{20,}={0,2}$/u.test(input.hostKey || previous?.hostKey)) bad('BACKUP_SFTP_HOST_KEY_REQUIRED');
    if ((input.hostKey || previous?.hostKey) !== previous?.hostKey && !input.hostKeyConfirmed) bad('BACKUP_SFTP_HOST_KEY_CONFIRMATION_REQUIRED');
    if (input.hostKeyConfirmed !== undefined && typeof input.hostKeyConfirmed !== 'boolean') bad('BACKUP_DESTINATION_INVALID');
  }
  const safe = { id, name, provider, active: input.active !== false, retentionDays: input.retentionDays, minimumCopies: input.minimumCopies ?? 1, priority: input.priority ?? 100 };
  const credentials = provider === 's3' ? { accessKeyId: input.accessKeyId || previous?.credentials?.accessKeyId, secretAccessKey: input.secretAccessKey || previous?.credentials?.secretAccessKey, sessionToken: input.sessionToken || previous?.credentials?.sessionToken || '' } : null;
  const prefix = input.prefix || previous?.prefix || 'rotamoto-backups';
  if (provider === 's3' && (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u.test(prefix) || prefix.includes('//') || prefix.split('/').some(part => !part || part === '.' || part === '..'))) bad('BACKUP_DESTINATION_INVALID');
  const connection = provider === 's3' ? { endpoint: input.endpoint, bucket: input.bucket, region: input.region, prefix } : {
    host: input.host || previous?.host, port: Number(input.port || previous?.port || 22), username: input.username || previous?.username,
    identityFile: input.identityFile || previous?.identityFile, knownHostsFile: input.knownHostsFile || previous?.knownHostsFile,
    hostKey: input.hostKey || previous?.hostKey, remoteDirectory: input.remoteDirectory || previous?.remoteDirectory };
  return { ...safe, ...connection, ...(previous?.lastTest ? { lastTest: previous.lastTest } : {}), credentials: provider === 's3' ? credentials : { identityFile: connection.identityFile, knownHostsFile: connection.knownHostsFile } };
}
function createBackupDestinationStore({ directory, keyFile, test = false, sharedGroupGid = null }) {
  if (!path.isAbsolute(directory || '') || !path.isAbsolute(keyFile || '')) bad('BACKUP_DESTINATION_STORE_CONFIGURATION_INVALID');
  const file = path.join(path.resolve(directory), 'destinations.enc');
  async function key() {
    let stat; try { stat = await fs.lstat(keyFile); } catch (_) { bad('BACKUP_DESTINATION_KEY_UNAVAILABLE'); }
    const groups = typeof process.getgroups === 'function' ? process.getgroups() : [];
    const shared = sharedGroupGid !== null && Number.isInteger(sharedGroupGid) && (process.getgid?.() === sharedGroupGid || groups.includes(sharedGroupGid)) && stat.gid === sharedGroupGid && !(stat.mode & 0o007) && (stat.mode & 0o040);
    const owned = (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && !(stat.mode & 0o077);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size !== 32 || !owned && !shared) bad('BACKUP_DESTINATION_KEY_UNAVAILABLE');
    return crypto.createHash('sha256').update(await fs.readFile(keyFile)).digest();
  }
  async function decode() { let handle; try { handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (e) { if (e.code === 'ENOENT') return { version: 1, destinations: [] }; bad('BACKUP_DESTINATION_STORE_UNSAFE'); }
    let raw; try { const stat = await handle.stat(), groups = typeof process.getgroups === 'function' ? process.getgroups() : [], shared = sharedGroupGid !== null && stat.gid === sharedGroupGid && (process.getgid?.() === sharedGroupGid || groups.includes(sharedGroupGid)) && !(stat.mode & 0o007) && (stat.mode & 0o060) === 0o060, owned = (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && !(stat.mode & 0o077); if (!stat.isFile() || stat.nlink !== 1 || stat.size < 29 || stat.size > 4 * 1024 * 1024 || !owned && !shared) bad('BACKUP_DESTINATION_STORE_UNSAFE'); raw = await handle.readFile(); if (raw.length !== stat.size) bad('BACKUP_DESTINATION_STORE_UNSAFE'); } finally { await handle.close(); }
    const iv = raw.subarray(0,12), tag = raw.subarray(12,28), body = raw.subarray(28); try { const decipher = crypto.createDecipheriv('aes-256-gcm', await key(), iv); decipher.setAuthTag(tag); const value = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')); if (!value || value.version !== 1 || !Array.isArray(value.destinations)) bad('BACKUP_DESTINATION_STORE_INVALID'); return value; } catch (error) { if (error.code === 'BACKUP_DESTINATION_STORE_INVALID') throw error; bad('BACKUP_DESTINATION_STORE_INVALID'); } }
  async function encode(value) { await fs.mkdir(path.dirname(file), { recursive: true, mode: sharedGroupGid === null ? 0o700 : 0o2770 }); const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', await key(), iv); const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); const temp = `${file}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temp, Buffer.concat([iv,cipher.getAuthTag(),body]), { mode: sharedGroupGid === null ? 0o600 : 0o660, flag: 'wx' }); await fs.rename(temp,file); }
  return Object.freeze({
    async list() { const state = await decode(); return state.destinations.map(publicDestination); },
    async getActive() { return (await decode()).destinations.filter(d => d.active).sort((a,b) => a.priority - b.priority); },
    async save(input) { const state = await decode(); const previous = input.id ? state.destinations.find(d => d.id === input.id) : null; const dest = validateDestination(input, previous); if (state.destinations.some(d => d.id !== dest.id && d.name.toLowerCase() === dest.name.toLowerCase())) bad('BACKUP_DESTINATION_NAME_CONFLICT');
      if (dest.provider === 's3') await validatePublicEndpoint(dest.endpoint, { test });
      else { validateRemoteDirectory(dest.remoteDirectory); await verifyPinnedHostKey({ host: dest.host, port: dest.port, knownHostsFile: dest.knownHostsFile, expectedFingerprint: dest.hostKey }); }
      const index = state.destinations.findIndex(d => d.id === dest.id); index < 0 ? state.destinations.push(dest) : state.destinations.splice(index,1,dest); await encode(state); return publicDestination(dest); },
    async disable(id) { const state = await decode(), dest = state.destinations.find(d => d.id === id); if (!dest) bad('BACKUP_DESTINATION_NOT_FOUND'); dest.active = false; await encode(state); return publicDestination(dest); },
    async recordTest(id, outcome) { const state = await decode(), dest = state.destinations.find(d => d.id === id); if (!dest) bad('BACKUP_DESTINATION_NOT_FOUND');
      const errorCode = typeof outcome?.errorCode === 'string' && /^[A-Z0-9_]{2,64}$/u.test(outcome.errorCode) ? outcome.errorCode : null;
      dest.lastTest = { status: outcome?.ok === true ? 'TESTED' : 'FAILED', testedAt: new Date().toISOString(), ...(errorCode ? { errorCode } : {}), ...(outcome?.ok === true ? { transportVerified: true } : {}) };
      await encode(state); return publicDestination(dest); },
    async credentials(id) { const state = await decode(), dest = state.destinations.find(d => d.id === id); if (!dest) bad('BACKUP_DESTINATION_NOT_FOUND'); return { ...dest }; }
  });
}
module.exports = { createBackupDestinationStore, validateDestination, publicDestination, verifyPinnedHostKey };
