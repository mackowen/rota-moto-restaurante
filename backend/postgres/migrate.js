'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('./connection');

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

function disposableCampaignMigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== '0068') {
    throw new Error('Migrations da campanha descartável exigem NODE_ENV=test e ROTAMOTO_DISPOSABLE_CAMPAIGN=0068.');
  }
  const value = env.ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL;
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('URL da campanha descartável inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== 'rotamoto_migrator' ||
      parsed.password || parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' ||
      parsed.pathname !== '/rotamoto_disposable_0068_source' || parsed.search || parsed.hash) {
    throw new Error('Migration da campanha aceita somente rotamoto_disposable_0068_source em loopback.');
  }
  return value;
}

function disposable0110MigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== '0110') {
    throw new Error('Migration de ensaio 0110 exige NODE_ENV=test e ROTAMOTO_DISPOSABLE_CAMPAIGN=0110.');
  }
  const value = env.ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL;
  let parsed;
  try { parsed = new URL(value); }
  catch (_) { throw new Error('URL descartável 0110 inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== 'rotamoto_migrator' ||
      parsed.password || parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' ||
      !/^\/rotamoto_disposable_0110_[a-z0-9_]{1,40}$/u.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('Migration 0110 aceita somente rotamoto_migrator em um database rotamoto_disposable_0110_* de loopback.');
  }
  return value;
}

function disposable0115MigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== '0115') {
    throw new Error('Migration de ensaio 0115 exige NODE_ENV=test e ROTAMOTO_DISPOSABLE_CAMPAIGN=0115.');
  }
  const value = env.ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL;
  let parsed;
  try { parsed = new URL(value); }
  catch (_) { throw new Error('URL descartável 0115 inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || decodeURIComponent(parsed.username) !== 'rotamoto_migrator' ||
      parsed.password || parsed.hostname !== '127.0.0.1' || (parsed.port || '5432') !== '5432' ||
      !/^\/rotamoto_disposable_0115_[a-z0-9_]{1,40}$/u.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('Migration 0115 aceita somente rotamoto_migrator em database rotamoto_disposable_0115_* via loopback.');
  }
  return value;
}

function assert0115RehearsalState(applied, migrations) {
  const id = '0040_restaurant_driver_queue';
  const index = migrations.findIndex(migration => migration.id === id);
  if (index < 0 || index !== migrations.length - 1) {
    throw new Error('Ensaio 0115 exige 0040 como última migration conhecida.');
  }
  const expected = migrations.slice(0, index);
  if (applied.size !== expected.length && applied.size !== expected.length + (applied.has(id) ? 1 : 0)) {
    throw new Error('Ensaio 0115 exige ledger exato 0001–0039 e somente 0040 pendente/aplicada.');
  }
  if (!expected.every(migration => applied.get(migration.id) === migration.checksum) ||
      [...applied.keys()].some(migrationId => !expected.some(migration => migration.id === migrationId) && migrationId !== id)) {
    throw new Error('Ensaio 0115 exige ledger íntegro 0001–0039.');
  }
  return applied.has(id) ? null : id;
}

function assert0110RehearsalState(applied, migrations) {
  const id = '0039_driver_operational_availability';
  const index = migrations.findIndex(migration => migration.id === id);
  const scoped=index<0?[]:migrations.slice(0,index+1);
  if (index < 0 || !migrations.slice(0, index).every(migration => applied.has(migration.id))) {
    throw new Error('Ensaio 0110 exige somente 0039 pendente após o ledger 0038 íntegro.');
  }
  const pending = scoped.filter(migration => !applied.has(migration.id));
  if (pending.length > 1 || pending.some(migration => migration.id !== id)) {
    throw new Error('Ensaio 0110 exige somente 0039 pendente após o ledger 0038 íntegro.');
  }
  return pending.length ? id : null;
}

