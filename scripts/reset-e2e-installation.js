'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createClient } = require('../backend/postgres/connection');
const { getMigrations } = require('../backend/postgres/migrate');

const LOCK = 'rotamoto:e2e:campaign:0240:reset:v1';
const PRESERVED = new Set(['rotamoto.schema_migrations', 'rotamoto.permissions', 'rotamoto.installation_bootstrap']);
const CAMPAIGN_SCHEMA = /^campaign\d{4}_[a-f0-9]{32}$/u;

function isResetSchema(schema) { return schema === 'rotamoto' || CAMPAIGN_SCHEMA.test(schema); }

function target(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== '0240') throw new Error('Reset exige NODE_ENV=test e ROTAMOTO_DISPOSABLE_CAMPAIGN=0240.');
  let url;
  try { url = new URL(env.E2E_MIGRATOR_DATABASE_URL); } catch (_) { throw new Error('E2E_MIGRATOR_DATABASE_URL inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'rotamoto_migrator' || url.password ||
      url.hostname !== '127.0.0.1' || (url.port || '5432') !== '5432' || url.pathname !== '/rotamoto_e2e' || url.search || url.hash)
    throw new Error('Reset aceita somente rotamoto_migrator em 127.0.0.1:5432/rotamoto_e2e.');
  return env.E2E_MIGRATOR_DATABASE_URL;
}

function ident(value) { return `"${String(value).replaceAll('"', '""')}"`; }

function serviceState() {
  const result = spawnSync('sv', ['status', 'rotamoto-api-e2e'], { encoding: 'utf8', timeout: 5000 });
  if (result.error || !/^(?:run|down):/u.test(result.stdout || '')) throw new Error('Não foi possível confirmar o estado do serviço E2E; reset cancelado.');
  return result.stdout.startsWith('run:');
}

function setService(action) {
  const result = spawnSync('sv', [action, 'rotamoto-api-e2e'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(`Falha ao ${action === 'down' ? 'parar' : 'iniciar'} a API E2E.`);
}

async function auditEvent(event, details) {
  const root = path.join(process.env.HOME, 'rotamoto-data', 'development', '0240');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  const file = path.join(root, 'e2e-reset-audit.jsonl');
  const handle = await fs.open(file, 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), event, campaign: '0240', ...details })}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.chmod(file, 0o600);
}

