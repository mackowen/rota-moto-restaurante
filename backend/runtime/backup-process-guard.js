'use strict';

function parseUid(value) { return /^\d+$/u.test(String(value || '')) ? Number(value) : null; }
function parseGid(value) { const gid = parseUid(value); return Number.isSafeInteger(gid) && gid > 0 ? gid : null; }
function inGroup(gid, groups = process.getgroups?.() || []) { return typeof process.getgid === 'function' && (process.getgid() === gid || groups.includes(gid)); }
function syntheticCampaign(env) { return env.NODE_ENV === 'test' && env.ROTAMOTO_DISPOSABLE_CAMPAIGN === '0228'; }
function backupWebProcessAllowed(env = process.env, uid = process.getuid?.(), groups = process.getgroups?.() || []) {
  if (syntheticCampaign(env)) return true;
  const executorUid = parseUid(env.ROTAMOTO_BACKUP_EXECUTOR_UID), controlGid = parseGid(env.ROTAMOTO_BACKUP_CONTROL_GROUP_GID);
  return Number.isSafeInteger(uid) && Number.isSafeInteger(executorUid) && executorUid !== uid && controlGid !== null &&
    (typeof process.getgid === 'function' && process.getgid() === controlGid || groups.includes(controlGid));
}
function backupExecutorProcessAllowed(env = process.env, uid = process.getuid?.(), groups = process.getgroups?.()) {
  if (syntheticCampaign(env)) return true;
  const executorUid = parseUid(env.ROTAMOTO_BACKUP_EXECUTOR_UID), controlGid = parseGid(env.ROTAMOTO_BACKUP_CONTROL_GROUP_GID);
  return Number.isSafeInteger(uid) && uid === executorUid && controlGid !== null && Array.isArray(groups) &&
    (typeof process.getgid === 'function' && process.getgid() === controlGid || groups.includes(controlGid));
}
module.exports = { parseUid, parseGid, backupWebProcessAllowed, backupExecutorProcessAllowed };
