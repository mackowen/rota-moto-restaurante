'use strict';

// Durable, non-secret inventory for PostgreSQL E2E fixtures. Manifests are
// intentionally outside the repository and never authorize database cleanup.
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STATUSES = new Set(['PREPARING', 'RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED', 'RETAINED']);
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED', 'RETAINED']);
const DEFAULT_DIRECTORY = path.join(os.homedir(), '.local', 'state', 'rotamoto', 'e2e-fixtures');

function safeMetadata(value, key = '') {
  if (/(password|secret|token|cookie|csrf|credential|email|phone|address|pii)/iu.test(key)) {
    throw new Error(`Fixture manifest refuses sensitive field: ${key}`);
  }
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(item => safeMetadata(item));
  if (typeof value !== 'object') throw new Error('Fixture manifest metadata must be JSON-safe.');
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, safeMetadata(child, childKey)]));
}

async function atomicWrite(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temporary, file);
  const dirHandle = await fs.open(directory, 'r');
  try { await dirHandle.sync(); } finally { await dirHandle.close(); }
}

function validateRunId(runId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)) {
    throw new Error('Fixture runId must be a UUID.');
  }
}

async function createFixtureManifest({ campaign = 'unassigned', environment = 'rotamoto_e2e',
  directory = process.env.ROTAMOTO_E2E_MANIFEST_DIR || DEFAULT_DIRECTORY, runId = crypto.randomUUID(),
  evidence = [] } = {}) {
  validateRunId(runId);
  if (environment !== 'rotamoto_e2e') throw new Error('Fixture manifests accept only rotamoto_e2e.');
  if (typeof campaign !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/u.test(campaign)) throw new Error('Invalid campaign identifier.');
  const file = path.join(path.resolve(directory), `${runId}.json`);
  let data = { version: 1, runId, campaign, environment, status: 'PREPARING',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    owner: { pid: process.pid, hostname: os.hostname() },
    timestamps: { PREPARING: new Date().toISOString() }, history: [{ status: 'PREPARING', at: new Date().toISOString() }],
    tenants: [], records: {}, evidence: safeMetadata(evidence),
    retentionReason: null, lastError: null, databaseCommitted: false, tenantDatabaseCounts: [] };
  await atomicWrite(file, data);
  let queue = Promise.resolve();
  async function update({ status, tenants, records, evidence: nextEvidence, retentionReason, lastError,
    databaseCommitted, counts, tenantDatabaseCounts } = {}) {
    const operation = queue.then(async () => {
      const current = JSON.parse(await fs.readFile(file, 'utf8'));
      if (status && !STATUSES.has(status)) throw new Error('Unknown fixture manifest status.');
      if (status && TERMINAL.has(current.status) && status !== current.status && status !== 'RETAINED') {
        throw new Error(`Terminal fixture status cannot move from ${current.status} to ${status}.`);
      }
      if (status) { const at = new Date().toISOString(); current.status = status; current.timestamps[status] = at;
        current.history ||= []; current.history.push({ status, at }); }
      if (tenants) current.tenants = safeMetadata(tenants);
      if (records) current.records = safeMetadata(records);
      if (nextEvidence) current.evidence = safeMetadata(nextEvidence);
      if (retentionReason !== undefined) current.retentionReason = safeMetadata(retentionReason);
      if (lastError !== undefined) current.lastError = safeMetadata(lastError);
      if (databaseCommitted !== undefined) current.databaseCommitted = Boolean(databaseCommitted);
      if (counts !== undefined) current.counts = safeMetadata(counts);
      if (tenantDatabaseCounts !== undefined) current.tenantDatabaseCounts = safeMetadata(tenantDatabaseCounts);
      current.updatedAt = new Date().toISOString();
      await atomicWrite(file, current);
      data = current;
      return structuredClone(current);
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return Object.freeze({ runId, file, update, snapshot: () => structuredClone(data) });
}

async function readFixtureManifest(file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data.version !== 1 || !STATUSES.has(data.status) || data.environment !== 'rotamoto_e2e') {
    throw new Error(`Invalid fixture manifest: ${path.basename(file)}`);
  }
  return data;
}

async function updateFixtureManifest({ runId, directory = process.env.ROTAMOTO_E2E_MANIFEST_DIR || DEFAULT_DIRECTORY,
  tenantDatabaseCounts, evidence, status, retentionReason } = {}) {
  validateRunId(runId);
  const file = path.join(path.resolve(directory), `${runId}.json`);
  const current = await readFixtureManifest(file);
  const next = { ...current, updatedAt: new Date().toISOString() };
  if (status !== undefined) {
    if (!STATUSES.has(status)) throw new Error('Unknown fixture manifest status.');
    if (TERMINAL.has(current.status) && status !== current.status && status !== 'RETAINED') {
      throw new Error(`Terminal fixture status cannot move from ${current.status} to ${status}.`);
    }
    next.status = status;
    next.timestamps = { ...current.timestamps, [status]: next.updatedAt };
    next.history = [...(current.history || []), { status, at: next.updatedAt }];
  }
  if (retentionReason !== undefined) next.retentionReason = safeMetadata(retentionReason);
  if (tenantDatabaseCounts !== undefined) next.tenantDatabaseCounts = safeMetadata(tenantDatabaseCounts);
  if (evidence !== undefined) next.evidence = safeMetadata(evidence);
  await atomicWrite(file, next);
  return next;
}

async function resumeFixtureManifest({ runId, directory = process.env.ROTAMOTO_E2E_MANIFEST_DIR || DEFAULT_DIRECTORY,
  reason = 'Read-only fixture inventory/reconciliation resumed.' } = {}) {
  validateRunId(runId);
  const file = path.join(path.resolve(directory), `${runId}.json`);
  const current = await readFixtureManifest(file);
  if (current.status !== 'INTERRUPTED') throw new Error('Only an interrupted fixture manifest can be resumed.');
  const at = new Date().toISOString();
  const next = { ...current, status: 'RUNNING', updatedAt: at,
    owner: { pid: process.pid, hostname: os.hostname() },
    timestamps: { ...current.timestamps, RUNNING: at },
    history: [...(current.history || []), { status: 'RUNNING', at, reason: safeMetadata(reason) }],
    recoveryStage: 'inventory-only' };
  await atomicWrite(file, next);
  return next;
}

async function inventoryFixtureManifests({ directory = process.env.ROTAMOTO_E2E_MANIFEST_DIR || DEFAULT_DIRECTORY } = {}) {
  let files;
  try { files = await fs.readdir(path.resolve(directory)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const manifests = [];
  for (const name of files.filter(name => /^[0-9a-f-]{36}\.json$/iu.test(name)).sort()) {
    const file = path.join(path.resolve(directory), name);
    const manifest = await readFixtureManifest(file);
    manifests.push({ runId: manifest.runId, campaign: manifest.campaign, environment: manifest.environment,
      status: manifest.status, createdAt: manifest.createdAt, updatedAt: manifest.updatedAt,
      statusHistory: manifest.history || [], recoveryStage: manifest.recoveryStage || null,
      databaseCommitted: manifest.databaseCommitted, retentionReason: manifest.retentionReason,
      counts: { ...Object.fromEntries(Object.entries(manifest.records || {}).map(([kind, ids]) => [kind, Array.isArray(ids) ? ids.length : 0])),
        ...(manifest.counts || {}) },
      tenants: manifest.tenants.map(tenant => ({ id: tenant.id, counts: tenant.counts || {},
        databaseCounts: (manifest.tenantDatabaseCounts || []).find(item => item.tenantId === tenant.id)?.counts || null })),
      evidence: manifest.evidence });
  }
  return manifests;
}

async function markFixtureInterrupted({ runId, directory = process.env.ROTAMOTO_E2E_MANIFEST_DIR || DEFAULT_DIRECTORY,
  reason = 'process interruption recovery' } = {}) {
  validateRunId(runId);
  const file = path.join(path.resolve(directory), `${runId}.json`);
  const manifest = await readFixtureManifest(file);
  if (manifest.status !== 'RUNNING' && manifest.status !== 'PREPARING') return manifest;
  if (manifest.owner?.hostname !== os.hostname()) throw new Error('Cannot prove that the fixture owner process is inactive on another host.');
  try { process.kill(manifest.owner.pid, 0); throw new Error('Fixture owner process is still running; recovery refused.'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const manager = { async update(patch) {
    const current = await readFixtureManifest(file);
    const at = new Date().toISOString();
    const next = { ...current, ...patch, status: 'INTERRUPTED', updatedAt: at,
      timestamps: { ...current.timestamps, INTERRUPTED: at },
      history: [...(current.history || []), { status: 'INTERRUPTED', at }] };
    if (patch.lastError) next.lastError = safeMetadata(patch.lastError);
    await atomicWrite(file, next);
    return next;
  } };
  return manager.update({ lastError: reason });
}

module.exports = { createFixtureManifest, inventoryFixtureManifests, markFixtureInterrupted,
  readFixtureManifest, resumeFixtureManifest, updateFixtureManifest, safeMetadata, DEFAULT_DIRECTORY };