async function resetE2E({ clientFactory = createClient } = {}) {
  const connectionString = target();
  const client = clientFactory({ connectionString });
  const wasRunning = serviceState();
  if (wasRunning) setService('down');
  if (serviceState()) { if (wasRunning) setService('up'); throw new Error('API E2E continua ativa; reset cancelado.'); }
  let locked = false;
  try {
    await client.connect();
    const identity = await client.query(`SELECT current_database() AS database,current_user AS role,
      inet_server_addr()::text AS address, current_setting('server_version_num')::int AS version`);
    const actual = identity.rows[0];
    if (actual.database !== 'rotamoto_e2e' || actual.role !== 'rotamoto_migrator' || actual.address !== '127.0.0.1' || actual.version < 180000 || actual.version >= 190000)
      throw new Error('Alvo PostgreSQL diverge do E2E local PostgreSQL 18; reset cancelado.');
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [LOCK]); locked = true;
    const sessions = await client.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND pid<>pg_backend_pid()`);
    if (sessions.rows[0].count !== 0) throw new Error('Há conexões concorrentes no E2E; interrompa os serviços/clients e repita.');

    const ledger = await client.query('SELECT migration_id,checksum_sha256 FROM rotamoto.schema_migrations ORDER BY migration_id');
    const expected = getMigrations().map(({ id, checksum }) => `${id}:${checksum}`);
    const applied = ledger.rows.map(row => `${row.migration_id}:${String(row.checksum_sha256).trim()}`);
    if (expected.length !== 47 || JSON.stringify(expected) !== JSON.stringify(applied)) throw new Error('Ledger E2E diverge das 47 migrations locais; reset cancelado.');

    const rels = await client.query(`SELECT n.nspname,c.relname,c.relkind,c.relowner=to_regrole('rotamoto_migrator') AS migrator_owner,
      has_table_privilege(current_user,c.oid,'TRUNCATE') AS can_truncate
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p') AND n.nspname !~ '^(pg_|information_schema$)' ORDER BY n.nspname,c.relname`);
    if (rels.rows.some(row => !isResetSchema(row.nspname))) throw new Error('Há tabelas fora do schema operacional E2E e schemas campaignNNNN_hash; reset cancelado.');
    const resetTables = rels.rows.filter(row => isResetSchema(row.nspname) && !PRESERVED.has(`${row.nspname}.${row.relname}`));
    if (!resetTables.length || resetTables.some(row => !row.migrator_owner && !row.can_truncate)) throw new Error('Há tabela fora do escopo de propriedade/grant do migrator; reset cancelado.');
    const structureBefore = await client.query(`SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
      coalesce(array_to_string(c.relacl,','),'') AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2`);
    const policiesBefore = await client.query(`SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      FROM pg_policies ORDER BY 1,2,3`);
    const triggersBefore = await client.query(`SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2,3`);
    const functionsBefore = await client.query(`SELECT n.nspname,p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,
      coalesce(array_to_string(p.proacl,','),'') AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prokind IN ('f','p') AND n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2`);
    const constraintsBefore = await client.query(`SELECT n.nspname,c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid,true) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2,3`);
    const indexesBefore = await client.query(`SELECT n.nspname,c.relname,i.relname AS index_name,pg_get_indexdef(i.oid) AS definition
      FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2,3`);
    await auditEvent('reset.started', { tableCount: resetTables.length, schemaCount: new Set(rels.rows.map(row => row.nspname)).size });

    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='120s'");
      const tableList = resetTables.map(row => `${ident(row.nspname)}.${ident(row.relname)}`).join(',');
      await client.query(`TRUNCATE TABLE ${tableList} RESTRICT`);
      const latch = await client.query(`UPDATE rotamoto.installation_bootstrap SET completed_at=NULL,request_digest=NULL
        WHERE singleton=true RETURNING singleton`);
      if (latch.rowCount !== 1) throw new Error('Latch singleton ausente ou duplicado; rollback aplicado.');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }

    const structureAfter = await client.query(`SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,
      coalesce(array_to_string(c.relacl,','),'') AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2`);
    const policiesAfter = await client.query(`SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies ORDER BY 1,2,3`);
    const triggersAfter = await client.query(`SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS def
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2,3`);
    const functionsAfter = await client.query(`SELECT n.nspname,p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,
      coalesce(array_to_string(p.proacl,','),'') AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE p.prokind IN ('f','p') AND n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2`);
    const constraintsAfter = await client.query(`SELECT n.nspname,c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid,true) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2,3`);
    const indexesAfter = await client.query(`SELECT n.nspname,c.relname,i.relname AS index_name,pg_get_indexdef(i.oid) AS definition
      FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^(pg_|information_schema$)' ORDER BY 1,2,3`);
    if (JSON.stringify(structureBefore.rows) !== JSON.stringify(structureAfter.rows) ||
        JSON.stringify(policiesBefore.rows) !== JSON.stringify(policiesAfter.rows) ||
        JSON.stringify(triggersBefore.rows) !== JSON.stringify(triggersAfter.rows) ||
        JSON.stringify(functionsBefore.rows) !== JSON.stringify(functionsAfter.rows) ||
        JSON.stringify(constraintsBefore.rows) !== JSON.stringify(constraintsAfter.rows) ||
        JSON.stringify(indexesBefore.rows) !== JSON.stringify(indexesAfter.rows)) throw new Error('A estrutura, ACL, RLS/policies, funções, constraints, índices ou triggers mudou inesperadamente após o reset.');
    const latchState = await client.query('SELECT completed_at IS NULL AND request_digest IS NULL AS available FROM rotamoto.installation_bootstrap WHERE singleton=true');
    if (latchState.rows[0]?.available !== true) throw new Error('Latch não está disponível após reset.');
    await auditEvent('reset.completed', { tableCount: resetTables.length, migrationCount: applied.length, latchAvailable: true });
    return { database: actual.database, migrationCount: applied.length, resetTableCount: resetTables.length, latchAvailable: true };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [LOCK]).catch(() => {});
    await client.end().catch(() => {});
    if (wasRunning) setService('up');
  }
}

if (require.main === module) resetE2E().then(result => process.stdout.write(`${JSON.stringify({ event: 'e2e.reset.completed', ...result })}\n`))
  .catch(error => { process.stderr.write(`${JSON.stringify({ event: 'e2e.reset.failed', code: /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'RESET_FAILED', message: error.message })}\n`); process.exitCode = 1; });

module.exports = { resetE2E, target, PRESERVED, isResetSchema };
