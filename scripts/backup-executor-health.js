'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

function waitLimit(args) {
  const raw = args.find(value => value.startsWith('--wait-ms='))?.slice('--wait-ms='.length) || '0';
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 30_000) throw new Error('BACKUP_HEALTH_WAIT_INVALID');
  return value;
}

async function inspect(directory, { now = Date.now(), maxAgeMs = 10_000 } = {}) {
  if (!path.isAbsolute(directory || '')) throw new Error('BACKUP_CONTROL_DIRECTORY_REQUIRED');
  const root = path.resolve(directory);
  const sharedGroupGid = /^\d+$/u.test(String(process.env.ROTAMOTO_BACKUP_CONTROL_GROUP_GID || ''))
    ? Number(process.env.ROTAMOTO_BACKUP_CONTROL_GROUP_GID) : null;
  const groupModeAllowed = dir => sharedGroupGid !== null && dir.gid === sharedGroupGid && (dir.mode & 0o2777) === 0o2770;
  const dir = await fs.lstat(root);
  const privateDirectory = (dir.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || dir.uid === process.getuid());
  if (dir.isSymbolicLink() || !dir.isDirectory() || !(privateDirectory || groupModeAllowed(dir))) throw new Error('BACKUP_CONTROL_DIRECTORY_UNSAFE');
  const statePath = path.join(root, 'control.json');
  const handle = await fs.open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    const privateFile = (stat.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
    const groupFile = sharedGroupGid !== null && stat.gid === sharedGroupGid && (stat.mode & 0o007) === 0 && (stat.mode & 0o060) === 0o060;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024 || !(privateFile || groupFile)) throw new Error('BACKUP_CONTROL_STATE_UNSAFE');
    const state = JSON.parse(await handle.readFile('utf8'));
    const heartbeatAt = Date.parse(state.executor?.lastHeartbeatAt || '');
    const ageMs = Number.isFinite(heartbeatAt) ? Math.max(0, now - heartbeatAt) : null;
    const online = state.executor?.status === 'ONLINE' && ageMs !== null && ageMs <= maxAgeMs;
    return { ok: online, state: online ? 'ONLINE' : ageMs === null ? 'UNKNOWN' : ageMs > maxAgeMs ? 'STALE' : 'OFFLINE',
      heartbeatAgeMs: ageMs, isolation: state.executor?.isolation || 'not-reported' };
  } finally { await handle.close(); }
}

async function main() {
  const directory = process.env.ROTAMOTO_BACKUP_CONTROL_DIRECTORY;
  const timeout = waitLimit(process.argv.slice(2)), deadline = Date.now() + timeout;
  let result;
  do {
    try { result = await inspect(directory); }
    catch (error) { result = { ok: false, state: 'UNAVAILABLE', code: /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : error.message }; }
    if (result.ok || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (true);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  process.stdout.write(`${JSON.stringify({ ok: false, state: 'UNAVAILABLE', code: /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'BACKUP_HEALTH_FAILED' })}\n`);
  process.exitCode = 1;
});

module.exports = { inspect, waitLimit };
