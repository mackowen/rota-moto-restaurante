'use strict';

const { backupRuntimePolicy } = require('./backup-platform');
function parseUid(value) { return /^\d+$/u.test(String(value || '')) ? Number(value) : null; }
function parseGid(value) { const gid = parseUid(value); return Number.isSafeInteger(gid) && gid > 0 ? gid : null; }
function inGroup(gid, groups = process.getgroups?.() || []) { return typeof process.getgid === 'function' && (process.getgid() === gid || groups.includes(gid)); }
function syntheticCampaign(env) { return env.NODE_ENV === 'test' && ['0228', '0229'].includes(env.ROTAMOTO_DISPOSABLE_CAMPAIGN); }
function backupWebProcessAllowed(env = process.env, uid = process.getuid?.(), groups = process.getgroups?.()) {
  return backupRuntimePolicy({ env, uid, groups, role: 'web' }).enabled;
}
function backupExecutorProcessAllowed(env = process.env, uid = process.getuid?.(), groups = process.getgroups?.()) {
  return backupRuntimePolicy({ env, uid, groups, role: 'executor' }).enabled;
}
module.exports = { parseUid, parseGid, inGroup, syntheticCampaign, backupWebProcessAllowed, backupExecutorProcessAllowed };
