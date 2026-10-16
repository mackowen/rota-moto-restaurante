'use strict';

function detectBackupPlatform(env = process.env, existsSync = require('node:fs').existsSync) {
  if (String(env.PREFIX || '').startsWith('/data/data/com.termux/files/usr') || env.TERMUX_VERSION)
    return 'termux';
  if (env.CONTAINER === 'true' || env.container || existsSync('/.dockerenv') || existsSync('/run/.containerenv'))
    return 'container';
  if (process.platform === 'linux') return 'linux';
  return 'unsupported';
}

function backupRuntimePolicy({ env = process.env, uid = process.getuid?.(), groups = process.getgroups?.() || [], role = 'web', platform = detectBackupPlatform(env) } = {}) {
  const executorUid = /^\d+$/u.test(String(env.ROTAMOTO_BACKUP_EXECUTOR_UID || '')) ? Number(env.ROTAMOTO_BACKUP_EXECUTOR_UID) : null;
  const groupGid = /^\d+$/u.test(String(env.ROTAMOTO_BACKUP_CONTROL_GROUP_GID || '')) ? Number(env.ROTAMOTO_BACKUP_CONTROL_GROUP_GID) : null;
  const inDedicatedGroup = Number.isSafeInteger(groupGid) && groupGid > 0 &&
    (typeof process.getgid === 'function' && process.getgid() === groupGid || groups.includes(groupGid));
  if ((platform === 'linux' || platform === 'container') && executorUid !== null && Number.isSafeInteger(uid) && groupGid && inDedicatedGroup) {
    const enabled = role === 'web' ? executorUid !== uid : executorUid === uid;
    return { enabled, platform, isolation: 'dedicated-uid-and-group', reason: enabled ? null : 'BACKUP_EXECUTOR_IDENTITY_INVALID' };
  }
  if (platform === 'termux' && env.ROTAMOTO_BACKUP_TERMUX_SHARED_UID === 'enabled' &&
      env.ROTAMOTO_BACKUP_TERMUX_SHARED_UID_RISK_ACK === 'HTTP_AND_EXECUTOR_SHARE_APP_UID' &&
      groupGid === null && executorUid !== null && executorUid === uid && Number.isSafeInteger(uid)) {
    return { enabled: true, platform, isolation: 'termux-shared-uid', reason: null };
  }
  if (env.NODE_ENV === 'test' && ['0228', '0229', '0230'].includes(env.ROTAMOTO_DISPOSABLE_CAMPAIGN))
    return { enabled: true, platform, isolation: 'synthetic-test', reason: null };
  return { enabled: false, platform, isolation: 'disabled', reason: 'BACKUP_PROCESS_ISOLATION_NOT_CONFIGURED' };
}

module.exports = { detectBackupPlatform, backupRuntimePolicy };
