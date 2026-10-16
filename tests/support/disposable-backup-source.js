'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { getMigrations } = require('../../backend/postgres/migrate');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { if (stderr.length < 1200) stderr += chunk.slice(0, 1200 - stderr.length); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code ?? 'signal'}): ${stderr.slice(0, 200)}`)));
  });
}
async function freeLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function createDisposableBackupSource({ outputDirectory } = {}) {
  const campaign = process.env.ROTAMOTO_DISPOSABLE_CAMPAIGN;
  if (process.env.NODE_ENV !== 'test' || !['0229', '0230'].includes(campaign) ||
      typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory)) throw new Error('DISPOSABLE_BACKUP_SOURCE_GUARD');
  const probeTable = `campaign_${campaign}_backup_probe`;
  const probePolicy = `campaign_${campaign}_probe_read`;
  const id = crypto.randomUUID(), suffix = id.replace(/-/gu, '').slice(0, 20), database = `rotamoto_disposable_${campaign}_${suffix}_source`;
  const targetDatabase = `rotamoto_disposable_${campaign}_${suffix}_restore`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `rotamoto-${campaign}-backup-pg-`));
  const data = path.join(root, 'data'), port = await freeLoopbackPort(); let started = false;
  const adminUrl = `postgresql://backup_test_admin@127.0.0.1:${port}/postgres`;
  try {
    await run('initdb', ['-D', data, '-U', 'backup_test_admin', '--auth-local=trust', '--auth-host=trust', '--no-instructions']);
    await run('pg_ctl', ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=40`, '-w', 'start']);
    started = true;
    const admin = new Client({ connectionString: adminUrl }); await admin.connect();
    try {
      await admin.query('CREATE ROLE rotamoto_migrator NOLOGIN');
      await admin.query('CREATE ROLE rotamoto_app NOLOGIN');
      await admin.query('CREATE ROLE rotamoto_provider_worker NOLOGIN');
      await admin.query('CREATE ROLE rotamoto_provider_resolver NOLOGIN');
      await admin.query('CREATE ROLE rotamoto_backup LOGIN BYPASSRLS');
      await admin.query('CREATE ROLE rotamoto_restore LOGIN');
      await admin.query(`CREATE DATABASE ${database} OWNER rotamoto_migrator`);
      await admin.query(`CREATE DATABASE ${targetDatabase} OWNER rotamoto_restore`);
    } finally { await admin.end(); }
    const sourceUrl = `postgresql://backup_test_admin@127.0.0.1:${port}/${database}`;
    const source = new Client({ connectionString: sourceUrl }); await source.connect();
    try {
      await source.query('CREATE SCHEMA IF NOT EXISTS rotamoto');
      await source.query(`CREATE TABLE rotamoto.schema_migrations (migration_id text PRIMARY KEY, checksum_sha256 char(64) NOT NULL CHECK(checksum_sha256 ~ '^[a-f0-9]{64}$'), applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const migration of getMigrations()) {
        await source.query('BEGIN');
        try { await source.query(migration.up); await source.query('INSERT INTO rotamoto.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)', [migration.id, migration.checksum]); await source.query('COMMIT'); }
        catch (error) { await source.query('ROLLBACK'); throw new Error(`SYNTHETIC_MIGRATION_FAILED_${migration.id}`); }
      }
      await source.query(`CREATE TABLE rotamoto.${probeTable}(id integer PRIMARY KEY,value text NOT NULL CHECK(value <> ''))`);
      await source.query(`ALTER TABLE rotamoto.${probeTable} ENABLE ROW LEVEL SECURITY`);
      await source.query(`ALTER TABLE rotamoto.${probeTable} FORCE ROW LEVEL SECURITY`);
      await source.query(`CREATE POLICY ${probePolicy} ON rotamoto.${probeTable} USING(true)`);
      await source.query(`INSERT INTO rotamoto.${probeTable} VALUES(1,$1)`, [`synthetic-${campaign}`]);
      await source.query(`GRANT CONNECT ON DATABASE ${database} TO rotamoto_backup`);
      await source.query('GRANT USAGE ON SCHEMA rotamoto TO rotamoto_backup');
      await source.query('GRANT SELECT ON ALL TABLES IN SCHEMA rotamoto TO rotamoto_backup');
      await source.query('GRANT SELECT ON ALL SEQUENCES IN SCHEMA rotamoto TO rotamoto_backup');
      await source.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA rotamoto TO rotamoto_backup');
    } finally { await source.end(); }
    const targetUrl = `postgresql://backup_test_admin@127.0.0.1:${port}/${targetDatabase}`;
    const targetBootstrap = new Client({ connectionString: targetUrl }); await targetBootstrap.connect();
    try { await targetBootstrap.query(`GRANT CONNECT ON DATABASE ${targetDatabase} TO rotamoto_restore`); }
    finally { await targetBootstrap.end(); }
    await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const keyFile = path.join(outputDirectory, 'synthetic-backup.key');
    await fs.writeFile(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    await fs.chmod(keyFile, 0o600);
    const mediaParent = path.join(os.tmpdir(), `rotamoto-disposable-media-parent-${id}`);
    const disposableMediaDirectory = path.join(mediaParent, `rotamoto-disposable-media-${id}`);
    await fs.mkdir(mediaParent, { mode: 0o700 });
    return Object.freeze({ id, database, targetDatabase, port, databaseUrl: `postgresql://rotamoto_backup@127.0.0.1:${port}/${database}`,
      targetUrl: `postgresql://rotamoto_restore@127.0.0.1:${port}/${targetDatabase}`, targetAdminUrl: `postgresql://backup_test_admin@127.0.0.1:${port}/${targetDatabase}`,
      keyFile, disposableMediaDirectory, root, async verifyRestoredProbe() {
        const target = new Client({ connectionString: `postgresql://backup_test_admin@127.0.0.1:${port}/${targetDatabase}` }); await target.connect();
        try {
          const probe = await target.query(`SELECT id,value FROM rotamoto.${probeTable} ORDER BY id`);
          const ledger = await target.query('SELECT count(*)::int AS count FROM rotamoto.schema_migrations');
          return { probeRows: probe.rowCount, probeValue: probe.rows[0]?.value || null, migrationCount: ledger.rows[0]?.count || 0 };
        } finally { await target.end(); }
      }, stop: async () => {
        if (started) { await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); started = false; }
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(keyFile, { force: true });
        await fs.rm(mediaParent, { recursive: true, force: true });
      } });
  } catch (error) {
    if (started) await run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
module.exports = { createDisposableBackupSource };
