'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const CONTENT_TYPES = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg' });
function storageError(code, message) { const error = new Error(message); error.code = code; return error; }
function safeDirectory(pathname, { create = false } = {}) {
  if (typeof pathname !== 'string' || !path.isAbsolute(pathname)) throw storageError('STORAGE_CONFIGURATION_INVALID', 'Storage path must be absolute.');
  return (async () => {
    const resolved = path.resolve(pathname);
    if (create) await fsp.mkdir(resolved, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
      throw storageError('STORAGE_CONFIGURATION_INVALID', 'Storage directory must be owned by the service, non-symlink and mode 0700.');
    }
    return resolved;
  })();
}
async function ensureSafeChild(root, pathname, { allowMissing = false } = {}) {
  const relative = path.relative(root, pathname);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw storageError('STORAGE_REFERENCE_INVALID', 'Storage reference is outside its root.');
  }
  const parts = relative.split(path.sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
        throw storageError('STORAGE_REFERENCE_INVALID', 'Symlinks are not permitted in storage paths.');
      }
      if (index === parts.length - 1 && ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || stat.nlink !== 1)) {
        throw storageError('STORAGE_REFERENCE_INVALID', 'Stored object permissions are unsafe.');
      }
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}
async function createFilesystemObjectStore({ directory } = {}) {
  const root = await safeDirectory(directory);
  const objectPath = reference => {
    if (!reference || reference.provider !== 'filesystem-v1' || typeof reference.objectKey !== 'string' ||
        !/^tenant\/[0-9a-f-]{36}\/delivery\/[0-9a-f-]{36}\/proof\/[0-9a-f-]{36}\.(?:png|jpg)$/u.test(reference.objectKey)) {
      throw storageError('STORAGE_REFERENCE_INVALID', 'Storage reference invalid.');
    }
    return path.join(root, ...reference.objectKey.split('/'));
  };
  return Object.freeze({
    provider: 'filesystem-v1',
    async putProof({ companyId, deliveryId, contentType, source, maxBytes = MAX_PROOF_BYTES }) {
      if (!UUID.test(companyId || '') || !UUID.test(deliveryId || '') || !Object.hasOwn(CONTENT_TYPES, contentType) ||
          !source || typeof source.pipe !== 'function' || maxBytes !== MAX_PROOF_BYTES) {
        throw storageError('MEDIA_INPUT_INVALID', 'Media metadata invalid.');
      }
      const objectId = crypto.randomUUID();
      const extension = CONTENT_TYPES[contentType];
      const objectKey = `tenant/${companyId}/delivery/${deliveryId}/proof/${objectId}${extension}`;
      const reference = Object.freeze({ provider: 'filesystem-v1', objectKey });
      const target = objectPath(reference);
      const parent = path.dirname(target);
      await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
      const relative = path.relative(root, parent).split(path.sep);
      let current = root;
      for (const part of relative) {
        current = path.join(current, part);
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) {
          throw storageError('STORAGE_REFERENCE_INVALID', 'Unsafe storage directory.');
        }
      }
      const temp = path.join(parent, `.upload-${crypto.randomUUID()}`);
      const hash = crypto.createHash('sha256');
      let sizeBytes = 0;
      let prefix = Buffer.alloc(0);
      let file;
      try {
        file = await fsp.open(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          sizeBytes += buffer.length;
          if (sizeBytes > MAX_PROOF_BYTES) throw storageError('MEDIA_TOO_LARGE', 'Media exceeds the allowed size.');
          if (prefix.length < 8) prefix = Buffer.concat([prefix, buffer.subarray(0, 8 - prefix.length)]);
          hash.update(buffer);
          await file.write(buffer);
        }
        const png = prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff;
        if (sizeBytes < 4 || (contentType === 'image/png' && !png) || (contentType === 'image/jpeg' && !jpeg)) {
          throw storageError('MEDIA_TYPE_INVALID', 'Media bytes do not match the declared image type.');
        }
        await file.sync();
        await file.close(); file = null;
        if (await ensureSafeChild(root, target, { allowMissing: true })) throw storageError('STORAGE_OBJECT_EXISTS', 'Storage object collision.');
        await fsp.rename(temp, target);
        const dir = await fsp.open(parent, fs.constants.O_RDONLY);
        try { await dir.sync(); } finally { await dir.close(); }
      } catch (error) {
        if (file) await file.close().catch(() => {});
        await fsp.unlink(temp).catch(() => {});
        throw error;
      }
      return Object.freeze({ reference, contentType, sizeBytes, sha256: hash.digest('hex') });
    },
    async get(reference, expected) {
      const file = objectPath(reference);
      await ensureSafeChild(root, file);
      const data = await fsp.readFile(file);
      if (!expected || expected.sizeBytes !== data.length || expected.sizeBytes > MAX_PROOF_BYTES ||
          !Object.hasOwn(CONTENT_TYPES, expected.contentType) || crypto.createHash('sha256').update(data).digest('hex') !== expected.sha256) {
        throw storageError('MEDIA_INTEGRITY_FAILED', 'Stored media integrity check failed.');
      }
      const validHeader = expected.contentType === 'image/png'
        ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
        : data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
      if (!validHeader) throw storageError('MEDIA_INTEGRITY_FAILED', 'Stored media type does not match metadata.');
      return Object.freeze({ data, contentType: expected.contentType, sizeBytes: data.length, sha256: expected.sha256 });
    },
    async remove(reference) {
      const file = objectPath(reference);
      await ensureSafeChild(root, file);
      await fsp.unlink(file);
    },
    async listProofObjects({ olderThan = new Date(0), limit = 500 } = {}) {
      if (!(olderThan instanceof Date) || !Number.isFinite(olderThan.getTime()) || !Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
        throw storageError('STORAGE_GC_INPUT_INVALID', 'GC parameters invalid.');
      }
      const base = path.join(root, 'tenant');
      try { await fsp.lstat(base); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const safeDir = async dir => {
        const stat = await fsp.lstat(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) return false;
        return true;
      };
      if (!await safeDir(base)) throw storageError('STORAGE_GC_UNSAFE_ENTRY', 'Unsafe storage entry skipped.');
      const result = [];
      for (const tenant of await fsp.readdir(base, { withFileTypes: true })) {
        if (!tenant.isDirectory() || !UUID.test(tenant.name)) continue;
        const tenantPath = path.join(base, tenant.name); if (!await safeDir(tenantPath)) continue;
        const deliveryRoot = path.join(tenantPath, 'delivery');
        let deliveries; try { deliveries = await fsp.readdir(deliveryRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!await safeDir(deliveryRoot)) continue;
        for (const delivery of deliveries) {
          if (!delivery.isDirectory() || !UUID.test(delivery.name)) continue;
          const proofRoot = path.join(deliveryRoot, delivery.name, 'proof');
          if (!await safeDir(path.dirname(proofRoot))) continue;
          let objects; try { objects = await fsp.readdir(proofRoot, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!await safeDir(proofRoot)) continue;
          for (const object of objects) {
            if (!object.isFile() || !/^[0-9a-f-]{36}\.(?:png|jpg)$/u.test(object.name)) continue;
            const objectKey = `tenant/${tenant.name}/delivery/${delivery.name}/proof/${object.name}`;
            const reference = { provider: 'filesystem-v1', objectKey };
            const file = objectPath(reference), stat = await fsp.lstat(file);
            if (stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) || stat.nlink !== 1) continue;
            if (stat.mtimeMs <= olderThan.getTime()) {
              result.push(Object.freeze({ reference, companyId: tenant.name, deliveryId: delivery.name, modifiedAt: new Date(stat.mtimeMs), sizeBytes: stat.size }));
              if (result.length >= limit) return result;
            }
          }
        }
      }
      return result;
    },
    status() { return Object.freeze({ configured: true, provider: 'filesystem-v1' }); }
  });
}

module.exports = { createFilesystemObjectStore, safeDirectory, ensureSafeChild, MAX_PROOF_BYTES };
