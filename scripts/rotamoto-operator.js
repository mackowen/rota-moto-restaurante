'use strict';
const fs = require('node:fs/promises');
const { loadRuntimeConfig } = require('../backend/runtime/config');
const { createFileSecretProvider } = require('../backend/runtime/file-secret-provider');
const { createSmtpMailProvider } = require('../backend/identity/smtp-mail-provider');
const crypto = require('node:crypto');
const path = require('node:path');
const { createEncryptedBackup, verifyArtifact, restoreEncryptedBackup } = require('../backend/runtime/backup-runner');
const { appendOperatorAudit } = require('../backend/runtime/operator-audit');
const { createFilesystemObjectStore } = require('../backend/domain/filesystem-object-store');
const { createFilesystemBackupProvider } = require('../backend/runtime/backup-provider');

(async () => {
  const command = process.argv[2] || 'status';
  const config = ['status', 'secret-put', 'smtp-verify'].includes(command) ? loadRuntimeConfig() : null;
  if (command === 'status') {
    let secrets = { configured: false, provider: null, status: 'not_configured' };
    let storage = { configured: false, provider: null, status: 'not_configured' };
    let backup = { configured: false, provider: null, status: 'not_configured' };
    let backupKey = { configured: false, status: 'not_configured' };
    if (config.mediaDirectory) {
      try { const provider = await createFilesystemObjectStore({ directory: config.mediaDirectory }); storage = { ...provider.status(), status: 'verified' }; }
      catch (_) { storage = { configured: true, provider: 'filesystem-v1', status: 'error' }; }
    }
    if (config.backupDirectory) {
      try { const provider = await createFilesystemBackupProvider({ directory: config.backupDirectory }); backup = { ...provider.status(), status: 'verified' }; }
      catch (_) { backup = { configured: true, provider: 'filesystem-backup-v1', status: 'error' }; }
    }
    if (process.env.ROTAMOTO_BACKUP_KEY_FILE) {
      try { const stat = await fs.lstat(process.env.ROTAMOTO_BACKUP_KEY_FILE); backupKey = { configured: true,
        status: stat.isFile() && !stat.isSymbolicLink() && stat.size === 32 && !(stat.mode & 0o077) && stat.nlink === 1 &&
          (typeof process.getuid !== 'function' || stat.uid === process.getuid()) ? 'verified' : 'error' }; }
      catch (_) { backupKey = { configured: true, status: 'error' }; }
    }
    if (config.secretStoreDirectory && config.secretMasterKeyFile) {
      try {
        const provider = await createFileSecretProvider({ directory: config.secretStoreDirectory, masterKeyFile: config.secretMasterKeyFile });
        secrets = { ...provider.status(), status: 'verified' };
      } catch (_) { secrets = { configured: true, provider: 'filesystem-keystore-v1', status: 'error' }; }
    } else if (config.secretProviderModule) secrets = { configured: true, provider: 'external', status: 'configured' };
    process.stdout.write(`${JSON.stringify({ installation: { storage,
      smtp: { configured: Boolean(config.smtp.host && config.smtp.passwordRef && config.smtp.from && config.smtp.baseUrl), status: config.smtp.host ? 'configured' : 'not_configured' },
      secrets, backup: { ...backup, key: backupKey, objectBackup: { configured: false, status: 'not_implemented' } },
      publicBaseUrl: config.smtp.baseUrl ? { configured: true, https: config.smtp.baseUrl.startsWith('https://') } : { configured: false },
      tenantSettings: { configurable: false, reason: 'Nenhuma preferência tenant-scoped está habilitada nesta superfície.' } } })}\n`);
    return;
  }
  if (command === 'secret-put') {
    const [name, label] = process.argv.slice(3);
    if (!config.secretStoreDirectory || !config.secretMasterKeyFile || !name || label !== 'installation') throw new Error('Uso requer keystore local e secret-put <nome> installation.');
    const chunks = []; let bytes = 0;
    for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 16384) throw new Error('Secret excede limite.'); chunks.push(chunk); }
    const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
    const provider = await createFileSecretProvider({ directory: config.secretStoreDirectory, masterKeyFile: config.secretMasterKeyFile });
    await appendOperatorAudit('secret.put.started', { name });
    const { secretRef } = await provider.put({ name, scope: 'installation', value });
    await appendOperatorAudit('secret.put.completed', { name, secretRef });
    process.stdout.write(`${JSON.stringify({ event: 'operator.secret.updated', configured: true, secretRef })}\n`);
    return;
  }
  if (command === 'smtp-verify') {
    if (!config.smtp.host || !config.smtp.passwordRef || !config.smtp.from || !config.smtp.baseUrl || !config.secretStoreDirectory || !config.secretMasterKeyFile) throw new Error('SMTP ou keystore não configurado.');
    const secrets = await createFileSecretProvider({ directory: config.secretStoreDirectory, masterKeyFile: config.secretMasterKeyFile });
    const password = await secrets.get(config.smtp.passwordRef, { name: 'smtp/password', scope: 'installation' });
    const mail = createSmtpMailProvider({ ...config.smtp, password });
    await mail.verify();
    await appendOperatorAudit('smtp.verify.completed', { host: config.smtp.host });
    process.stdout.write(`${JSON.stringify({ event: 'operator.smtp.verified', status: 'verified' })}\n`);
    return;
  }
  if (command === 'backup-key-init') {
    const target = process.env.ROTAMOTO_BACKUP_KEY_FILE;
    if (!target || !path.isAbsolute(target)) throw new Error('ROTAMOTO_BACKUP_KEY_FILE absoluto obrigatório.');
    await appendOperatorAudit('backup.key-init.started');
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    try { const handle = await fs.open(target, 'wx', 0o600); try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); } }
    finally { key.fill(0); }
    await appendOperatorAudit('backup.key-init.completed');
    process.stdout.write(`${JSON.stringify({ event: 'operator.backup_key.initialized', mode: '0600' })}\n`);
    return;
  }
  if (command === 'backup-create') {
    const databaseUrl = process.env.BACKUP_DATABASE_URL;
    const keyFile = process.env.ROTAMOTO_BACKUP_KEY_FILE;
    const directory = process.env.ROTAMOTO_BACKUP_DIRECTORY;
    const retentionDays = Number(process.env.ROTAMOTO_BACKUP_RETENTION_DAYS || 30);
    if (!databaseUrl || !keyFile || !directory) throw new Error('BACKUP_DATABASE_URL, ROTAMOTO_BACKUP_KEY_FILE e ROTAMOTO_BACKUP_DIRECTORY são obrigatórios.');
    await appendOperatorAudit('backup.create.started', { retentionDays });
    const manifest = await createEncryptedBackup({ databaseUrl, keyFile, directory, retentionDays });
    await appendOperatorAudit('backup.create.completed', { id: manifest.id, database: manifest.database, sizeBytes: manifest.sizeBytes });
    process.stdout.write(`${JSON.stringify({ event: 'operator.backup.created', ...manifest })}\n`);
    return;
  }
  if (command === 'backup-verify') {
    const directory = process.env.ROTAMOTO_BACKUP_DIRECTORY, id = process.argv[3];
    if (!directory || !id) throw new Error('Uso: backup-verify <id>.');
    const keyFile = process.env.ROTAMOTO_BACKUP_KEY_FILE;
    if (!keyFile) throw new Error('ROTAMOTO_BACKUP_KEY_FILE obrigatório para verificar manifesto.');
    const { manifest } = await verifyArtifact({ directory, id, keyFile });
    process.stdout.write(`${JSON.stringify({ event: 'operator.backup.verified', id: manifest.id, bytes: manifest.sizeBytes, sha256: manifest.sha256 })}\n`);
    return;
  }
  if (command === 'backup-restore') {
    const [id, targetUrl] = process.argv.slice(3), keyFile = process.env.ROTAMOTO_BACKUP_KEY_FILE;
    const directory = process.env.ROTAMOTO_BACKUP_DIRECTORY;
    if (!directory || !keyFile || !id || !targetUrl) throw new Error('Uso: backup-restore <id> <URL-explicita-do-alvo-descartavel>.');
    await appendOperatorAudit('backup.restore.started', { id, target: new URL(targetUrl).pathname.slice(1) });
    const result = await restoreEncryptedBackup({ directory, id, targetUrl, keyFile });
    await appendOperatorAudit('backup.restore.completed', { id: result.backupId, target: result.database });
    process.stdout.write(`${JSON.stringify({ event: 'operator.backup.restored', ...result })}\n`);
    return;
  }
  throw new Error('Comando de operador inválido.');
})().catch(error => { process.stderr.write(`${JSON.stringify({ event: 'operator.command.failed', code: /^[A-Z0-9_]{2,48}$/u.test(error.code || '') ? error.code : 'OPERATOR_CONFIGURATION_ERROR', ...(typeof error.safeDiagnostic === 'string' && /^[A-Za-z0-9 /()-]{1,96}$/u.test(error.safeDiagnostic) ? { diagnostic: error.safeDiagnostic } : {}) })}\n`); process.exitCode = 1; });
