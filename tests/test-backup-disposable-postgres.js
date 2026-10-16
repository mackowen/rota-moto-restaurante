'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { getMigrations } = require('../backend/postgres/migrate');
const { createRecoverySet, verifyRecoverySet, restoreRecoverySet } = require('../backend/runtime/recovery-set');
const { assertEmptyDisposableTarget, verifyRestoredDatabase } = require('../backend/runtime/backup-executor');
const { createS3BackupProvider } = require('../backend/runtime/backup-storage-providers');

const CAMPAIGN = '0228';
const NAME_PREFIX = 'rotamoto_disposable_0228_';
function requireSafeTestMode(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== CAMPAIGN)
    throw new Error('Disposable PostgreSQL backup test requires NODE_ENV=test and campaign 0228.');
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { if (stderr.length < 4000) stderr += chunk.slice(0, 4000 - stderr.length); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code ?? 'signal'}): ${stderr.slice(0, 300)}`)));
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function connectionUrl(role, database, port) {
  if (!/^rotamoto_(?:backup|restore|migrator|app|provider_worker|provider_resolver)$/u.test(role) ||
      !database.startsWith(NAME_PREFIX) || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Disposable PostgreSQL test target is outside campaign 0228 guards.');
  return `postgresql://${role}@127.0.0.1:${port}/${database}`;
}
async function query(url, sql, params = []) {
  const client = new Client({ connectionString: url }); await client.connect();
  try { return await client.query(sql, params); } finally { await client.end(); }
}
async function migrateDisposableDatabase(adminUrl, database) {
  if (!database.startsWith(NAME_PREFIX)) throw new Error('Migration target is not campaign 0228 disposable.');
  const client = new Client({ connectionString: adminUrl }); await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS rotamoto');
    await client.query(`CREATE TABLE rotamoto.schema_migrations (
      migration_id text PRIMARY KEY, checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const migration of getMigrations()) {
      await client.query('BEGIN');
      try {
        await client.query(migration.up);
        await client.query('INSERT INTO rotamoto.schema_migrations (migration_id,checksum_sha256) VALUES ($1,$2)',
          [migration.id, migration.checksum]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw new Error(`Disposable migration ${migration.id} failed: ${error.message}`); }
    }
  } finally { await client.end(); }
}

async function startLocalS3Fixture() {
  const objects = new Map(), requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'), key = url.pathname;
    requests.push({ method: req.method, path: url.pathname, signed: /^AWS4-HMAC-SHA256 Credential=SYNTHETIC1\//u.test(req.headers.authorization || '') });
    const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
      if (!/^AWS4-HMAC-SHA256 Credential=SYNTHETIC1\//u.test(req.headers.authorization || '')) { res.writeHead(403).end(); return; }
      const bytes = Buffer.concat(chunks);
      if (req.method === 'PUT') { objects.set(key, { bytes, hash: req.headers['x-amz-meta-sha256'] }); res.writeHead(200).end(); return; }
      if (req.method === 'HEAD') { const item = objects.get(key); if (!item) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-length': String(item.bytes.length), 'x-amz-meta-sha256': item.hash }).end(); return; }
      if (req.method === 'GET' && url.searchParams.has('list-type')) {
        const prefix = url.searchParams.get('prefix') || '', contents = [...objects.entries()].filter(([objectKey]) => objectKey.startsWith(`/rotamoto-e2e-backups/${prefix}`)).sort(([a],[b]) => a.localeCompare(b));
        const escape = value => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
        res.writeHead(200, { 'content-type': 'application/xml' }).end(`<ListBucketResult><IsTruncated>false</IsTruncated>${contents.map(([objectKey, item]) => `<Contents><Key>${escape(objectKey.slice('/rotamoto-e2e-backups/'.length))}</Key><Size>${item.bytes.length}</Size></Contents>`).join('')}</ListBucketResult>`); return;
      }
      if (req.method === 'GET') { const item = objects.get(key); if (!item) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-length': String(item.bytes.length) }).end(item.bytes); return; }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return; }
      res.writeHead(405).end();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, objects, requests, endpoint: `http://127.0.0.1:${server.address().port}/` };
}

async function main() {
  requireSafeTestMode();
  const runId = crypto.randomUUID(), databaseSuffix = runId.replace(/-/gu, '').slice(0, 20);
  const sourceName = `${NAME_PREFIX}${databaseSuffix}_source`, targetName = `${NAME_PREFIX}${databaseSuffix}_restore`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `rotamoto-backup-0228-${runId}-`));
  const dataDirectory = path.join(root, 'pgdata');
  const port = await freePort(), adminUrl = `postgresql://backup_test_admin@127.0.0.1:${port}/postgres`;
  const started = { value: false };
  let phase = 'initialization';
  let mediaParent = null;
  const evidencePath = process.env.ROTAMOTO_BACKUP_TEST_EVIDENCE || null;
  const report = { runId, environment: 'ephemeral PostgreSQL cluster', sourceDatabase: sourceName, restoreDatabase: targetName,
    clusterBoundTo: '127.0.0.1', migrations: null, recoverySet: null, restore: null, integrity: null };
  try {
    await run('initdb', ['-D', dataDirectory, '-U', 'backup_test_admin', '--auth-local=trust', '--auth-host=trust', '--no-instructions']);
    phase = 'cluster-start';
    await run('pg_ctl', ['-D', dataDirectory, '-l', path.join(root, 'postgres.log'), '-o',
      `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=40`, '-w', 'start']);
    started.value = true;
    const bootstrap = await new Client({ connectionString: adminUrl }); await bootstrap.connect();
    try {
      await bootstrap.query('CREATE ROLE rotamoto_migrator NOLOGIN');
      await bootstrap.query('CREATE ROLE rotamoto_app NOLOGIN');
      await bootstrap.query('CREATE ROLE rotamoto_provider_worker NOLOGIN');
      await bootstrap.query('CREATE ROLE rotamoto_provider_resolver NOLOGIN');
      await bootstrap.query('CREATE ROLE rotamoto_backup LOGIN BYPASSRLS');
      await bootstrap.query('CREATE ROLE rotamoto_restore LOGIN');
      await bootstrap.query(`CREATE DATABASE ${sourceName} OWNER rotamoto_migrator`);
      await bootstrap.query(`CREATE DATABASE ${targetName} OWNER rotamoto_restore`);
    } finally { await bootstrap.end(); }
    const sourceAdminUrl = `postgresql://backup_test_admin@127.0.0.1:${port}/${sourceName}`;
    phase = 'schema-migrations';
    await migrateDisposableDatabase(sourceAdminUrl, sourceName);
    const migrations = getMigrations();
    report.migrations = { count: migrations.length, latest: migrations.at(-1).id,
      allChecksumsMatchCode: true };
    await query(sourceAdminUrl, `CREATE TABLE rotamoto.campaign_0228_restore_probe (
      id integer PRIMARY KEY, value text NOT NULL CHECK (value <> ''))`);
    await query(sourceAdminUrl, 'ALTER TABLE rotamoto.campaign_0228_restore_probe ENABLE ROW LEVEL SECURITY');
    await query(sourceAdminUrl, 'ALTER TABLE rotamoto.campaign_0228_restore_probe FORCE ROW LEVEL SECURITY');
    await query(sourceAdminUrl, 'CREATE POLICY campaign_0228_probe_read ON rotamoto.campaign_0228_restore_probe USING (true)');
    await query(sourceAdminUrl, "INSERT INTO rotamoto.campaign_0228_restore_probe (id,value) VALUES (1,'synthetic-0228')");
    await query(sourceAdminUrl, `GRANT CONNECT ON DATABASE ${sourceName} TO rotamoto_backup`);
    await query(sourceAdminUrl, 'GRANT USAGE ON SCHEMA rotamoto TO rotamoto_backup');
    await query(sourceAdminUrl, 'GRANT SELECT ON ALL TABLES IN SCHEMA rotamoto TO rotamoto_backup');
    await query(sourceAdminUrl, 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA rotamoto TO rotamoto_backup');
    await query(sourceAdminUrl, 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rotamoto TO rotamoto_backup');
    await query(sourceAdminUrl, `GRANT CONNECT ON DATABASE ${targetName} TO rotamoto_restore`);

    const keyFile = path.join(root, 'backup.key'), backupDirectory = path.join(root, 'recovery-sets'), mediaDirectory = path.join(root, 'media');
    await fs.mkdir(backupDirectory, { mode: 0o700 }); await fs.mkdir(mediaDirectory, { mode: 0o700 });
    await fs.writeFile(keyFile, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
    const sourceUrl = connectionUrl('rotamoto_backup', sourceName, port);
    const targetUrl = connectionUrl('rotamoto_restore', targetName, port);
    phase = 'synthetic-backup';
    const set = await createRecoverySet({ databaseUrl: sourceUrl, keyFile, backupDirectory, mediaDirectory, prune: false });
    const verified = await verifyRecoverySet({ directory: backupDirectory, id: set.id, keyFile });
    phase = 's3-protocol-publish-download';
    const s3Fixture = await startLocalS3Fixture();
    let s3Provider, restored;
    try {
      s3Provider = createS3BackupProvider({ endpoint: s3Fixture.endpoint, bucket: 'rotamoto-e2e-backups', region: 'us-east-1',
        accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-e2e-s3-key-material', test: true });
      await s3Provider.publishSet({ directory: backupDirectory, id: set.id, prefix: 'campaign-0233-a' });
      assert((await s3Provider.listRecoverySets('campaign-0233-a')).some(item => item.id === set.id));
      const remoteDownloadRoot = path.join(root, 'remote-download'); await fs.mkdir(remoteDownloadRoot, { mode: 0o700 });
      const remoteDownload = await s3Provider.downloadSet({ directory: remoteDownloadRoot, id: set.id, prefix: 'campaign-0233-a' });
      const remoteVerified = await verifyRecoverySet({ directory: remoteDownloadRoot, id: set.id, keyFile });
      assert.equal(remoteVerified.id, set.id, 'remote manifest and encrypted artifacts authenticate after HTTP transfer');
      report.remoteTransfer = { provider: 'S3-compatible HTTP loopback fixture', requests: s3Fixture.requests.length,
        allRequestsSigned: s3Fixture.requests.every(item => item.signed), uploadedObjects: s3Fixture.objects.size,
        downloadFileCount: remoteDownload.fileCount, authenticatedRecoverySet: true };
      await s3Provider.deleteSet({ id: set.id, prefix: 'campaign-0233-a', retainIds: [set.id] }).then(() => { throw new Error('minimum retained set was deleted'); }, error => assert.equal(error.code, 'BACKUP_REMOTE_RETENTION_BLOCKED'));
      const restoredDirectory = remoteDownloadRoot;
      report.recoverySet = { id: set.id, encryptedArtifactVerified: true, ledgerEntries: remoteVerified.schemaMigrations.length,
        mediaObjectCount: remoteVerified.media.objectCount };
      await assertEmptyDisposableTarget(targetUrl);
      const mediaParentName = `rotamoto-disposable-media-parent-${runId}`;
      mediaParent = path.join(os.tmpdir(), mediaParentName);
      await fs.mkdir(mediaParent, { mode: 0o700 });
      const mediaTarget = path.join(mediaParent, `rotamoto-disposable-media-${runId}`);
      const productionMedia = path.join(root, 'not-production-media'); await fs.mkdir(productionMedia, { mode: 0o700 });
      phase = 'synthetic-restore-from-s3';
      restored = await restoreRecoverySet({ directory: restoredDirectory, id: set.id, targetUrl, keyFile,
        disposableMediaDirectory: mediaTarget, productionMediaDirectory: productionMedia });
      report.restore = { completed: true, database: restored.database, mediaObjects: restored.objectCount, source: 'verified remote download' };
    } finally { await new Promise(resolve => s3Fixture.server.close(resolve)); }
    const integrity = await verifyRestoredDatabase(targetUrl);
    const probe = await query(targetUrl, 'SELECT id,value FROM rotamoto.campaign_0228_restore_probe ORDER BY id');
    assert.deepEqual(probe.rows, [{ id: 1, value: 'synthetic-0228' }]);
    assert.equal(verified.schemaMigrations.length, migrations.length);
    assert.equal(integrity.latestMigration, migrations.at(-1).id);
    assert.equal(integrity.invalidIndexes, 0, 'restored database has no invalid indexes');
    assert.equal(integrity.unvalidatedConstraints, 0, 'restored database has no unvalidated constraints');
    assert(integrity.rlsTables > 0, 'restored schema retains forced tenant RLS tables');
    assert(restored.restored); assert.equal(restored.objectCount, 0);
    report.restore.probeRows = probe.rowCount;
    report.integrity = { ...integrity, rlsWithoutForce: 0 };
    if (evidencePath) await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ result: 'PASS', runId, latestMigration: integrity.latestMigration,
      schemaMigrations: integrity.migrationCount, rlsTables: integrity.rlsTables, policies: integrity.policies,
      restoredSyntheticRows: probe.rowCount, constraints: integrity.unvalidatedConstraints, indexes: integrity.invalidIndexes })}\n`);
  } catch (error) {
    report.errorCode = /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'DISPOSABLE_BACKUP_TEST_FAILED';
    report.failedPhase = phase;
    try {
      const log = await fs.readFile(path.join(root, 'postgres.log'), 'utf8');
      report.serverDiagnostic = log.split(/\r?\n/u).filter(line => /FATAL|ERROR|could not|permission denied|address already in use|invalid value/iu.test(line))
        .map(line => line.replace(/\s+/gu, ' ').slice(0, 180)).slice(-5);
    } catch (_) { report.serverDiagnostic = []; }
    if (evidencePath) await fs.writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' }).catch(() => {});
    throw error;
  } finally {
    if (started.value) await run('pg_ctl', ['-D', dataDirectory, '-m', 'fast', '-w', 'stop']).catch(() => {});
    if (mediaParent) await fs.rmdir(mediaParent).catch(error => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`${error.code || 'DISPOSABLE_BACKUP_TEST_FAILED'}: ${String(error.message).replace(/[\r\n\t]/gu, ' ').slice(0, 300)}\n`); process.exitCode = 1; });
