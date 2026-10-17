'use strict';

const fs = require('node:fs/promises');
const fsc = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createClient } = require('../backend/postgres/connection');
const { getMigrations } = require('../backend/postgres/migrate');

const CAMPAIGN = '0241';
const LOCK = 'rotamoto:e2e:campaign:0241:reset:v1';
const RESET_CONFIRMATION = 'ROTAMOTO_E2E_RESET_0241_CONFIRMED';
const PRESERVED = new Set(['rotamoto.schema_migrations', 'rotamoto.permissions', 'rotamoto.installation_bootstrap']);
const CAMPAIGN_SCHEMA = /^campaign\d{4}_[a-f0-9]{32}$/u;

function isResetSchema(schema) { return schema === 'rotamoto' || CAMPAIGN_SCHEMA.test(schema); }

function target(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== CAMPAIGN || env.ROTAMOTO_E2E_RESET_CONFIRM !== RESET_CONFIRMATION)
    throw new Error(`Reset exige NODE_ENV=test, campanha ${CAMPAIGN} e ROTAMOTO_E2E_RESET_CONFIRM=${RESET_CONFIRMATION}.`);
  let url;
  try { url = new URL(env.E2E_MIGRATOR_DATABASE_URL); } catch (_) { throw new Error('E2E_MIGRATOR_DATABASE_URL inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== 'rotamoto_migrator' || url.password ||
      url.hostname !== '127.0.0.1' || (url.port || '5432') !== '5432' || url.pathname !== '/rotamoto_e2e' || url.search || url.hash)
    throw new Error('Reset aceita somente rotamoto_migrator em 127.0.0.1:5432/rotamoto_e2e.');
  return env.E2E_MIGRATOR_DATABASE_URL;
}

function ident(value) { return `"${String(value).replaceAll('"', '""')}"`; }

async function structuralSnapshot(client) {
  const queries = [
    `SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,coalesce(array_to_string(c.relacl,','),'') AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','v','m','f','S') AND n.nspname='rotamoto' ORDER BY 1,2`,
    `SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='rotamoto' ORDER BY 1,2,3`,
    `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) AS def FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='rotamoto' ORDER BY 1,2,3`,
    `SELECT n.nspname,p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,coalesce(array_to_string(p.proacl,','),'') AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN ('f','p') AND n.nspname='rotamoto' ORDER BY 1,2`,
    `SELECT n.nspname,c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid,true) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' ORDER BY 1,2,3`,
    `SELECT n.nspname,c.relname,i.relname AS index_name,pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' ORDER BY 1,2,3`,
    `SELECT nspname,nspowner,coalesce(array_to_string(nspacl,','),'') AS acl FROM pg_namespace WHERE nspname='rotamoto'`,
  ];
  const rows = [];
  for (const sql of queries) rows.push((await client.query(sql)).rows);
  return JSON.stringify(rows);
}

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
  const root = path.join(process.env.HOME, 'rotamoto-data', 'development', CAMPAIGN);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.uid !== process.getuid() || (rootStat.mode & 0o077))
    throw new Error('Diretório de auditoria E2E inseguro.');
  await fs.chmod(root, 0o700);
  const file = path.join(root, 'e2e-reset-audit.jsonl');
  const handle = await fs.open(file, fsc.constants.O_CREAT | fsc.constants.O_APPEND |
    fsc.constants.O_WRONLY | (fsc.constants.O_NOFOLLOW || 0), 0o600);
  const fileStat = await handle.stat();
  if (!fileStat.isFile() || fileStat.nlink !== 1 || fileStat.uid !== process.getuid() || (fileStat.mode & 0o077)) {
    await handle.close(); throw new Error('Arquivo de auditoria E2E inseguro.');
  }
  try { await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), event, campaign: CAMPAIGN, ...details })}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.chmod(file, 0o600);
}

async function assertNoPreviousReset() {
  const file = path.join(process.env.HOME, 'rotamoto-data', 'development', CAMPAIGN, 'e2e-reset-audit.jsonl');
  let handle;
  try { handle = await fs.open(file, fsc.constants.O_RDONLY | (fsc.constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1024 * 1024) {
    await handle.close(); throw new Error('Trilha de reset E2E insegura; interrompido para revisão.');
  }
  let contents;
  try { contents = await handle.readFile('utf8'); } finally { await handle.close(); }
  const events = contents.split(/\r?\n/u).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch (_) { throw new Error('Trilha de reset E2E inválida; interrompido para revisão.'); }
  });
  const campaignEvents = events.filter(event => event.campaign === CAMPAIGN);
  if (campaignEvents.some(event => event.event === 'reset.completed')) throw new Error('Reset 0241 já concluído; segunda execução proibida.');
  const last = campaignEvents.at(-1);
  if (last?.event === 'reset.started' || last && !['reset.failed', 'fixture_schema.dropped'].includes(last.event) ||
      last?.event === 'reset.failed' && last.rollbackConfirmed !== true)
    throw new Error('Tentativa anterior sem rollback confirmado; revisão da trilha obrigatória.');
}

