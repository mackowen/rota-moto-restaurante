'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { createBackupControlStore } = require('./backup-control');
const { createRecoverySet, verifyRecoverySet, restoreRecoverySet, pruneRecoverySets } = require('./recovery-set');
const { inventoryRecoverySets } = require('./backup-inventory');
const { createHttpBackupRemote } = require('./backup-remote-provider');
const { appendOperatorAudit } = require('./operator-audit');
const { createClient } = require('../postgres/connection');
const { getMigrations } = require('../postgres/migrate');
const { backupRuntimePolicy } = require('./backup-platform');

function safeSyntheticSource(value, env = process.env) {
  const campaign = env.ROTAMOTO_DISPOSABLE_CAMPAIGN;
  if (!['0228', '0229', '0230'].includes(campaign) || typeof value !== 'string') return false;
  try {
    const url = new URL(value), database = decodeURIComponent(url.pathname.slice(1));
    return ['postgres:', 'postgresql:'].includes(url.protocol) && !url.password && !url.search && !url.hash &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase()) &&
      decodeURIComponent(url.username) === 'rotamoto_backup' && new RegExp(`^rotamoto_disposable_${campaign}_[a-z0-9_]{1,40}$`, 'u').test(database);
  } catch (_) { return false; }
}

function safeDisposableTarget(value, env = process.env) {
  const campaign = env.ROTAMOTO_DISPOSABLE_CAMPAIGN;
  if (!['0228', '0229', '0230'].includes(campaign) || typeof value !== 'string') return false;
  try {
    const url = new URL(value), database = decodeURIComponent(url.pathname.slice(1));
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname.toLowerCase());
    const allowedHosts = String(env.ROTAMOTO_DISPOSABLE_RESTORE_HOSTS || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
    const hostAllowed = env.NODE_ENV === 'test' ? loopback : env.ROTAMOTO_DISPOSABLE_RESTORE_ENABLED === 'true' && allowedHosts.includes(url.hostname.toLowerCase());
    return ['postgres:', 'postgresql:'].includes(url.protocol) && !url.password && !url.search && !url.hash && hostAllowed &&
      decodeURIComponent(url.username) === 'rotamoto_restore' && new RegExp(`^rotamoto_disposable_${campaign}_[a-z0-9_]{1,40}$`, 'u').test(database) &&
      !['rotamoto', 'rotamoto_e2e'].includes(database);
  } catch (_) { return false; }
}
async function verifyRestoredDatabase(targetUrl, clientFactory = options => createClient(options)) {
  const target = new URL(targetUrl), database = decodeURIComponent(target.pathname.slice(1));
  const client = clientFactory({ connectionString: targetUrl }); await client.connect();
  try {
    const identity = await client.query('SELECT current_database() AS database, current_user AS role');
    if (identity.rows[0]?.database !== database || identity.rows[0]?.role !== 'rotamoto_restore')
      throw Object.assign(new Error('RESTORE_TARGET_IDENTITY_MISMATCH'), { code: 'RESTORE_TARGET_IDENTITY_MISMATCH' });
    const ledger = await client.query('SELECT migration_id, checksum_sha256 FROM rotamoto.schema_migrations ORDER BY migration_id');
    const expected = getMigrations().map(row => ({ id: row.id, checksum: row.checksum }));
    const actual = ledger.rows.map(row => ({ id: String(row.migration_id), checksum: String(row.checksum_sha256).trim() }));
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Object.assign(new Error('RESTORE_SCHEMA_LEDGER_MISMATCH'), { code: 'RESTORE_SCHEMA_LEDGER_MISMATCH' });
    const structural = await client.query(`SELECT
      (SELECT count(*)::int FROM pg_catalog.pg_constraint WHERE connamespace='rotamoto'::regnamespace AND NOT convalidated) AS unvalidated_constraints,
      (SELECT count(*)::int FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class t ON t.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='rotamoto' AND NOT i.indisvalid) AS invalid_indexes,
      (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') AND c.relrowsecurity AND NOT c.relforcerowsecurity) AS rls_without_force,
      (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') AND c.relrowsecurity) AS rls_tables,
      (SELECT count(*)::int FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto') AS policies`);
    const checks = structural.rows[0];
    if (checks.unvalidated_constraints || checks.invalid_indexes || checks.rls_without_force)
      throw Object.assign(new Error('RESTORE_SCHEMA_INTEGRITY_FAILED'), { code: 'RESTORE_SCHEMA_INTEGRITY_FAILED' });
    return { database, migrationCount: actual.length, latestMigration: actual.at(-1)?.id || null,
      unvalidatedConstraints: checks.unvalidated_constraints, invalidIndexes: checks.invalid_indexes,
      rlsTables: checks.rls_tables, policies: checks.policies };
  } finally { await client.end(); }
}
async function assertEmptyDisposableTarget(targetUrl, clientFactory = options => createClient(options)) {
  const client = clientFactory({ connectionString: targetUrl }); await client.connect();
  try {
    const result = await client.query(`SELECT current_database() AS database, current_user AS role,
      (SELECT count(*)::int FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%' AND c.relkind IN ('r','p','v','m','S','f')) AS relations,
      (SELECT count(*)::int FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%') AS routines,
      (SELECT count(*)::int FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg_%' AND nspname <> 'public') AS custom_schemas,
      (SELECT count(*)::int FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype IN ('c','d','e','r','m')) AS custom_types`);
    const row = result.rows[0];
    if (row.role !== 'rotamoto_restore' || Number(row.relations) || Number(row.routines) || Number(row.custom_schemas) || Number(row.custom_types))
      throw Object.assign(new Error('RESTORE_TARGET_NOT_EMPTY'), { code: 'RESTORE_TARGET_NOT_EMPTY' });
    return row.database;
  } finally { await client.end(); }
}
function createBackupExecutor({ store, env = process.env, operations = {} }) {
  const required = ['ROTAMOTO_BACKUP_CONTROL_DIRECTORY', 'ROTAMOTO_BACKUP_KEY_FILE', 'ROTAMOTO_BACKUP_DIRECTORY',
    'ROTAMOTO_MEDIA_DIRECTORY', 'BACKUP_DATABASE_URL'];
  const workerId = `backup-executor:${crypto.randomUUID()}`;
  async function audit(action, details) { await appendOperatorAudit(action, details); }
  async function runJob(job) {
    await store.updateJob(job.id, { type: 'progress', phase: 'checking_configuration', percent: 5 });
    if (required.some(key => !env[key]) || !path.isAbsolute(env.ROTAMOTO_BACKUP_KEY_FILE) || !path.isAbsolute(env.ROTAMOTO_BACKUP_DIRECTORY) || !path.isAbsolute(env.ROTAMOTO_MEDIA_DIRECTORY))
      throw Object.assign(new Error('BACKUP_EXECUTOR_CONFIGURATION_REQUIRED'), { code: 'BACKUP_EXECUTOR_CONFIGURATION_REQUIRED' });
    const state = await store.read(), retentionDays = state.config.retentionDays;
    if (job.kind === 'backup') {
      if (!safeSyntheticSource(env.BACKUP_DATABASE_URL, env)) throw Object.assign(new Error('BACKUP_SOURCE_NOT_AUTHORIZED'), { code: 'BACKUP_SOURCE_NOT_AUTHORIZED' });
      await audit('backup.create.started', { jobId: job.id, retentionDays });
      const created = await (operations.create || createRecoverySet)({ databaseUrl: env.BACKUP_DATABASE_URL, keyFile: env.ROTAMOTO_BACKUP_KEY_FILE,
        backupDirectory: env.ROTAMOTO_BACKUP_DIRECTORY, mediaDirectory: env.ROTAMOTO_MEDIA_DIRECTORY, retentionDays, prune: false });
      await store.updateJob(job.id, { type: 'progress', phase: 'verifying', percent: 70 });
      await (operations.verify || verifyRecoverySet)({ directory: env.ROTAMOTO_BACKUP_DIRECTORY, id: created.id, keyFile: env.ROTAMOTO_BACKUP_KEY_FILE });
      let external = { published: false };
      if (state.config.destination === 'external') {
        if (!env.ROTAMOTO_BACKUP_REMOTE_URL || !env.ROTAMOTO_BACKUP_REMOTE_TOKEN) throw Object.assign(new Error('BACKUP_REMOTE_NOT_CONFIGURED'), { code: 'BACKUP_REMOTE_NOT_CONFIGURED' });
        const remote = (operations.remoteFactory || createHttpBackupRemote)({ baseUrl: env.ROTAMOTO_BACKUP_REMOTE_URL,
          token: env.ROTAMOTO_BACKUP_REMOTE_TOKEN, test: env.NODE_ENV === 'test' });
        external = await remote.publishSet({ directory: env.ROTAMOTO_BACKUP_DIRECTORY, id: created.id });
      }
      await (operations.prune || pruneRecoverySets)({ directory: env.ROTAMOTO_BACKUP_DIRECTORY, retentionDays,
        keyFile: env.ROTAMOTO_BACKUP_KEY_FILE });
      const lastRun = { status: 'success', completedAt: new Date().toISOString(), backupId: created.id,
        sizeBytes: created.database.sizeBytes, schemaState: 'CURRENT', externalPublished: external.published };
      await store.updateJob(job.id, { type: 'result', lastRun });
      await audit('backup.create.completed', { jobId: job.id, backupId: created.id, sizeBytes: created.database.sizeBytes, externalPublished: external.published });
      return lastRun;
    }
    if (job.kind === 'verify') {
      const result = await (operations.verify || verifyRecoverySet)({ directory: env.ROTAMOTO_BACKUP_DIRECTORY,
        id: job.recoverySetId, keyFile: env.ROTAMOTO_BACKUP_KEY_FILE });
      const lastRun = { status: 'verified', completedAt: new Date().toISOString(), backupId: result.id,
        schemaMigrations: result.schemaMigrations?.length || null };
      await store.updateJob(job.id, { type: 'result', lastRun }); return lastRun;
    }
    if (job.kind === 'inventory') {
      const result = await (operations.inventory || inventoryRecoverySets)({ directory: env.ROTAMOTO_BACKUP_DIRECTORY, keyFile: env.ROTAMOTO_BACKUP_KEY_FILE });
      const inventory = { checkedAt: new Date().toISOString(), verified: result.counts?.verified || 0,
        incomplete: result.counts?.incomplete || 0, schemaState: result.items?.some(item => item.coverage?.state === 'DIVERGENT') ? 'DIVERGENT' :
          result.items?.some(item => item.coverage?.state === 'STALE') ? 'STALE' : result.items?.length ? 'CURRENT' : 'UNKNOWN',
        sets: (result.items || []).filter(item => item.id).map(item => ({ id: item.id, state: item.state,
          createdAt: item.createdAt || null, sizeBytes: item.sizeBytes || null, schemaState: item.coverage?.state || 'UNKNOWN',
          migrationCount: item.coverage?.appliedCount ?? null, mediaCount: item.mediaCount ?? null })) };
      await store.updateJob(job.id, { type: 'result', inventory }); return inventory;
    }
    if (job.kind === 'restore_test') {
      const target = env.ROTAMOTO_DISPOSABLE_RESTORE_DATABASE_URL;
      if (!safeDisposableTarget(target, env)) throw Object.assign(new Error('RESTORE_TARGET_NOT_AUTHORIZED'), { code: 'RESTORE_TARGET_NOT_AUTHORIZED' });
      await (operations.preflightRestore || assertEmptyDisposableTarget)(target, operations.restoreClientFactory);
      await audit('backup.restore.started', { jobId: job.id, recoveryId: job.recoverySetId });
      const restoreStartedAt = Date.now();
      const result = await (operations.restore || restoreRecoverySet)({ directory: env.ROTAMOTO_BACKUP_DIRECTORY, id: job.recoverySetId,
        targetUrl: target, keyFile: env.ROTAMOTO_BACKUP_KEY_FILE,
        disposableMediaDirectory: env.ROTAMOTO_DISPOSABLE_MEDIA_DIRECTORY, productionMediaDirectory: env.ROTAMOTO_MEDIA_DIRECTORY });
      const integrity = await (operations.verifyRestored || verifyRestoredDatabase)(target, operations.restoreClientFactory);
      const lastRun = { status: 'restore_verified', completedAt: new Date().toISOString(), backupId: result.id,
        durationMs: Date.now() - restoreStartedAt, database: integrity.database, integrity };
      await store.updateJob(job.id, { type: 'result', lastRun });
      await audit('backup.restore.completed', { jobId: job.id, backupId: result.id }); return lastRun;
    }
    throw Object.assign(new Error('BACKUP_JOB_KIND_INVALID'), { code: 'BACKUP_JOB_KIND_INVALID' });
  }
  async function runOne() {
    const job = await store.claimNext(workerId); if (!job) return false;
    try { await runJob(job); await store.updateJob(job.id, { type: 'terminal', status: 'SUCCEEDED' }); }
    catch (error) {
      const code = /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'BACKUP_OPERATION_FAILED';
      await store.updateJob(job.id, { type: 'result', lastRun: { status: 'failed', completedAt: new Date().toISOString(),
        jobId: job.id, errorCode: code, externalPublished: false } });
      await store.updateJob(job.id, { type: 'errorCode', code });
      await store.updateJob(job.id, { type: 'terminal', status: 'FAILED' });
      try { await audit('backup.job.failed', { jobId: job.id, errorCode: code }); } catch (_) {}
    }
    return true;
  }
  async function tick() { await store.dueSchedule(); return runOne(); }
  return Object.freeze({ async start({ intervalMs = 1000, signal } = {}) {
    if (!Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 60_000) throw new Error('BACKUP_EXECUTOR_INTERVAL_INVALID');
    if (typeof store.acquireExecutorLease !== 'function') throw Object.assign(new Error('BACKUP_EXECUTOR_LEASE_UNAVAILABLE'), { code: 'BACKUP_EXECUTOR_LEASE_UNAVAILABLE' });
    const release = await store.acquireExecutorLease(workerId);
    const policy = backupRuntimePolicy({ env, uid: process.getuid?.(), groups: process.getgroups?.() || [], role: 'executor' });
    try {
      await store.recoverInterrupted();
      await store.updateExecutorHeartbeat(workerId, 'ONLINE', policy.isolation);
      while (!signal?.aborted) {
        await tick();
        await store.updateExecutorHeartbeat(workerId, 'ONLINE', policy.isolation);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    } finally {
      await store.updateExecutorHeartbeat(workerId, 'STOPPED', policy.isolation).catch(() => {});
      await release();
    }
  }, runOne, tick });
}
module.exports = { createBackupExecutor, safeDisposableTarget, safeSyntheticSource, assertEmptyDisposableTarget, verifyRestoredDatabase };
