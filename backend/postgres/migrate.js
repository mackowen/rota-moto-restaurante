'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const MIGRATION_DIR = path.join(__dirname, 'migrations');
const MIGRATION_TABLE = 'rotamoto.schema_migrations';
const LOCK_KEY_1 = 1380790868;
const LOCK_KEY_2 = 2;

function getMigrations() {
  return fs.readdirSync(MIGRATION_DIR)
    .filter(name => /^\d{4}_[a-z0-9_]+\.up\.sql$/.test(name))
    .sort()
    .map(upFile => {
      const id = upFile.slice(0, -'.up.sql'.length);
      const up = fs.readFileSync(path.join(MIGRATION_DIR, upFile), 'utf8');
      const downPath = path.join(MIGRATION_DIR, `${id}.down.sql`);
      return { id, up, down: fs.existsSync(downPath) ? fs.readFileSync(downPath, 'utf8') : null,
        checksum: crypto.createHash('sha256').update(up).digest('hex') };
    });
}

function migrationConnectionString(env = process.env) {
  const value = env.MIGRATOR_DATABASE_URL;
  if (!value) throw new Error('MIGRATOR_DATABASE_URL não configurada.');
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('MIGRATOR_DATABASE_URL deve usar PostgreSQL.');
  }
  if (decodeURIComponent(parsed.username) !== 'rotamoto_migrator') {
    throw new Error('MIGRATOR_DATABASE_URL deve autenticar como rotamoto_migrator.');
  }
  if (parsed.password || parsed.hostname !== '127.0.0.1' || (parsed.port || '5432') !== '5432' || parsed.pathname !== '/rotamoto') {
    throw new Error('MIGRATOR_DATABASE_URL deve apontar sem senha para rotamoto_migrator em 127.0.0.1:5432/rotamoto.');
  }
  return value;
}

// This target is deliberately separate from the operational migration URL.
// Resolve and validate it before constructing a PostgreSQL client.
function e2eMigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'test') throw new Error('Migrations E2E exigem NODE_ENV=test.');
  const value = env.E2E_MIGRATOR_DATABASE_URL;
  if (!value) throw new Error('E2E_MIGRATOR_DATABASE_URL não configurada.');
  let parsed;
  try { parsed = new URL(value); }
  catch (_) { throw new Error('E2E_MIGRATOR_DATABASE_URL inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      parsed.username !== 'rotamoto_migrator' ||
      parsed.password || parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' ||
      parsed.pathname !== '/rotamoto_e2e' || parsed.search || parsed.hash) {
    throw new Error('Migrations E2E exigem rotamoto_migrator sem senha em 127.0.0.1:5432/rotamoto_e2e.');
  }
  return value;
}

function resolveMigrationInvocation(args = process.argv.slice(2), env = process.env) {
  const command = args[0] || 'up';
  const e2e = args.length === 2 && args[1] === '--e2e';
  if (!['up', 'down', 'status'].includes(command) ||
      (args.length > 1 && !e2e) || args.length > 2 ||
      (e2e && command === 'down')) {
    throw new Error('Uso: node backend/postgres/migrate.js [up|down|status] [--e2e (up/status somente)]');
  }
  return { command, connectionString: e2e
    ? e2eMigrationConnectionString(env)
    : migrationConnectionString(env) };
}

async function ensureMetadata(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS rotamoto');
  await client.query(`CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
    migration_id text PRIMARY KEY,
    checksum_sha256 char(64) NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function appliedMigrations(client) {
  const result = await client.query(
    `SELECT migration_id, checksum_sha256 FROM ${MIGRATION_TABLE} ORDER BY migration_id`
  );
  return new Map(result.rows.map(row => [row.migration_id, row.checksum_sha256.trim()]));
}

async function assertChecksums(client, migrations) {
  const applied = await appliedMigrations(client);
  const knownMigrations = new Set(migrations.map(migration => migration.id));
  for (const id of applied.keys()) {
    if (!knownMigrations.has(id)) {
      throw new Error(`Migration aplicada ${id} não existe mais no diretório; histórico não pode ser inferido com segurança.`);
    }
  }
  for (const migration of migrations) {
    const checksum = applied.get(migration.id);
    if (checksum && checksum !== migration.checksum) {
      throw new Error(`Checksum divergente na migration ${migration.id}; arquivo aplicado foi alterado.`);
    }
  }
  return applied;
}

async function withTransaction(client, operation) {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function migrateUp(client, migrations) {
  const applied = await assertChecksums(client, migrations);
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    await withTransaction(client, async () => {
      await client.query(migration.up);
      await client.query(
        `INSERT INTO ${MIGRATION_TABLE} (migration_id, checksum_sha256) VALUES ($1, $2)`,
        [migration.id, migration.checksum]
      );
    });
    console.log(`aplicada ${migration.id}`);
  }
  if (migrations.every(migration => applied.has(migration.id))) console.log('schema atualizado');
}

async function migrateDown(client, migrations) {
  const applied = await assertChecksums(client, migrations);
  const migration = [...migrations].reverse().find(item => applied.has(item.id));
  if (!migration) {
    console.log('nenhuma migration aplicada');
    return;
  }
  if (!migration.down) throw new Error(`Migration ${migration.id} não tem arquivo down.`);
  await withTransaction(client, async () => {
    await client.query(migration.down);
    await client.query(`DELETE FROM ${MIGRATION_TABLE} WHERE migration_id = $1`, [migration.id]);
  });
  console.log(`revertida ${migration.id}`);
}

async function status(client, migrations) {
  const applied = await assertChecksums(client, migrations);
  for (const migration of migrations) {
    console.log(`${applied.has(migration.id) ? 'aplicada' : 'pendente'} ${migration.id}`);
  }
}

async function main() {
  const { command, connectionString } = resolveMigrationInvocation();
  const client = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  let lockHeld = false;
  try {
    await client.connect();
    const identity = await client.query('SELECT current_user AS role');
    if (identity.rows[0]?.role !== 'rotamoto_migrator') {
      throw new Error('A conexão de migration não autenticou como rotamoto_migrator.');
    }
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
    lockHeld = true;
    await ensureMetadata(client);
    const migrations = getMigrations();
    if (command === 'up') await migrateUp(client, migrations);
    else if (command === 'down') await migrateDown(client, migrations);
    else await status(client, migrations);
  } catch (error) {
    if (error.code) console.error(`falha PostgreSQL (${error.code})`);
    else console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (lockHeld) {
      try { await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]); }
      catch (_) { /* connection close releases a session advisory lock */ }
    }
    await client.end().catch(() => {});
  }
}

if (require.main === module) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { getMigrations, assertChecksums, withTransaction, migrationConnectionString,
  e2eMigrationConnectionString, resolveMigrationInvocation };
