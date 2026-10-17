'use strict';

// One-time local Termux setup for the existing E2E-only restore role.
// The generated password is stored only in the user's private .pgpass file.
const fs = require('node:fs/promises');
const fsc = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createClient } = require('../backend/postgres/connection');

async function main() {
  if (process.env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== '0240' || process.env.NODE_ENV !== 'test') throw new Error('Provisionamento exige campanha E2E 0240.');
  const file = path.join(os.homedir(), '.pgpass');
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Permissões do pgpass inseguras.');
  const prior = await fs.readFile(file, 'utf8');
  const linePrefix = '127.0.0.1:5432:rotamoto_e2e:rotamoto_restore:';
  if (prior.split(/\r?\n/u).some(line => line.startsWith(linePrefix))) throw new Error('Credencial E2E do papel restore já existe; nenhuma rotação aplicada.');
  const secret = crypto.randomBytes(32).toString('base64url');
  const temp = path.join(path.dirname(file), `.pgpass-0240-${crypto.randomUUID()}.tmp`);
  const next = `${prior}${prior && !prior.endsWith('\n') ? '\n' : ''}${linePrefix}${secret}\n`;
  const handle = await fs.open(temp, fsc.constants.O_CREAT | fsc.constants.O_EXCL | fsc.constants.O_WRONLY, 0o600);
  try { await handle.writeFile(next); await handle.sync(); } finally { await handle.close(); }
  const client = createClient({ connectionString: 'postgresql://u0_a436@127.0.0.1:5432/rotamoto_e2e' });
  let connected = false;
  let published = false;
  try {
    await client.connect(); connected = true;
    const role = await client.query(`SELECT r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,
      has_database_privilege(r.oid,'rotamoto','CONNECT') AS official_connect
      FROM pg_roles r WHERE r.rolname='rotamoto_restore'`);
    const state = role.rows[0];
    if (!state || !state.rolcanlogin || state.rolsuper || state.rolcreatedb || state.rolcreaterole || !state.rolbypassrls || state.official_connect)
      throw new Error('A role restore não satisfaz o perfil E2E de backup; nenhuma credencial alterada.');
    await fs.rename(temp, file);
    published = true;
    await fs.chmod(file, 0o600);
    const dir = await fs.open(path.dirname(file), fsc.constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
    await client.query(`ALTER ROLE rotamoto_restore PASSWORD '${secret}'`);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    if (published) {
      const rollback = path.join(path.dirname(file), `.pgpass-0240-rollback-${crypto.randomUUID()}.tmp`);
      await fs.writeFile(rollback, prior, { mode: 0o600, flag: 'wx' }).catch(() => {});
      await fs.rename(rollback, file).catch(() => {});
    }
    throw error;
  } finally { await client.end().catch(() => {}); }
  process.stdout.write('E2E restore role credential provisioned in private pgpass; value withheld.\n');
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { main };
