'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const REF = /^local-v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const NAME = /^[a-z][a-z0-9_.:/-]{1,95}$/u;
const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_SECRET_BYTES = 16 * 1024;

function invalidConfig(message) { const error = new Error(message); error.code = 'SECRET_STORE_CONFIGURATION_INVALID'; return error; }
function contextOf({ name, scope, tenantId = null }) {
  if (typeof name !== 'string' || !NAME.test(name) || !['installation', 'tenant'].includes(scope) ||
      (scope === 'tenant' && (typeof tenantId !== 'string' || !TENANT.test(tenantId))) ||
      (scope === 'installation' && tenantId !== null)) throw invalidConfig('Contexto do secret inválido.');
  return { name, scope, tenantId };
}
function aad(ref, context) { return Buffer.from(JSON.stringify({ version: 1, ref, ...context }), 'utf8'); }
function encodeEnvelope(key, ref, context, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(ref, context));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'),
    value: encrypted.toString('base64url') });
}
function decodeEnvelope(key, ref, context, envelopeText) {
  let envelope;
  try { envelope = JSON.parse(envelopeText); } catch (_) { throw invalidConfig('Secret cifrado inválido.'); }
  if (envelope?.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.value !== 'string') {
    throw invalidConfig('Secret cifrado inválido.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(aad(ref, context));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.value, 'base64url')), decipher.final()]).toString('utf8');
  } catch (_) { throw invalidConfig('Secret cifrado inválido ou contexto divergente.'); }
}
async function checkOwnedPath(target, { directory = false } = {}) {
  const resolved = path.resolve(target);
  const components = [];
  let cursor = resolved;
  while (cursor !== path.dirname(cursor)) { components.unshift(cursor); cursor = path.dirname(cursor); }
  for (const component of components) {
    const part = await fs.lstat(component);
    if (part.isSymbolicLink()) throw invalidConfig('Keystore não pode ter componentes symlink.');
  }
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 ||
      (!directory && stat.nlink !== 1)) throw invalidConfig('Keystore precisa ser próprio do serviço, sem symlink e sem permissões de grupo/outros.');
  return stat;
}
async function createFileSecretProvider({ directory, masterKeyFile } = {}) {
  if (!path.isAbsolute(directory || '') || !path.isAbsolute(masterKeyFile || '')) throw invalidConfig('Paths do keystore devem ser absolutos.');
  const secretDirectory = path.resolve(directory);
  const keyPath = path.resolve(masterKeyFile);
  await checkOwnedPath(secretDirectory, { directory: true });
  await checkOwnedPath(keyPath);
  const key = await fs.readFile(keyPath);
  if (key.length !== 32) throw invalidConfig('A master key deve conter exatamente 32 bytes.');
  const entries = await fs.readdir(secretDirectory);
  if (entries.some(name => !/^[0-9a-f-]{36}\.enc$/u.test(name))) throw invalidConfig('O diretório do keystore contém entrada não reconhecida.');

  function fileFor(ref) {
    const match = typeof ref === 'string' && REF.exec(ref);
    if (!match) throw invalidConfig('Referência de secret inválida.');
    return path.join(secretDirectory, `${match[1]}.enc`);
  }
  async function atomicWrite(file, text) {
    const temporary = path.join(secretDirectory, `.tmp-${crypto.randomUUID()}`);
    let handle;
    try {
      handle = await fs.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, file);
      const dir = await fs.open(secretDirectory, fs.constants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }
  return Object.freeze({
    async put({ name, scope, tenantId = null, value, ref = null }) {
      //
      const context = contextOf({ name, scope, tenantId });
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 1 || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
        throw invalidConfig('Secret fora do limite permitido.');
      }
      const secretRef = ref || `local-v1:${crypto.randomUUID()}`;
      const file = fileFor(secretRef);
      const envelope = encodeEnvelope(key, secretRef, context, value);
      await atomicWrite(file, envelope);
      return Object.freeze({ secretRef });
    },
    async get(ref, expectedContext) {
      const context = contextOf(expectedContext || {});
      const file = fileFor(ref);
      const stat = await checkOwnedPath(file);
      if (stat.size > MAX_SECRET_BYTES * 2) throw invalidConfig('Secret cifrado fora do limite permitido.');
      return decodeEnvelope(key, ref, context, await fs.readFile(file, 'utf8'));
    },
    async remove(ref) {
      const file = fileFor(ref);
      await checkOwnedPath(file);
      await fs.unlink(file);
    },
    status() { return Object.freeze({ configured: true, provider: 'filesystem-keystore-v1' }); }
  });
}

async function initializeFileSecretStore({ directory, masterKeyFile } = {}) {
  if (!path.isAbsolute(directory || '') || !path.isAbsolute(masterKeyFile || '')) throw invalidConfig('Paths do keystore devem ser absolutos.');
  const secretDirectory = path.resolve(directory);
  const keyPath = path.resolve(masterKeyFile);
  await fs.mkdir(secretDirectory, { recursive: true, mode: 0o700 });
  const dirStat = await fs.lstat(secretDirectory);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() ||
      (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) || (dirStat.mode & 0o077) !== 0) {
    throw invalidConfig('Diretório do keystore precisa pertencer ao serviço e usar modo 0700.');
  }
  const key = crypto.randomBytes(32);
  let handle;
  try {
    handle = await fs.open(keyPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(key);
    await handle.sync();
  } finally { if (handle) await handle.close(); key.fill(0); }
  await checkOwnedPath(keyPath);
  return Object.freeze({ initialized: true });
}

module.exports = { createFileSecretProvider, initializeFileSecretStore, contextOf, encodeEnvelope, decodeEnvelope };