async function resetE2E({ clientFactory = createClient } = {}) {
  const connectionString = target();
  await assertNoPreviousReset();
  const client = clientFactory({ connectionString });
  const wasRunning = serviceState();
  if (wasRunning) setService('down');
  if (serviceState()) { if (wasRunning) setService('up'); throw new Error('API E2E continua ativa; reset cancelado.'); }
  let locked = false;
  try {
    await client.connect();
    const identity = await client.query(`SELECT current_database() AS database,current_user AS role,
      host(inet_server_addr()) AS address, current_setting('server_version_num')::int AS version`);
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
    const campaignSchemas = [...new Set(rels.rows.map(row => row.nspname).filter(name => CAMPAIGN_SCHEMA.test(name)))];
    const schemaOwners = await client.query(`SELECT n.nspname,pg_get_userbyid(n.nspowner) AS owner,
      bool_and(c.relowner=to_regrole('rotamoto_migrator')) AS objects_owned
      FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','f','S')
      WHERE n.nspname=ANY($1::text[]) GROUP BY n.nspname,n.nspowner`, [campaignSchemas]);
    if (schemaOwners.rows.length !== campaignSchemas.length || schemaOwners.rows.some(row => row.owner !== 'rotamoto_migrator' || row.objects_owned === false))
      throw new Error('Schema fixture fora da propriedade exclusiva do migrator; reset cancelado.');
    const resetTables = rels.rows.filter(row => row.nspname === 'rotamoto' && !PRESERVED.has(`${row.nspname}.${row.relname}`));
    if (!resetTables.length || resetTables.some(row => !row.migrator_owner && !row.can_truncate)) throw new Error('Há tabela fora do escopo de propriedade/grant do migrator; reset cancelado.');
    const droppedSchemas = campaignSchemas;
    const structureBefore = await structuralSnapshot(client);
    await auditEvent('reset.started', { tableCount: resetTables.length, fixtureSchemaCount: droppedSchemas.length, fixtureTableCount: rels.rows.filter(row => CAMPAIGN_SCHEMA.test(row.nspname)).length });
    let rollbackConfirmed = false;

    for (const schema of droppedSchemas) {
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='120s'");
        await client.query(`DROP SCHEMA ${ident(schema)} CASCADE`);
        if (await structuralSnapshot(client) !== structureBefore) throw new Error('Schema fixture alterou a estrutura operacional; rollback aplicado.');
        await client.query('COMMIT');
        await auditEvent('fixture_schema.dropped', { fixtureSchemaCount: 1 });
      } catch (error) {
        try { await client.query('ROLLBACK'); rollbackConfirmed = true; } catch (_) { rollbackConfirmed = false; }
        await auditEvent('reset.failed', { rollbackConfirmed, code: /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'RESET_FAILED' }).catch(() => {});
        throw error;
      }
    }

    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='120s'");
      const tableList = resetTables.map(row => `${ident(row.nspname)}.${ident(row.relname)}`).join(',');
      await client.query(`TRUNCATE TABLE ${tableList} RESTRICT`);
      const latch = await client.query(`UPDATE rotamoto.installation_bootstrap SET completed_at=NULL,request_digest=NULL
        WHERE singleton=true RETURNING singleton`);
      if (latch.rowCount !== 1) throw new Error('Latch singleton ausente ou duplicado; rollback aplicado.');
      if (await structuralSnapshot(client) !== structureBefore) throw new Error('Estrutura/ACL/RLS do schema operacional mudou; rollback aplicado.');
      const remainingCampaignSchemas = await client.query(`SELECT nspname FROM pg_namespace WHERE nspname ~ '^campaign[0-9]{4}_[a-f0-9]{32}$'`);
      if (remainingCampaignSchemas.rowCount !== 0) throw new Error('Schema de fixture permaneceu após reset; rollback aplicado.');
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); rollbackConfirmed = true; } catch (_) { rollbackConfirmed = false; }
      await auditEvent('reset.failed', { rollbackConfirmed, code: /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'RESET_FAILED' }).catch(() => {});
      throw error;
    }

    const latchState = await client.query('SELECT completed_at IS NULL AND request_digest IS NULL AS available FROM rotamoto.installation_bootstrap WHERE singleton=true');
    if (latchState.rows[0]?.available !== true) throw new Error('Latch não está disponível após reset.');
    await auditEvent('reset.completed', { tableCount: resetTables.length, fixtureSchemaCount: droppedSchemas.length, migrationCount: applied.length, latchAvailable: true });
    return { database: actual.database, migrationCount: applied.length, resetTableCount: resetTables.length, droppedFixtureSchemaCount: droppedSchemas.length, latchAvailable: true };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [LOCK]).catch(() => {});
    await client.end().catch(() => {});
    if (wasRunning) setService('up');
  }
}

if (require.main === module) resetE2E().then(result => process.stdout.write(`${JSON.stringify({ event: 'e2e.reset.completed', ...result })}\n`))
  .catch(error => { process.stderr.write(`${JSON.stringify({ event: 'e2e.reset.failed', code: /^[A-Z0-9_]{2,64}$/u.test(error.code || '') ? error.code : 'RESET_FAILED', message: error.message })}\n`); process.exitCode = 1; });

module.exports = { resetE2E, target, PRESERVED, isResetSchema, RESET_CONFIRMATION };
