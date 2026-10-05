'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createFileSecretProvider, contextOf } = require('./file-secret-provider');

async function safePrivate(pathname, directory) {
  const stat = await fs.lstat(pathname);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) || (!directory && stat.nlink !== 1)) throw new Error('Keystore/manifesto inseguro.');
  return stat;
}
async function writePrivate(file, bytes) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function syncFile(file) { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function rotateFileKeystore({ directory, masterKeyFile, manifestFile, now = new Date(), failpoint = null }) {
  if (![directory, masterKeyFile, manifestFile].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Paths absolutos obrigatórios.');
  const root = path.resolve(directory), keyPath = path.resolve(masterKeyFile), manifestPath = path.resolve(manifestFile);
  await safePrivate(root, true); await safePrivate(keyPath, false); await safePrivate(manifestPath, false);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest) || manifest.length > 10000) throw new Error('Manifesto de rotação inválido.');
  const refs = new Set();
  for (const item of manifest) { contextOf(item); if (typeof item.ref !== 'string' || refs.has(item.ref)) throw new Error('Manifesto de rotação inválido.'); refs.add(item.ref); }
  const files = await fs.readdir(root);
  if (files.some(name => !/^[0-9a-f-]{36}\.enc$/u.test(name)) || files.length !== refs.size ||
      files.some(name => !refs.has(`local-v1:${name.slice(0, -4)}`))) throw new Error('Manifesto não cobre integralmente o keystore local.');
  const oldProvider = await createFileSecretProvider({ directory: root, masterKeyFile: keyPath });
  const id = crypto.randomUUID(), backup = `${root}.rotation-backup-${id}`, staged = `${root}.rotation-new-${id}`;
  const keyTemp = `${keyPath}.rotation-new-${id}`, oldDir = `${root}.rotation-old-${id}`, oldKey = `${keyPath}.rotation-old-${id}`;
  const nextKey = crypto.randomBytes(32); let swappedDir = false, swappedKey = false;
  try {
    await fs.mkdir(backup, { mode: 0o700 }); await fs.mkdir(staged, { mode: 0o700 });
    const backupStat = await fs.lstat(backup); if (backupStat.mode & 0o077) throw new Error('Backup de rotação inseguro.');
    await fs.copyFile(keyPath, path.join(backup, 'master.key'), fs.constants.COPYFILE_EXCL);
    await fs.chmod(path.join(backup, 'master.key'), 0o600);
    await syncFile(path.join(backup, 'master.key'));
    for (const name of await fs.readdir(root)) { await safePrivate(path.join(root, name), false); await fs.copyFile(path.join(root, name), path.join(backup, name), fs.constants.COPYFILE_EXCL); await fs.chmod(path.join(backup, name), 0o600); await syncFile(path.join(backup, name)); }
    const backupHandle = await fs.open(backup, fs.constants.O_RDONLY); try { await backupHandle.sync(); } finally { await backupHandle.close(); }
    await writePrivate(keyTemp, nextKey);
    const stagedKey = `${staged}.key`; await writePrivate(stagedKey, nextKey);
    const nextProvider = await createFileSecretProvider({ directory: staged, masterKeyFile: stagedKey });
    for (const item of manifest) {
      const value = await oldProvider.get(item.ref, item);
      await nextProvider.put({ ...item, value });
      const check = await nextProvider.get(item.ref, item);
      if (!crypto.timingSafeEqual(Buffer.from(check), Buffer.from(value))) throw new Error('Validação criptográfica da rotação falhou.');
    }
    await fs.unlink(stagedKey);
    if (failpoint === 'before-swap') throw new Error('Falha simulada antes da troca.');
    await fs.rename(root, oldDir); swappedDir = true;
    await fs.rename(staged, root);
    if (failpoint === 'after-directory-swap') throw new Error('Falha simulada após troca do diretório.');
    await fs.rename(keyPath, oldKey); swappedKey = true;
    await fs.rename(keyTemp, keyPath);
    if (failpoint === 'after-key-swap') throw new Error('Falha simulada após troca da chave.');
    const active = await createFileSecretProvider({ directory: root, masterKeyFile: keyPath });
    for (const item of manifest) await active.get(item.ref, item);
    await fs.rm(oldDir, { recursive: true, force: true }); await fs.unlink(oldKey);
    const dir = await fs.open(root, fs.constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    return Object.freeze({ rotated: true, secrets: manifest.length, backupDirectory: backup, completedAt: now.toISOString() });
  } catch (error) {
    let rollbackSucceeded = true;
    if (swappedKey) { try { await fs.unlink(keyPath); } catch (failure) { if (failure.code !== 'ENOENT') rollbackSucceeded = false; }
      try { await fs.rename(oldKey, keyPath); } catch (_) { rollbackSucceeded = false; } }
    if (swappedDir) {
      try { await fs.rm(root, { recursive: true, force: true }); } catch (_) { rollbackSucceeded = false; }
      try { await fs.rename(oldDir, root); } catch (_) { rollbackSucceeded = false; }
    }
    await fs.rm(staged, { recursive: true, force: true }).catch(() => {}); await fs.unlink(keyTemp).catch(() => {});
    if (rollbackSucceeded) await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally { nextKey.fill(0); }
}
module.exports = { rotateFileKeystore };
