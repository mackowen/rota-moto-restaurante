'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('./connection');

const MIGRATION_DIR = path.join(__dirname, 'migrations');
const MIGRATION_TABLE = 'rotamoto.schema_migrations';
const LOCK_KEY_1 = 1380790868;
const LOCK_KEY_2 = 2;
const OFFICIAL_0116_MIGRATION_ID = '0040_restaurant_driver_queue';
const OFFICIAL_0116_CHECKSUM_0039 = 'e581cecf955381968548d5cb65b6f937d105cf5a1beace779d078a3100047494';
const OFFICIAL_0116_CHECKSUM_0040 = '58a6e6b0da458b97fdc2553b8dcf066eb14abeb6efeb93ddc6d24713ea951f85';
const OFFICIAL_0154_MIGRATIONS = Object.freeze([
  '0042_marketplace_99food_runtime','0043_99food_application_and_cash_commands','0044_99food_distributed_rate_limit'
]);
const OFFICIAL_0154_CHECKSUM_0041 = 'c75063f833da16a8efdd2e8d448bf1c7c3aee7e360be8d9e1f12397d15251a9c';
const OFFICIAL_0234_MIGRATIONS = Object.freeze([
  '0045_installation_bootstrap','0046_bootstrap_legacy_installation_latch','0047_administrative_mfa_recovery'
]);
const OFFICIAL_0234_CHECKSUM_0044 = 'ac5f82463dd933657f4c4d921dc4dab2684437fe5e9163bf90c8750e55c28a95';
function checksumMatches(migration, appliedChecksum) {
  return appliedChecksum === migration.checksum;
}

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
  const disposable0234=env.ROTAMOTO_BOOTSTRAP_DISPOSABLE==='0234';
  const expectedPort=disposable0234?String(env.ROTAMOTO_BOOTSTRAP_PGPORT||''): '5432';
  if(disposable0234&&(!/^\d{4,5}$/u.test(expectedPort)||Number(expectedPort)<1024||Number(expectedPort)>65535||Number(expectedPort)===5432))
    throw new Error('Cluster 0234 exige porta descartável explícita fora da porta operacional.');
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      parsed.username !== 'rotamoto_migrator' ||
      parsed.password || parsed.hostname !== '127.0.0.1' || parsed.port !== expectedPort ||
      parsed.pathname !== '/rotamoto_e2e' || parsed.search || parsed.hash) {
    throw new Error(`Migrations E2E exigem rotamoto_migrator sem senha em 127.0.0.1:${expectedPort}/rotamoto_e2e.`);
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

function disposable0116MigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== '0116') {
    throw new Error('Migration de ensaio 0116 exige NODE_ENV=test e ROTAMOTO_DISPOSABLE_CAMPAIGN=0116.');
  }
  const value = env.ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL;
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('URL descartável 0116 inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || decodeURIComponent(parsed.username) !== 'rotamoto_migrator' ||
      parsed.password || parsed.hostname !== '127.0.0.1' || (parsed.port || '5432') !== '5432' ||
      !/^\/rotamoto_disposable_0116_[a-z0-9_]{1,40}$/u.test(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('Migration 0116 aceita somente rotamoto_migrator em database rotamoto_disposable_0116_* via loopback.');
  }
  return value;
}

function official0116MigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'production' || env.ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN !== '0116' ||
      env.ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE !== 'rotamoto' ||
      env.ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATION !== OFFICIAL_0116_MIGRATION_ID) {
    throw new Error('Operação oficial 0116 exige NODE_ENV=production e confirmações explícitas de campanha, banco e migration.');
  }
  const value = migrationConnectionString(env);
  const parsed = new URL(value);
  if (parsed.search || parsed.hash) throw new Error('Operação oficial 0116 não aceita parâmetros adicionais na URL.');
  return value;
}

