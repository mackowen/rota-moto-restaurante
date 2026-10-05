'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createFilesystemObjectStore } = require('../backend/domain/filesystem-object-store');
const { createFileSecretProvider, initializeFileSecretStore } = require('../backend/runtime/file-secret-provider');
const { generateSecret, codeAt, verifyCode, generateRecoveryCodes, recoveryDigest } = require('../backend/identity/totp');
const { createFilesystemBackupProvider } = require('../backend/runtime/backup-provider');

(async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'rotamoto-local-'));
  try {
    const keys = path.join(root, 'keys'), keyFile = path.join(root, 'master.key'), media = path.join(root, 'media'), backups = path.join(root, 'backups');
    await initializeFileSecretStore({ directory: keys, masterKeyFile: keyFile });
    const secrets = await createFileSecretProvider({ directory: keys, masterKeyFile: keyFile });
    const saved = await secrets.put({ name: 'smtp/password', scope: 'installation', value: 'secret-value' });
    assert.equal(await secrets.get(saved.secretRef, { name: 'smtp/password', scope: 'installation' }), 'secret-value');
    await assert.rejects(secrets.get(saved.secretRef, { name: 'smtp/password', scope: 'tenant', tenantId: '00000000-0000-4000-8000-000000000000' }));
    const objectStore = await createFilesystemObjectStore({ directory: await fs.mkdir(media, { mode: 0o700 }).then(() => media) });
    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0]);
    const stored = await objectStore.putProof({ companyId: '00000000-0000-4000-8000-000000000000', deliveryId: '00000000-0000-4000-8000-000000000001', contentType: 'image/png', source: Readable.from(png) });
    assert.equal((await objectStore.get(stored.reference, stored)).sha256, stored.sha256);
    await assert.rejects(objectStore.get({ provider: 'filesystem-v1', objectKey: '../../etc/passwd' }, stored));
    await assert.rejects(objectStore.putProof({ companyId: '00000000-0000-4000-8000-000000000000', deliveryId: '00000000-0000-4000-8000-000000000001', contentType: 'image/png', source: Readable.from(Buffer.from('not image')) }));
    const secret = generateSecret(), now = 1_800_000_000_000, code = codeAt(secret, Math.floor(now / 30000));
    const counter = verifyCode(secret, code, { now }); assert.equal(counter, Math.floor(now / 30000));
    assert.equal(verifyCode(secret, code, { now, lastCounter: counter }), null);
    const recovery = generateRecoveryCodes(); assert.equal(recovery.length, 10); assert.equal(recoveryDigest(recovery[0]).length, 32);
    const backup = await createFilesystemBackupProvider({ directory: backups });
    const backupResult = await backup.write(Readable.from(Buffer.from('test-backup')));
    assert.equal(backupResult.sizeBytes, 11); assert.equal((await fs.stat(path.join(backups, `${backupResult.id}.dump`))).mode & 0o077, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  process.stdout.write('Self-hosted foundation tests passed.\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