function resolveMigrationInvocation(args = process.argv.slice(2), env = process.env) {
  const command = args[0] || 'up';
  const e2e = args.length === 2 && args[1] === '--e2e';
  const disposableCampaign = args.length === 2 && args[1] === '--campaign-0068-source';
  const rehearsal0110 = args.length === 2 && args[1] === '--rehearsal-0110';
  const rehearsal0115 = args.length === 2 && args[1] === '--rehearsal-0115';
  const throughMatch = args.length === 2 ? /^--through=(\d{4}_[a-z0-9_]+)$/u.exec(args[1]) : null;
  const throughId = throughMatch?.[1] || null;
  if (!['up', 'down', 'status'].includes(command) ||
      (args.length > 1 && !e2e && !disposableCampaign && !rehearsal0110 && !rehearsal0115 && !throughId) || args.length > 2 ||
      (throughId && (command !== 'up' || !getMigrations().some(migration => migration.id === throughId))) ||
      (throughId && (e2e || disposableCampaign || rehearsal0110 || rehearsal0115)) ||
      ((rehearsal0110 || rehearsal0115) && command === 'down') ||
      ((e2e || disposableCampaign) && command === 'down')) {
    throw new Error('Uso: node backend/postgres/migrate.js [up|down|status] [--e2e|--campaign-0068-source|--rehearsal-0110|--rehearsal-0115|--through=<migration conhecida>]');
  }
  if (env.NODE_ENV === 'test' && !e2e && !disposableCampaign && !rehearsal0110 && !rehearsal0115 && command !== 'status') {
    throw new Error('Migrations mutáveis em NODE_ENV=test exigem --e2e e rotamoto_e2e.');
  }
  return { command, ...(throughId ? { throughId } : {}), connectionString: disposableCampaign ? disposableCampaignMigrationConnectionString(env)
    : rehearsal0110 ? disposable0110MigrationConnectionString(env)
    : rehearsal0115 ? disposable0115MigrationConnectionString(env)
    : e2e ? e2eMigrationConnectionString(env) : migrationConnectionString(env),
    ...(rehearsal0110 ? { rehearsal0110: true } : {}), ...(rehearsal0115 ? { rehearsal0115: true } : {}) };
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
  const { command, connectionString, throughId, rehearsal0110, rehearsal0115 } = resolveMigrationInvocation();
  const client = createClient({ connectionString, connectionTimeoutMillis: 5000 });
  let lockHeld = false;
  try {
    await client.connect();
    const identity = await client.query('SELECT current_user AS role');
    if (identity.rows[0]?.role !== 'rotamoto_migrator') {
      throw new Error('A conexão de migration não autenticou como rotamoto_migrator.');
    }
    if (rehearsal0115) {
      const database = decodeURIComponent(new URL(connectionString).pathname.slice(1));
      const target = await client.query(`SELECT current_database() AS name,pg_get_userbyid(d.datdba) AS owner,
        current_setting('server_version_num')::integer AS version_num
        FROM pg_database d WHERE d.datname=current_database()`);
      const role = await client.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      if (!target.rowCount || target.rows[0].name !== database || target.rows[0].owner !== 'rotamoto_restore' ||
          target.rows[0].version_num < 180000 || target.rows[0].version_num >= 190000 ||
          !role.rowCount || role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole || role.rows[0].rolbypassrls) {
        throw new Error('Identidade do ensaio 0115 inválida: exige PostgreSQL 18, owner rotamoto_restore e migrator sem privilégios elevados.');
      }
    }
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
    lockHeld = true;
    if (rehearsal0110 || rehearsal0115) {
      const metadata = await client.query("SELECT to_regclass('rotamoto.schema_migrations') IS NOT NULL AS available");
      if (!metadata.rows[0]?.available) throw new Error(`Ensaio ${rehearsal0115 ? '0115' : '0110'} exige ledger restaurado; metadados não são criados neste modo.`);
    } else await ensureMetadata(client);
    const allMigrations = getMigrations();
    if (rehearsal0110 && command === 'up') {
      const applied = await assertChecksums(client, allMigrations);
      assert0110RehearsalState(applied, allMigrations);
    }
    if (rehearsal0115) {
      const applied = await assertChecksums(client, allMigrations);
      assert0115RehearsalState(applied, allMigrations);
    }
    const effectiveThroughId=rehearsal0110?'0039_driver_operational_availability':rehearsal0115?'0040_restaurant_driver_queue':throughId;
    const throughIndex = effectiveThroughId ? allMigrations.findIndex(migration => migration.id === effectiveThroughId) : -1;
    if (effectiveThroughId && throughIndex < 0) throw new Error('Migration checkpoint desconhecido.');
    const migrations = effectiveThroughId ? allMigrations.slice(0, throughIndex + 1) : allMigrations;
    if (command === 'up') await migrateUp(client, migrations);
    else if (command === 'down') await migrateDown(client, migrations);
    else await status(client, migrations);
    if (rehearsal0115) {
      const target = migrations.find(migration => migration.id === '0040_restaurant_driver_queue');
      const applied = await appliedMigrations(client);
      console.log(JSON.stringify({ event: 'migration.rehearsal.0115.completed', database: decodeURIComponent(new URL(connectionString).pathname.slice(1)),
        command, migrationId: target.id, checksum: target.checksum, applied: applied.has(target.id) }));
    }
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
  e2eMigrationConnectionString, disposableCampaignMigrationConnectionString, disposable0110MigrationConnectionString,
  disposable0115MigrationConnectionString, assert0110RehearsalState, assert0115RehearsalState, resolveMigrationInvocation };
