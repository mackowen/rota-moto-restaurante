'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

async function createFilesystemBackupProvider({ directory }) {
  if (!path.isAbsolute(directory || '')) throw new Error('Backup path precisa ser absoluto.');
  const root = path.resolve(directory);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077))
    throw new Error('Diretório de backup inseguro.');
  return Object.freeze({
    async write(source) {
      if (!source || typeof source.pipe !== 'function') throw new TypeError('Backup exige stream.');
      const id = crypto.randomUUID(), temp = path.join(root, `.backup-${id}.tmp`), target = path.join(root, `${id}.dump`);
      const hash = crypto.createHash('sha256'); let bytes = 0;
      const handle = await fsp.open(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { for await (const chunk of source) { bytes += chunk.length; hash.update(chunk); await handle.write(chunk); } await handle.sync(); }
      catch (error) { await handle.close().catch(() => {}); await fsp.unlink(temp).catch(() => {}); throw error; }
      await handle.close(); await fsp.rename(temp, target); const dirHandle = await fsp.open(root, fs.constants.O_RDONLY); try { await dirHandle.sync(); } finally { await dirHandle.close(); }
      return Object.freeze({ id, sizeBytes: bytes, sha256: hash.digest('hex'), provider: 'filesystem-backup-v1' });
    },
    status() { return Object.freeze({ configured: true, provider: 'filesystem-backup-v1' }); }
  });
}
function createBackupProviderFactory({ localDirectory, remoteFactory = null }) {
  return Object.freeze({ local: () => createFilesystemBackupProvider({ directory: localDirectory }), remoteFactory });
}
module.exports = { createFilesystemBackupProvider, createBackupProviderFactory };
