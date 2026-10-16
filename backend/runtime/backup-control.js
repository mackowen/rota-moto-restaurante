'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const FREQUENCIES = new Set(['disabled', 'daily', 'weekly']);
const TERMINAL = new Set(['SUCCEEDED', 'COMPLETED', 'FAILED', 'RETAINED', 'UNKNOWN_OUTCOME']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function controlError(code) { return Object.assign(new Error(code), { code }); }
function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['frequency', 'timeUtc', 'retentionDays', 'destination', 'rpoHours', 'rtoMinutes'].includes(key)) ||
      !FREQUENCIES.has(input.frequency) || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(input.timeUtc || '') ||
      !Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650 ||
      !['local', 'external'].includes(input.destination) ||
      input.rpoHours !== undefined && input.rpoHours !== null && (!Number.isInteger(input.rpoHours) || input.rpoHours < 1 || input.rpoHours > 8760) ||
      input.rtoMinutes !== undefined && input.rtoMinutes !== null && (!Number.isInteger(input.rtoMinutes) || input.rtoMinutes < 1 || input.rtoMinutes > 10080))
    throw controlError('BACKUP_CONFIG_INVALID');
  return { frequency: input.frequency, timeUtc: input.timeUtc, retentionDays: input.retentionDays, destination: input.destination,
    rpoHours: input.rpoHours ?? null, rtoMinutes: input.rtoMinutes ?? null };
}
function validateStoreDirectory(directory) {
  if (!path.isAbsolute(directory || '')) throw controlError('BACKUP_CONTROL_DIRECTORY_REQUIRED');
  return path.resolve(directory);
}
function groupMembership(groupGid) { return typeof process.getgid === 'function' && (process.getgid() === groupGid || process.getgroups?.().includes(groupGid)); }
async function ensurePrivateDirectory(directory, sharedGroupGid = null) {
  const full = validateStoreDirectory(directory);
  if (sharedGroupGid === null) await fs.mkdir(full, { recursive: true, mode: 0o700 });
  else if (!Number.isInteger(sharedGroupGid) || sharedGroupGid < 1 || !groupMembership(sharedGroupGid)) throw controlError('BACKUP_CONTROL_GROUP_NOT_AUTHORIZED');
  const stat = await fs.lstat(full);
  if (stat.isSymbolicLink() || !stat.isDirectory() || sharedGroupGid === null && ((stat.mode & 0o077) ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      sharedGroupGid !== null && (stat.gid !== sharedGroupGid || (stat.mode & 0o2777) !== 0o2770)) throw controlError('BACKUP_CONTROL_DIRECTORY_UNSAFE');
  return full;
}
async function atomicWrite(file, value, sharedGroupGid = null) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', sharedGroupGid === null ? 0o600 : 0o660);
  try { if (sharedGroupGid !== null) await handle.chmod(0o660); await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const stat = await fs.lstat(temp);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || sharedGroupGid !== null && stat.gid !== sharedGroupGid || sharedGroupGid === null && (stat.mode & 0o077)) {
    await fs.unlink(temp).catch(() => {}); throw controlError('BACKUP_CONTROL_STATE_UNSAFE');
  }
  await fs.rename(temp, file);
  const dir = await fs.open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
async function readStateFile(file, sharedGroupGid = null) {
  let handle;
  try { handle = await fs.open(file, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === 'ENOENT') throw error; throw controlError('BACKUP_CONTROL_STATE_UNSAFE'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024 ||
        sharedGroupGid === null && ((stat.mode & 0o077) || typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
        sharedGroupGid !== null && (stat.gid !== sharedGroupGid || (stat.mode & 0o007) || (stat.mode & 0o060) !== 0o060))
      throw controlError('BACKUP_CONTROL_STATE_UNSAFE');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function clearDeadLock(lockPath, sharedGroupGid = null) {
  let before;
  try { before = await fs.lstat(lockPath); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 ||
      sharedGroupGid === null && ((before.mode & 0o077) || typeof process.getuid === 'function' && before.uid !== process.getuid()) ||
      sharedGroupGid !== null && (before.gid !== sharedGroupGid || (before.mode & 0o007) || (before.mode & 0o060) !== 0o060)) throw controlError('BACKUP_CONTROL_LOCK_UNSAFE');
  let lock;
  try { lock = JSON.parse(await fs.readFile(lockPath, 'utf8')); }
  catch (_) {
    if (Date.now() - before.mtimeMs < 30_000) throw controlError('BACKUP_CONTROL_BUSY');
    const current = await fs.lstat(lockPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!current || current.dev !== before.dev || current.ino !== before.ino) return false;
    await fs.unlink(lockPath); return true;
  }
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 2 || !Number.isFinite(Date.parse(lock.at || ''))) throw controlError('BACKUP_CONTROL_LOCK_INVALID');
  try { process.kill(lock.pid, 0); return false; }
  catch (error) { if (error.code !== 'ESRCH') return false; }
  const current = await fs.lstat(lockPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!current || current.dev !== before.dev || current.ino !== before.ino) return false;
  await fs.unlink(lockPath); return true;
}
function initialState() {
  return { version: 1, config: { frequency: 'disabled', timeUtc: '02:00', retentionDays: 30, destination: 'local', rpoHours: null, rtoMinutes: null },
    nextRunAt: null, lastRun: null, inventory: { checkedAt: null, verified: 0, incomplete: 0, schemaState: 'UNKNOWN' },
    jobs: [], restoreRequests: [], lastScheduleSlot: null, executor: null };
}
function nextSchedule(config, now = new Date()) {
  if (config.frequency === 'disabled') return null;
  const [hour, minute] = config.timeUtc.split(':').map(Number);
  const date = new Date(now); date.setUTCHours(hour, minute, 0, 0);
  if (date <= now) date.setUTCDate(date.getUTCDate() + (config.frequency === 'weekly' ? 7 : 1));
  return date.toISOString();
}
function publicState(state, now = new Date()) {
  const lastRun = state.lastRun || null;
  const rpoAgeHours = lastRun?.completedAt ? Math.max(0, (now.getTime() - Date.parse(lastRun.completedAt)) / 3_600_000) : null;
  const alerts = [];
  if (lastRun?.status === 'failed') alerts.push({ code: 'BACKUP_LAST_RUN_FAILED', severity: 'critical' });
  if (state.nextRunAt && Date.parse(state.nextRunAt) < now.getTime()) alerts.push({ code: 'BACKUP_SCHEDULE_OVERDUE', severity: 'high' });
  if (state.config?.destination === 'external' && lastRun?.externalPublished !== true) alerts.push({ code: 'BACKUP_EXTERNAL_MISSING', severity: 'high' });
  const heartbeat = state.executor?.lastHeartbeatAt ? Date.parse(state.executor.lastHeartbeatAt) : NaN;
  const executor = { state: state.executor?.status === 'STOPPED' ? 'OFFLINE' :
    Number.isFinite(heartbeat) && now.getTime() - heartbeat <= 10_000 ? 'ONLINE' : Number.isFinite(heartbeat) ? 'STALE' : 'UNKNOWN',
    lastHeartbeatAt: Number.isFinite(heartbeat) ? state.executor.lastHeartbeatAt : null,
    isolation: state.executor?.isolation || 'not-reported' };
  return { config: state.config, nextRunAt: state.nextRunAt, lastRun,
    rpo: { ageHours: Number.isFinite(rpoAgeHours) ? Math.round(rpoAgeHours * 100) / 100 : null,
      targetHours: state.config?.rpoHours ?? null, withinTarget: state.config?.rpoHours && rpoAgeHours !== null ? rpoAgeHours <= state.config.rpoHours : null },
    rto: { lastRestoreDurationMs: lastRun?.status === 'restore_verified' ? lastRun.durationMs : null, targetMinutes: state.config?.rtoMinutes ?? null },
    executor, alerts, inventory: state.inventory, jobs: state.jobs.slice(-50).reverse().map(({ id, kind, status, createdAt, startedAt, finishedAt, progress, errorCode, actorRef }) =>
      ({ id, kind, status, createdAt, startedAt, finishedAt, progress, errorCode, actorRef })),
    restoreRequests: state.restoreRequests.slice(-20).reverse().map(({ id, recoverySetId, status, requestedAt, requestedBy, approvedAt, approvedBy, errorCode, jobId }) =>
      ({ id, recoverySetId, status, requestedAt, requestedBy, approvedAt, approvedBy, errorCode, jobId: jobId || null })) };
}
function createBackupControlStore({ directory, clock = () => new Date(), sharedGroupGid = null }) {
  const root = validateStoreDirectory(directory), stateFile = path.join(root, 'control.json'), lockPath = path.join(root, '.control.lock'),
    executorLockPath = path.join(root, '.executor.lock');
  async function openExclusiveLock(file, data) {
    await ensurePrivateDirectory(root, sharedGroupGid);
    let handle;
    try { handle = await fs.open(file, 'wx', sharedGroupGid === null ? 0o600 : 0o660); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!await clearDeadLock(file, sharedGroupGid)) throw controlError('BACKUP_EXECUTOR_ALREADY_RUNNING');
      try { handle = await fs.open(file, 'wx', sharedGroupGid === null ? 0o600 : 0o660); }
      catch (retryError) { if (retryError.code === 'EEXIST') throw controlError('BACKUP_EXECUTOR_ALREADY_RUNNING'); throw retryError; }
    }
    try { if (sharedGroupGid !== null) await handle.chmod(0o660); await handle.writeFile(JSON.stringify(data)); await handle.sync(); }
    catch (error) { await handle.close().catch(() => {}); await fs.unlink(file).catch(() => {}); throw error; }
    const stat = await handle.stat();
    let released = false;
    return async function release() {
      if (released) return; released = true; await handle.close();
      const current = await fs.lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (current && current.dev === stat.dev && current.ino === stat.ino) await fs.unlink(file);
    };
  }
  async function locked(operation) {
    await ensurePrivateDirectory(root, sharedGroupGid);
    let lock, attempt = 0;
    const deadline = Date.now() + 10_000;
    while (!lock) {
      try { lock = await fs.open(lockPath, 'wx', sharedGroupGid === null ? 0o600 : 0o660); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try { if (await clearDeadLock(lockPath, sharedGroupGid)) continue; }
        catch (lockError) { if (lockError.code !== 'BACKUP_CONTROL_BUSY') throw lockError; }
        if (Date.now() >= deadline) throw controlError('BACKUP_CONTROL_BUSY');
        attempt++;
        await new Promise(resolve => setTimeout(resolve, Math.min(75, 5 + attempt * 4)));
      }
    }
    try {
      if (sharedGroupGid !== null) await lock.chmod(0o660);
      await lock.writeFile(JSON.stringify({ pid: process.pid, at: clock().toISOString() })); await lock.sync();
      let state;
      try { state = JSON.parse(await readStateFile(stateFile, sharedGroupGid)); }
      catch (error) { if (error.code !== 'ENOENT') throw controlError('BACKUP_CONTROL_STATE_INVALID'); state = initialState(); }
      if (state.version !== 1 || !Array.isArray(state.jobs) || !Array.isArray(state.restoreRequests)) throw controlError('BACKUP_CONTROL_STATE_INVALID');
      const result = await operation(state);
      await atomicWrite(stateFile, state, sharedGroupGid);
      return result;
    } finally { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
  }
  return Object.freeze({
    async acquireExecutorLease(workerId) {
      if (typeof workerId !== 'string' || !/^backup-executor:[0-9a-f-]{36}$/u.test(workerId)) throw controlError('BACKUP_EXECUTOR_ID_INVALID');
      return openExclusiveLock(executorLockPath, { pid: process.pid, at: clock().toISOString(), workerId });
    },
    async read() { return locked(state => publicState(state, clock())); },
    async configure(input, actorRef) { const config = validateConfig(input); return locked(state => {
      state.config = config; state.nextRunAt = nextSchedule(config, clock()); state.updatedAt = clock().toISOString(); state.updatedBy = actorRef;
      return publicState(state, clock());
    }); },
    async enqueue(kind, actorRef, details = {}) { if (!['backup', 'verify', 'inventory'].includes(kind) ||
      kind === 'verify' && !UUID.test(details.recoverySetId || '') ||
      details.idempotencyKey !== undefined && (typeof details.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/u.test(details.idempotencyKey)))
      throw controlError('BACKUP_JOB_KIND_INVALID'); return locked(state => {
      if (details.idempotencyKey) {
        const prior = state.jobs.find(job => job.kind === kind && job.idempotencyKey === details.idempotencyKey);
        if (prior) return { ...prior, duplicate: true };
      }
      if (kind === 'backup' && state.jobs.some(job => job.kind === 'backup' && !TERMINAL.has(job.status))) throw controlError('BACKUP_JOB_ALREADY_ACTIVE');
      const job = { id: crypto.randomUUID(), kind, status: 'QUEUED', createdAt: clock().toISOString(), actorRef,
        ...(kind === 'verify' ? { recoverySetId: details.recoverySetId.toLowerCase() } : {}),
        progress: { phase: 'queued', percent: 0 }, idempotencyKey: details.idempotencyKey || crypto.randomUUID(), errorCode: null };
      state.jobs.push(job); if (state.jobs.length > 200) state.jobs = state.jobs.slice(-200); return { ...job };
    }); },
    async requestRestore(recoverySetId, actorRef) { if (!UUID.test(recoverySetId || '')) throw controlError('RECOVERY_SET_ID_INVALID'); return locked(state => {
      const prior = state.restoreRequests.find(item => item.recoverySetId === recoverySetId.toLowerCase() && ['PENDING_APPROVAL', 'APPROVED'].includes(item.status));
      if (prior) return { ...prior, duplicate: true };
      const request = { id: crypto.randomUUID(), recoverySetId: recoverySetId.toLowerCase(), requestedAt: clock().toISOString(), requestedBy: actorRef,
        status: 'PENDING_APPROVAL', approvedAt: null, approvedBy: null, errorCode: null };
      state.restoreRequests.push(request); return { ...request };
    }); },
    async approveRestore(requestId, actorRef, recentMfa) { if (!recentMfa) throw controlError('BACKUP_REAUTH_REQUIRED'); return locked(state => {
      const request = state.restoreRequests.find(item => item.id === requestId);
      if (!request) throw controlError('BACKUP_RESTORE_REQUEST_NOT_FOUND');
      if (request.status !== 'PENDING_APPROVAL') throw controlError('BACKUP_RESTORE_REQUEST_NOT_PENDING');
      if (request.requestedBy === actorRef) throw controlError('BACKUP_DUAL_APPROVAL_REQUIRED');
      request.approvedBy = actorRef; request.approvedAt = clock().toISOString(); request.status = 'APPROVED';
      const job = { id: crypto.randomUUID(), kind: 'restore_test', recoverySetId: request.recoverySetId, restoreRequestId: request.id,
        status: 'QUEUED', createdAt: clock().toISOString(), actorRef, progress: { phase: 'queued', percent: 0 }, errorCode: null };
      state.jobs.push(job); request.jobId = job.id; return { request: { ...request }, job: { ...job } };
    }); },
    async claimNext(workerId) { return locked(state => {
      if (state.jobs.some(item => item.status === 'RUNNING')) return null;
      const job = state.jobs.find(item => item.status === 'QUEUED'); if (!job) return null;
      job.status = 'RUNNING'; job.startedAt = clock().toISOString(); job.workerId = workerId;
      job.progress = { phase: 'starting', percent: 1 }; return { ...job };
    }); },
    async updateExecutorHeartbeat(workerId, status = 'ONLINE', isolation = 'not-reported') {
      if (typeof workerId !== 'string' || !/^backup-executor:[0-9a-f-]{36}$/u.test(workerId) || !['ONLINE', 'STOPPED'].includes(status) ||
          !['dedicated-uid-and-group', 'termux-shared-uid', 'synthetic-test', 'not-reported'].includes(isolation))
        throw controlError('BACKUP_EXECUTOR_HEARTBEAT_INVALID');
      return locked(state => { state.executor = { lastHeartbeatAt: clock().toISOString(), status, isolation }; return { ...state.executor }; });
    },
    async updateJob(id, update) { return locked(state => {
      const job = state.jobs.find(item => item.id === id); if (!job) throw controlError('BACKUP_JOB_NOT_FOUND');
      if (!['progress', 'result', 'errorCode', 'terminal'].includes(update.type)) throw controlError('BACKUP_JOB_UPDATE_INVALID');
      if (update.type === 'progress') job.progress = { phase: update.phase, percent: Math.max(1, Math.min(99, Math.floor(update.percent))) };
      if (update.type === 'result') { state.lastRun = update.lastRun; if (update.inventory) state.inventory = update.inventory; }
      if (update.type === 'errorCode') job.errorCode = /^[A-Z0-9_]{2,64}$/u.test(update.code || '') ? update.code : 'BACKUP_OPERATION_FAILED';
      if (update.type === 'terminal') {
        if (!['SUCCEEDED', 'COMPLETED', 'FAILED', 'UNKNOWN_OUTCOME'].includes(update.status)) throw controlError('BACKUP_JOB_STATUS_INVALID');
        job.status = update.status; job.finishedAt = clock().toISOString(); job.progress = { phase: update.status.toLowerCase(), percent: ['SUCCEEDED', 'COMPLETED'].includes(update.status) ? 100 : job.progress.percent };
        if (job.restoreRequestId) { const request = state.restoreRequests.find(item => item.id === job.restoreRequestId);
          if (request) { request.status = ['SUCCEEDED', 'COMPLETED'].includes(update.status) ? 'SUCCEEDED' : update.status; request.finishedAt = job.finishedAt; request.errorCode = job.errorCode || null; } }
      }
      return { ...job };
    }); },
    async recoverInterrupted() { return locked(state => {
      const interrupted = [];
      for (const job of state.jobs) if (job.status === 'RUNNING') { job.status = 'UNKNOWN_OUTCOME'; job.finishedAt = clock().toISOString(); job.errorCode = 'EXECUTOR_INTERRUPTED'; job.progress = { phase: 'review_required', percent: job.progress?.percent || 1 }; interrupted.push(job.id); }
      return interrupted;
    }); },
    async dueSchedule(now = clock()) { return locked(state => {
      if (!state.config || state.config.frequency === 'disabled' || !state.nextRunAt || Date.parse(state.nextRunAt) > now.getTime()) return null;
      const slot = state.nextRunAt;
      if (state.lastScheduleSlot === slot || state.jobs.some(job => job.kind === 'backup' && !TERMINAL.has(job.status))) { state.nextRunAt = nextSchedule(state.config, now); return null; }
      state.lastScheduleSlot = slot; state.nextRunAt = nextSchedule(state.config, now);
      const job = { id: crypto.randomUUID(), kind: 'backup', status: 'QUEUED', createdAt: now.toISOString(), actorRef: 'scheduler', scheduleSlot: slot,
        progress: { phase: 'queued', percent: 0 }, errorCode: null };
      state.jobs.push(job); return { ...job };
    }); },
    async health() { try { const st = await fs.stat(root); const lock = await fs.stat(lockPath).then(() => true, () => false);
      const ready = sharedGroupGid === null ? st.isDirectory() && !(st.mode & 0o077) : st.isDirectory() && st.gid === sharedGroupGid &&
        (st.mode & 0o2777) === 0o2770 && groupMembership(sharedGroupGid);
      return { ready, busy: lock }; } catch (_) { return { ready: false, busy: false }; } }
  });
}
module.exports = { createBackupControlStore, validateConfig, nextSchedule, publicState, controlError };