function assertOfficial0116State(applied, migrations, { allowApplied = false } = {}) {
  const index = migrations.findIndex(migration => migration.id === OFFICIAL_0116_MIGRATION_ID);
  if (index !== 39 || index !== migrations.length - 1 || migrations[index].checksum !== OFFICIAL_0116_CHECKSUM_0040 ||
      migrations[38]?.id !== '0039_driver_operational_availability' ||
      migrations[38]?.checksum !== OFFICIAL_0116_CHECKSUM_0039) {
    throw new Error('Gate oficial 0116 exige 0039/0040 íntegrias e 0040 como única migration final conhecida.');
  }
  const expectedPrior = migrations.slice(0, index);
  const targetApplied = applied.get(OFFICIAL_0116_MIGRATION_ID) === OFFICIAL_0116_CHECKSUM_0040;
  const expectedSize = expectedPrior.length + (targetApplied ? 1 : 0);
  if (applied.size !== expectedSize || targetApplied && !allowApplied ||
      !expectedPrior.every(migration => applied.get(migration.id) === migration.checksum) ||
      [...applied.keys()].some(id => id !== OFFICIAL_0116_MIGRATION_ID && !expectedPrior.some(migration => migration.id === id))) {
    throw new Error('Gate oficial 0116 exige ledger íntegro 0001–0039 e somente 0040 pendente/aplicada.');
  }
  return targetApplied ? 'applied' : 'pending';
}

function assertQueueRehearsalState(applied, migrations, campaign) {
  const id = '0040_restaurant_driver_queue';
  const index = migrations.findIndex(migration => migration.id === id);
  if (index < 0 || index !== migrations.length - 1) {
    throw new Error(`Ensaio ${campaign} exige 0040 como última migration conhecida.`);
  }
  const expected = migrations.slice(0, index);
  if (applied.size !== expected.length && applied.size !== expected.length + (applied.has(id) ? 1 : 0)) {
    throw new Error(`Ensaio ${campaign} exige ledger exato 0001–0039 e somente 0040 pendente/aplicada.`);
  }
  if (!expected.every(migration => applied.get(migration.id) === migration.checksum) ||
      [...applied.keys()].some(migrationId => !expected.some(migration => migration.id === migrationId) && migrationId !== id)) {
    throw new Error(`Ensaio ${campaign} exige ledger íntegro 0001–0039.`);
  }
  return applied.has(id) ? null : id;
}
function assert0115RehearsalState(applied, migrations) { return assertQueueRehearsalState(applied, migrations, '0115'); }
function assert0116RehearsalState(applied, migrations) { return assertQueueRehearsalState(applied, migrations, '0116'); }

function official0154MigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'production' || env.ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN !== '0154' ||
      env.ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE !== 'rotamoto' ||
      env.ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATIONS !== OFFICIAL_0154_MIGRATIONS.join(',')) {
    throw new Error('Operação oficial exige confirmações explícitas da Campanha 0154, banco e migrations.');
  }
  const value = migrationConnectionString(env), parsed = new URL(value);
  if (parsed.search || parsed.hash) throw new Error('Operação oficial não aceita parâmetros adicionais na URL.');
  return value;
}

function assertOfficial0154State(applied, migrations, { allowApplied = false } = {}) {
  const applied0041 = migrations.find(migration => migration.id === '0041_delivery_custody_return');
  const pending = migrations.filter(migration => OFFICIAL_0154_MIGRATIONS.includes(migration.id));
  if (!applied0041 || applied0041.checksum !== OFFICIAL_0154_CHECKSUM_0041 || pending.length !== OFFICIAL_0154_MIGRATIONS.length ||
      pending.some((migration,index) => migration.id !== OFFICIAL_0154_MIGRATIONS[index]) ||
      migrations.at(-1)?.id !== OFFICIAL_0154_MIGRATIONS.at(-1)) {
    throw new Error('Gate oficial 0154 exige histórico imutável 0041 e 0042–0044 como migrations finais conhecidas.');
  }
  if (applied.size !== 41 + OFFICIAL_0154_MIGRATIONS.filter(id => applied.has(id)).length ||
      !migrations.slice(0,41).every(migration => applied.get(migration.id) === migration.checksum) ||
      [...applied.keys()].some(id => !migrations.slice(0,41).some(migration => migration.id === id) && !OFFICIAL_0154_MIGRATIONS.includes(id)) ||
      OFFICIAL_0154_MIGRATIONS.some((id,index) => applied.has(id) && !allowApplied)) {
    throw new Error('Gate oficial 0154 exige ledger íntegro 0001–0041 e somente 0042–0044 pendentes.');
  }
  const appliedNew = OFFICIAL_0154_MIGRATIONS.filter(id => applied.has(id));
  if (appliedNew.some((id,index) => id !== OFFICIAL_0154_MIGRATIONS[index])) {
    throw new Error('Gate oficial 0154 encontrou migrations aplicadas fora de sequência.');
  }
  return Object.freeze({ applied: appliedNew, pending: OFFICIAL_0154_MIGRATIONS.filter(id => !applied.has(id)) });
}

