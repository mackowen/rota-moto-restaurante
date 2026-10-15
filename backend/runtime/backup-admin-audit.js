'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const fsc = require('node:fs');

function createBackupAdminAuditLogger(file) {
  if (!path.isAbsolute(file || '')) throw Object.assign(new Error('BACKUP_ADMIN_AUDIT_CONFIGURATION_REQUIRED'), { code: 'BACKUP_ADMIN_AUDIT_CONFIGURATION_REQUIRED' });
  return async function appendBackupAdminAudit({ actorRef, action, requestId, objectId = null, result }) {
    if (!/^[0-9a-f-]{36}$/iu.test(actorRef || '') || !/^[a-z][a-z0-9_.-]{2,63}$/u.test(action || '') ||
        !/^[0-9a-f-]{36}$/iu.test(requestId || '') || objectId !== null && !/^[0-9a-f-]{36}$/iu.test(objectId) ||
        !['accepted', 'rejected'].includes(result)) throw Object.assign(new Error('BACKUP_ADMIN_AUDIT_ENTRY_INVALID'), { code: 'BACKUP_ADMIN_AUDIT_ENTRY_INVALID' });
    const parent = path.dirname(file), parentStat = await fs.lstat(parent);
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || (parentStat.mode & 0o077) ||
        typeof process.getuid === 'function' && parentStat.uid !== process.getuid())
      throw Object.assign(new Error('BACKUP_ADMIN_AUDIT_DIRECTORY_UNSAFE'), { code: 'BACKUP_ADMIN_AUDIT_DIRECTORY_UNSAFE' });
    const flags = fsc.constants.O_CREAT | fsc.constants.O_APPEND | fsc.constants.O_WRONLY | (fsc.constants.O_NOFOLLOW || 0);
    const handle = await fs.open(file, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid())
        throw Object.assign(new Error('BACKUP_ADMIN_AUDIT_FILE_UNSAFE'), { code: 'BACKUP_ADMIN_AUDIT_FILE_UNSAFE' });
      const record = { at: new Date().toISOString(), actorRef, action, requestId, ...(objectId ? { objectId } : {}), result };
      await handle.write(`${JSON.stringify(record)}\n`); await handle.sync();
    } finally { await handle.close(); }
  };
}
module.exports = { createBackupAdminAuditLogger };
