'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupAdminAuditLogger } = require('../backend/runtime/backup-admin-audit');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-backup-audit-'));
  try {
    const audit = createBackupAdminAuditLogger(path.join(root, 'backup-admin.jsonl'));
    const event = { actorRef: '09a9b439-7047-4b58-9682-8753da4a809f', action: 'backup.restore.approved',
      requestId: '45bd3cc4-4783-4b3d-aeba-fec111708fc9', objectId: 'aed0f0b5-738e-4f44-8a0b-8f5f32494ed3', result: 'accepted' };
    await audit(event); await audit({ ...event, action: 'backup.job.requested' });
    const lines = (await fs.readFile(path.join(root, 'backup-admin.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(lines.length, 2); assert.equal(lines[0].actorRef, event.actorRef);
    assert(!JSON.stringify(lines).match(/password|token|secret|credential/iu));
    assert.equal((await fs.stat(path.join(root, 'backup-admin.jsonl'))).mode & 0o077, 0);
    await assert.rejects(audit({ ...event, action: 'backup.restore.approved', actorRef: 'not-a-uuid' }), /BACKUP_ADMIN_AUDIT_ENTRY_INVALID/u);
    process.stdout.write('Backup admin audit: private append-only JSONL entries and strict sanitized schema PASS\n');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