function official0234MigrationConnectionString(env = process.env) {
  if (env.NODE_ENV !== 'production' || env.ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN !== '0234' ||
      env.ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE !== 'rotamoto' ||
      env.ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATIONS !== OFFICIAL_0234_MIGRATIONS.join(',')) {
    throw new Error('Operação oficial exige confirmações explícitas da Campanha 0234, banco e migrations.');
  }
  const value = migrationConnectionString(env), parsed = new URL(value);
  if (parsed.search || parsed.hash) throw new Error('Operação oficial não aceita parâmetros adicionais na URL.');
  return value;
}

function assertOfficial0234State(applied, migrations, { allowApplied = false } = {}) {
  const baseline = migrations.find(migration => migration.id === '0044_99food_distributed_rate_limit');
  const pending = migrations.slice(44, 47);
  const prefix = migrations.slice(0, 44);
  const knownPost0234 = new Set(['0048_platform_administration','0049_platform_administration_hardening','0050_company_role_descriptions','0051_company_role_description_runtime_update']);
  if (!baseline || baseline.checksum !== OFFICIAL_0234_CHECKSUM_0044 || prefix.length !== 44 ||
      prefix.at(-1)?.id !== '0044_99food_distributed_rate_limit' || pending.length !== 3 ||
      pending.some((migration,index) => migration.id !== OFFICIAL_0234_MIGRATIONS[index]) ||
      migrations.length < 47 || migrations[46]?.id !== OFFICIAL_0234_MIGRATIONS.at(-1) ||
      migrations.slice(47).some(migration => !knownPost0234.has(migration.id))) {
    throw new Error('Gate oficial 0234 exige baseline 0001–0044 íntegra e somente 0045–0047 como migrations finais conhecidas.');
  }
  if (applied.size < 44 || applied.size > 47 ||
      !prefix.every(migration => applied.get(migration.id) === migration.checksum) ||
      [...applied.keys()].some(id => !prefix.some(migration => migration.id === id) && !OFFICIAL_0234_MIGRATIONS.includes(id)) ||
      OFFICIAL_0234_MIGRATIONS.some((id,index) => applied.has(id) && !allowApplied) ||
      OFFICIAL_0234_MIGRATIONS.filter(id => applied.has(id)).some((id,index) => id !== OFFICIAL_0234_MIGRATIONS[index])) {
    throw new Error('Gate oficial 0234 exige ledger íntegro 0001–0044 e migrations 0045–0047 pendentes ou sequencialmente aplicadas.');
  }
  const completed = OFFICIAL_0234_MIGRATIONS.filter(id => applied.has(id));
  return Object.freeze({ applied: completed, pending: OFFICIAL_0234_MIGRATIONS.filter(id => !applied.has(id)) });
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
  const e2eThroughMatch = args.length === 2 ? /^--e2e-through=(\d{4}_[a-z0-9_]+)$/u.exec(args[1]) : null;
  const e2eThroughId = e2eThroughMatch?.[1] || null;
  const e2e = args.length === 2 && (args[1] === '--e2e' || Boolean(e2eThroughId));
  const disposableCampaign = args.length === 2 && args[1] === '--campaign-0068-source';
  const rehearsal0110 = args.length === 2 && args[1] === '--rehearsal-0110';
  const rehearsal0115 = args.length === 2 && args[1] === '--rehearsal-0115';
  const rehearsal0116 = args.length === 2 && args[1] === '--rehearsal-0116';
  const verifyOfficial0116 = args.length === 2 && args[1] === '--verify-0116';
  const applyOfficial0116 = args.length === 2 && args[1] === '--apply-0116';
  const verifyOfficial0154 = args.length === 2 && args[1] === '--verify-0154';
  const applyOfficial0154 = args.length === 2 && args[1] === '--apply-0154';
  const verifyOfficial0234 = args.length === 2 && args[1] === '--verify-0234';
  const applyOfficial0234 = args.length === 2 && args[1] === '--apply-0234';
  const throughMatch = args.length === 2 ? /^--through=(\d{4}_[a-z0-9_]+)$/u.exec(args[1]) : null;
  const throughId = throughMatch?.[1] || null;
  if (!['up', 'down', 'status'].includes(command) ||
      (e2eThroughId && !getMigrations().some(migration => migration.id === e2eThroughId)) ||
      (args.length > 1 && !e2e && !disposableCampaign && !rehearsal0110 && !rehearsal0115 && !rehearsal0116 && !verifyOfficial0116 && !applyOfficial0116 && !verifyOfficial0154 && !applyOfficial0154 && !verifyOfficial0234 && !applyOfficial0234 && !throughId) || args.length > 2 ||
      (throughId && (command !== 'up' || !getMigrations().some(migration => migration.id === throughId))) ||
      (throughId && (e2e || disposableCampaign || rehearsal0110 || rehearsal0115 || rehearsal0116 || verifyOfficial0116 || applyOfficial0116 || verifyOfficial0154 || applyOfficial0154 || verifyOfficial0234 || applyOfficial0234)) ||
      ((rehearsal0110 || rehearsal0115 || rehearsal0116) && command === 'down') ||
      (verifyOfficial0116 && command !== 'status') ||
      (applyOfficial0116 && command !== 'up') ||
      (verifyOfficial0154 && command !== 'status') ||
      (applyOfficial0154 && command !== 'up') ||
      (verifyOfficial0234 && command !== 'status') ||
      (applyOfficial0234 && command !== 'up') ||
      ((e2e || disposableCampaign) && command === 'down')) {
    throw new Error('Uso: node backend/postgres/migrate.js [up|down|status] [--e2e|--e2e-through=<migration conhecida>|--campaign-0068-source|--rehearsal-0110|--rehearsal-0115|--rehearsal-0116|--verify-0116|--apply-0116|--verify-0154|--apply-0154|--through=<migration conhecida>]');
  }
  if (env.NODE_ENV === 'test' && !e2e && !disposableCampaign && !rehearsal0110 && !rehearsal0115 && !rehearsal0116 && !verifyOfficial0116 && !applyOfficial0116 && !verifyOfficial0154 && !applyOfficial0154 && !verifyOfficial0234 && !applyOfficial0234 && command !== 'status') {
    throw new Error('Migrations mutáveis em NODE_ENV=test exigem --e2e e rotamoto_e2e.');
  }
  return { command, ...(e2eThroughId ? { throughId: e2eThroughId } : throughId ? { throughId } : {}), connectionString: applyOfficial0116 || verifyOfficial0116 ? official0116MigrationConnectionString(env)
      : applyOfficial0154 || verifyOfficial0154 ? official0154MigrationConnectionString(env)
      : applyOfficial0234 || verifyOfficial0234 ? official0234MigrationConnectionString(env)
    : disposableCampaign ? disposableCampaignMigrationConnectionString(env)
    : rehearsal0110 ? disposable0110MigrationConnectionString(env)
    : rehearsal0115 ? disposable0115MigrationConnectionString(env)
    : rehearsal0116 ? disposable0116MigrationConnectionString(env)
      : e2e || e2eThroughId ? e2eMigrationConnectionString(env) : migrationConnectionString(env),
    ...(rehearsal0110 ? { rehearsal0110: true } : {}), ...(rehearsal0115 ? { rehearsal0115: true } : {}),
    ...(rehearsal0116 ? { rehearsal0116: true } : {}),
    ...(verifyOfficial0116 ? { verifyOfficial0116: true } : {}), ...(applyOfficial0116 ? { applyOfficial0116: true } : {}),
    ...(verifyOfficial0154 ? { verifyOfficial0154: true } : {}), ...(applyOfficial0154 ? { applyOfficial0154: true } : {}),
    ...(verifyOfficial0234 ? { verifyOfficial0234: true } : {}), ...(applyOfficial0234 ? { applyOfficial0234: true } : {}) };
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
    if (checksum && !checksumMatches(migration, checksum)) {
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

async function applyMigration(client, migration) {
  await withTransaction(client, async () => {
    await client.query(migration.up);
    await client.query(
      `INSERT INTO ${MIGRATION_TABLE} (migration_id, checksum_sha256) VALUES ($1, $2)`,
      [migration.id, migration.checksum]
    );
  });
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
  const { command, connectionString, throughId, rehearsal0110, rehearsal0115, rehearsal0116, verifyOfficial0116, applyOfficial0116,
    verifyOfficial0154, applyOfficial0154, verifyOfficial0234, applyOfficial0234 } = resolveMigrationInvocation();
  const disposable0234=process.env.NODE_ENV==='test'&&process.env.ROTAMOTO_BOOTSTRAP_DISPOSABLE==='0234'&&
    new URL(connectionString).port===process.env.ROTAMOTO_BOOTSTRAP_PGPORT&&new URL(connectionString).pathname==='/rotamoto_e2e';
  const client = createClient({ connectionString, connectionTimeoutMillis: 5000,
    ...(disposable0234?{password:async()=>undefined}:{}) });
  let lockHeld = false;
  try {
    await client.connect();
    const identity = await client.query(`SELECT current_database() AS database,current_user AS role,
      inet_server_addr()::text AS server_address,current_setting('server_version_num')::integer AS version_num`);
    if (identity.rows[0]?.role !== 'rotamoto_migrator') {
      throw new Error('A conexão de migration não autenticou como rotamoto_migrator.');
    }
    if ((verifyOfficial0116 || applyOfficial0116) && (identity.rows[0].database !== 'rotamoto' ||
        identity.rows[0].server_address !== '127.0.0.1/32' || identity.rows[0].version_num < 180000 || identity.rows[0].version_num >= 190000)) {
      throw new Error('Gate oficial 0116 exige current_database=rotamoto, loopback e PostgreSQL 18.');
    }
    if ((verifyOfficial0154 || applyOfficial0154) && (identity.rows[0].database !== 'rotamoto' ||
        identity.rows[0].server_address !== '127.0.0.1/32' || identity.rows[0].version_num < 180000 || identity.rows[0].version_num >= 190000)) {
      throw new Error('Gate oficial 0154 exige current_database=rotamoto, loopback e PostgreSQL 18.');
    }
    if ((verifyOfficial0234 || applyOfficial0234) && (identity.rows[0].database !== 'rotamoto' ||
        identity.rows[0].server_address !== '127.0.0.1/32' || identity.rows[0].version_num < 180000 || identity.rows[0].version_num >= 190000)) {
      throw new Error('Gate oficial 0234 exige current_database=rotamoto, loopback e PostgreSQL 18.');
    }
    if (rehearsal0115 || rehearsal0116) {
      const database = decodeURIComponent(new URL(connectionString).pathname.slice(1));
      const target = await client.query(`SELECT current_database() AS name,pg_get_userbyid(d.datdba) AS owner,
        current_setting('server_version_num')::integer AS version_num
        FROM pg_database d WHERE d.datname=current_database()`);
      const role = await client.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      if (!target.rowCount || target.rows[0].name !== database || target.rows[0].owner !== 'rotamoto_restore' ||
          target.rows[0].version_num < 180000 || target.rows[0].version_num >= 190000 ||
          !role.rowCount || role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole || role.rows[0].rolbypassrls) {
        throw new Error(`Identidade do ensaio ${rehearsal0116 ? '0116' : '0115'} inválida: exige PostgreSQL 18, owner rotamoto_restore e migrator sem privilégios elevados.`);
      }
    }
    await client.query('SELECT pg_advisory_lock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]);
    lockHeld = true;
    if (rehearsal0110 || rehearsal0115 || rehearsal0116 || verifyOfficial0116 || applyOfficial0116 || verifyOfficial0234 || applyOfficial0234) {
      const metadata = await client.query("SELECT to_regclass('rotamoto.schema_migrations') IS NOT NULL AS available");
      if (!metadata.rows[0]?.available) throw new Error('Modo restrito exige ledger existente; metadados não são criados.');
    } else await ensureMetadata(client);
    const allMigrations = getMigrations();
    if (rehearsal0110 && command === 'up') {
      const applied = await assertChecksums(client, allMigrations);
      assert0110RehearsalState(applied, allMigrations);
    }
    if (rehearsal0115 || rehearsal0116) {
      const applied = await assertChecksums(client, allMigrations);
      (rehearsal0116 ? assert0116RehearsalState : assert0115RehearsalState)(applied, allMigrations);
    }
    if (verifyOfficial0116 || applyOfficial0116) {
      const applied = await assertChecksums(client, allMigrations);
      const state = assertOfficial0116State(applied, allMigrations, { allowApplied: true });
      if (verifyOfficial0116) {
        await client.query('BEGIN READ ONLY');
        try {
          const pending = await client.query(`SELECT count(*)::integer AS count FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()`);
          const locks = await client.query(`SELECT count(*)::integer AS count FROM pg_locks
            WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`);
          console.log(JSON.stringify({ event: 'migration.official.0116.verified', database: 'rotamoto', state,
            migrationId: OFFICIAL_0116_MIGRATION_ID, checksum: OFFICIAL_0116_CHECKSUM_0040,
            externalSessions: pending.rows[0].count, waitingLocks: locks.rows[0].count }));
        } finally { await client.query('ROLLBACK'); }
        return;
      }
      if (state !== 'pending') {
        console.log(JSON.stringify({ event: 'migration.official.0116.already_applied', database: 'rotamoto',
          migrationId: OFFICIAL_0116_MIGRATION_ID, checksum: OFFICIAL_0116_CHECKSUM_0040 }));
        return;
      }
      const databaseOwner = await client.query(`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()`);
      const schemaPrivileges = await client.query(`SELECT pg_get_userbyid(nspowner) AS owner,
        has_schema_privilege(current_user,'rotamoto','USAGE') AS schema_usage,
        has_schema_privilege(current_user,'rotamoto','CREATE') AS schema_create,
        has_table_privilege(current_user,'rotamoto.schema_migrations','SELECT') AS ledger_select,
        has_table_privilege(current_user,'rotamoto.schema_migrations','INSERT') AS ledger_insert
        FROM pg_namespace WHERE nspname='rotamoto'`);
      const role = await client.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      const activity = await client.query(`SELECT count(*)::integer AS sessions,
        count(*) FILTER(WHERE xact_start IS NOT NULL)::integer AS transactions
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`);
      const waiters = await client.query(`SELECT count(*)::integer AS count FROM pg_locks
        WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`);
      if (!databaseOwner.rowCount || !databaseOwner.rows[0].owner || !schemaPrivileges.rowCount ||
          schemaPrivileges.rows[0].owner !== 'rotamoto_migrator' || !schemaPrivileges.rows[0].schema_usage ||
          !schemaPrivileges.rows[0].schema_create || !schemaPrivileges.rows[0].ledger_select ||
          !schemaPrivileges.rows[0].ledger_insert || !role.rowCount || role.rows[0].rolsuper ||
          role.rows[0].rolcreatedb || role.rows[0].rolcreaterole || role.rows[0].rolbypassrls ||
          Number(activity.rows[0].sessions) !== 0 || Number(activity.rows[0].transactions) !== 0 || Number(waiters.rows[0].count) !== 0) {
        throw new Error('Gate oficial 0116 recusado: role, owner, sessões, transações ou locks não estão no estado esperado.');
      }
      await client.query("SET lock_timeout='5s'");
      await client.query("SET statement_timeout='60s'");
      await applyMigration(client, allMigrations.at(-1));
      const after = await assertChecksums(client, allMigrations);
      assertOfficial0116State(after, allMigrations, { allowApplied: true });
      console.log(JSON.stringify({ event: 'migration.official.0116.applied', database: 'rotamoto',
        migrationId: OFFICIAL_0116_MIGRATION_ID, checksum: OFFICIAL_0116_CHECKSUM_0040,
        databaseOwner: databaseOwner.rows[0].owner, transactional: true }));
      return;
    }
    if (verifyOfficial0154 || applyOfficial0154) {
      const applied = await assertChecksums(client, allMigrations);
      const state = assertOfficial0154State(applied, allMigrations, { allowApplied: verifyOfficial0154 });
      if (verifyOfficial0154) {
        await client.query('BEGIN READ ONLY');
        try {
          const activity = await client.query(`SELECT count(*)::integer AS sessions,
            count(*) FILTER(WHERE xact_start IS NOT NULL)::integer AS transactions
            FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`);
          const waiting = await client.query(`SELECT count(*)::integer AS locks FROM pg_locks
            WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`);
          console.log(JSON.stringify({event:'migration.official.0154.verified',database:'rotamoto',state,
            applied:state.applied,pending:state.pending,checksum0041:OFFICIAL_0154_CHECKSUM_0041,
            externalSessions:activity.rows[0].sessions,externalTransactions:activity.rows[0].transactions,waitingLocks:waiting.rows[0].locks}));
        } finally { await client.query('ROLLBACK'); }
        return;
      }
      if (!state.pending.length) {
        console.log(JSON.stringify({event:'migration.official.0154.already_applied',database:'rotamoto',applied:state.applied}));
        return;
      }
      const schema = await client.query(`SELECT pg_get_userbyid(nspowner) AS owner,
        has_schema_privilege(current_user,'rotamoto','USAGE') AS schema_usage,
        has_schema_privilege(current_user,'rotamoto','CREATE') AS schema_create,
        has_table_privilege(current_user,'rotamoto.schema_migrations','SELECT') AS ledger_select,
        has_table_privilege(current_user,'rotamoto.schema_migrations','INSERT') AS ledger_insert
        FROM pg_namespace n WHERE nspname='rotamoto'`);
      const role = await client.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      const activity = await client.query(`SELECT count(*)::integer AS sessions,
        count(*) FILTER(WHERE xact_start IS NOT NULL)::integer AS transactions
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`);
      const waiting = await client.query(`SELECT count(*)::integer AS locks FROM pg_locks
        WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`);
      if (!schema.rowCount || schema.rows[0].owner!=='rotamoto_migrator' || !schema.rows[0].schema_usage || !schema.rows[0].schema_create ||
          !schema.rows[0].ledger_select || !schema.rows[0].ledger_insert || !role.rowCount || role.rows[0].rolsuper ||
          role.rows[0].rolcreatedb || role.rows[0].rolcreaterole || role.rows[0].rolbypassrls ||
          Number(activity.rows[0].sessions)!==0 || Number(activity.rows[0].transactions)!==0 || Number(waiting.rows[0].locks)!==0) {
        throw new Error('Gate oficial 0154 recusado: role, owner, sessões, transações ou locks não estão no estado esperado.');
      }
      await client.query("SET lock_timeout='5s'");
      await client.query("SET statement_timeout='60s'");
      for (const migrationId of state.pending) {
        const migration=allMigrations.find(item=>item.id===migrationId);
        await applyMigration(client,migration);
      }
      const after=await assertChecksums(client,allMigrations);
      const completed=assertOfficial0154State(after,allMigrations,{allowApplied:true});
      if(completed.pending.length)throw new Error('Gate oficial 0154 não aplicou todas as migrations autorizadas.');
      console.log(JSON.stringify({event:'migration.official.0154.applied',database:'rotamoto',migrations:completed.applied,
        checksums:Object.fromEntries(completed.applied.map(id=>[id,allMigrations.find(item=>item.id===id).checksum])),
        transactional:true,lockTimeoutMs:5000,statementTimeoutMs:60000}));
      return;
    }
    if (verifyOfficial0234 || applyOfficial0234) {
      const allMigrations = getMigrations();
      const applied = await assertChecksums(client, allMigrations);
      const state = assertOfficial0234State(applied, allMigrations, { allowApplied: true });
      const activity = await client.query(`SELECT count(*)::integer AS sessions,
        count(*) FILTER(WHERE xact_start IS NOT NULL)::integer AS transactions
        FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`);
      const waiters = await client.query(`SELECT count(*)::integer AS locks FROM pg_locks
        WHERE database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`);
      if (verifyOfficial0234) {
        console.log(JSON.stringify({event:'migration.official.0234.verified',database:'rotamoto',state:state.pending.length===0?'complete':state.applied.length?'partially_applied':'pending',
          applied:state.applied,pending:state.pending,baselineChecksum0044:OFFICIAL_0234_CHECKSUM_0044,
          externalSessions:activity.rows[0].sessions,externalTransactions:activity.rows[0].transactions,waitingLocks:waiters.rows[0].locks}));
        return;
      }
      if (!state.pending.length) {
        console.log(JSON.stringify({event:'migration.official.0234.already_applied',database:'rotamoto',applied:state.applied}));
        return;
      }
      const schema = await client.query(`SELECT pg_get_userbyid(nspowner) AS owner,
        has_schema_privilege(current_user,'rotamoto','USAGE') AS schema_usage,
        has_schema_privilege(current_user,'rotamoto','CREATE') AS schema_create,
        has_table_privilege(current_user,'rotamoto.schema_migrations','SELECT') AS ledger_select,
        has_table_privilege(current_user,'rotamoto.schema_migrations','INSERT') AS ledger_insert
        FROM pg_namespace WHERE nspname='rotamoto'`);
      const role = await client.query(`SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      const coreCounts = await client.query(`SELECT (SELECT count(*) FROM rotamoto.companies)::bigint AS companies,
        (SELECT count(*) FROM rotamoto.users)::bigint AS users`);
      if (!schema.rowCount || schema.rows[0].owner!=='rotamoto_migrator' || !schema.rows[0].schema_usage ||
          !schema.rows[0].schema_create || !schema.rows[0].ledger_select || !schema.rows[0].ledger_insert ||
          !role.rowCount || role.rows[0].rolsuper || role.rows[0].rolcreatedb || role.rows[0].rolcreaterole || role.rows[0].rolbypassrls ||
          Number(activity.rows[0].sessions)!==0 || Number(activity.rows[0].transactions)!==0 || Number(waiters.rows[0].locks)!==0) {
        throw new Error('Gate oficial 0234 recusado: role, owner, sessões, transações ou locks não estão no estado esperado.');
      }
      await client.query("SET lock_timeout='5s'");
      await client.query("SET statement_timeout='60s'");
      for (const migrationId of state.pending) {
        const migration=allMigrations.find(item=>item.id===migrationId);
        await applyMigration(client,migration);
        console.log(`aplicada ${migrationId}`);
      }
      const after=await assertChecksums(client,allMigrations);
      const completed=assertOfficial0234State(after,allMigrations,{allowApplied:true});
      const afterCounts=await client.query(`SELECT (SELECT count(*) FROM rotamoto.companies)::bigint AS companies,
        (SELECT count(*) FROM rotamoto.users)::bigint AS users`);
      if (completed.pending.length || afterCounts.rows[0].companies!==coreCounts.rows[0].companies ||
          afterCounts.rows[0].users!==coreCounts.rows[0].users) {
        throw new Error('Gate oficial 0234 falhou: migrations incompletas ou contagens de empresas/usuários alteradas.');
      }
      console.log(JSON.stringify({event:'migration.official.0234.applied',database:'rotamoto',migrations:completed.applied,
        checksums:Object.fromEntries(completed.applied.map(id=>[id,allMigrations.find(item=>item.id===id).checksum])),
        coreRowCountsUnchanged:true,transactional:true,lockTimeoutMs:5000,statementTimeoutMs:60000}));
      return;
    }
    const effectiveThroughId=rehearsal0110?'0039_driver_operational_availability':rehearsal0115||rehearsal0116?'0040_restaurant_driver_queue':throughId;
    const throughIndex = effectiveThroughId ? allMigrations.findIndex(migration => migration.id === effectiveThroughId) : -1;
    if (effectiveThroughId && throughIndex < 0) throw new Error('Migration checkpoint desconhecido.');
    const migrations = effectiveThroughId ? allMigrations.slice(0, throughIndex + 1) : allMigrations;
    if (command === 'up') await migrateUp(client, migrations);
    else if (command === 'down') await migrateDown(client, migrations);
    else await status(client, migrations);
    if (rehearsal0115 || rehearsal0116) {
      const target = migrations.find(migration => migration.id === '0040_restaurant_driver_queue');
      const applied = await appliedMigrations(client);
      console.log(JSON.stringify({ event: `migration.rehearsal.${rehearsal0116 ? '0116' : '0115'}.completed`, database: decodeURIComponent(new URL(connectionString).pathname.slice(1)),
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
module.exports = { getMigrations, assertChecksums, checksumMatches, withTransaction, migrationConnectionString,
  e2eMigrationConnectionString, disposableCampaignMigrationConnectionString, disposable0110MigrationConnectionString,
  disposable0115MigrationConnectionString, disposable0116MigrationConnectionString, official0116MigrationConnectionString, assertOfficial0116State,
  official0154MigrationConnectionString, assertOfficial0154State, official0234MigrationConnectionString, assertOfficial0234State,
  assert0110RehearsalState, assert0115RehearsalState, assert0116RehearsalState, resolveMigrationInvocation };
