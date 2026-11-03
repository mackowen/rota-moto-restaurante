'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { completeInvitationConfiguration, verifyKeystore, verifyInvitationDelivery,
  isLocalTermuxOperator, issueBrowserBootstrapAuthorization } = require('../scripts/prepare-browser-bootstrap');
const { loadSecretProvider } = require('../backend/runtime/secret-provider');

const script = path.join(__dirname, '..', 'scripts', 'prepare-browser-bootstrap.js');
const source = fs.readFileSync(script, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
assert.equal(packageJson.scripts['bootstrap:prepare-browser'], 'node scripts/prepare-browser-bootstrap.js --confirm-database=rotamoto',
  'documented command must resolve to the official exact-target CLI');
assert.match(source, /PREPARAR PRIMEIRA INSTALACAO/u, 'operator must explicitly approve issuance');
const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5000,
  env: { ...process.env, DATABASE_URL: '', ROTAMOTO_SECRET_STORE_DIRECTORY: '', ROTAMOTO_SECRET_MASTER_KEY_FILE: '' } });
assert.notEqual(result.status, 0, 'non-interactive automation cannot issue a bootstrap capability');
assert.match(result.stderr, /BOOTSTRAP_TTY_REQUIRED/u);
assert.doesNotMatch(`${result.stdout}${result.stderr}`, /[A-Za-z0-9_-]{43}/u, 'guard failures never emit a capability');
const termux = { TERMUX_VERSION: '0.118.3', PREFIX: '/data/data/com.termux/files/usr' };
assert.equal(isLocalTermuxOperator('android', termux), true, 'supported local Termux environment is recognized');
assert.equal(isLocalTermuxOperator('linux', termux), false, 'a generic Linux TTY cannot issue authorization');
assert.equal(isLocalTermuxOperator('android', { ...termux, SSH_CONNECTION: '192.0.2.1 1234 192.0.2.2 22' }), false,
  'SSH sessions cannot issue local installation authorization');
assert.equal(isLocalTermuxOperator('android', { ...termux, PREFIX: '/tmp/fake-termux' }), false,
  'spoofed/non-Termux prefix cannot issue authorization');

const smtp = { host: 'smtp.example.invalid', user: 'bootstrap', passwordRef: 'secret-ref', from: 'noreply@example.invalid',
  baseUrl: 'https://example.invalid', port: 587 };
assert.equal(completeInvitationConfiguration(smtp), true);
assert.equal(completeInvitationConfiguration({ ...smtp, port: 0 }), false);
let removed = false;
let written = '';
const secretProvider = {
  async put({ name, scope, value }) { assert.match(name, /^bootstrap\/preflight\//u); assert.equal(scope, 'installation'); written = value; return { secretRef: 'probe-ref' }; },
  async get(ref, context) {
    if (ref === 'probe-ref') { assert.equal(context.scope, 'installation'); return written; }
    assert.equal(ref, 'secret-ref'); assert.deepEqual(context, { name: 'smtp/password', scope: 'installation' }); return 'smtp-secret';
  },
  async remove(ref) { assert.equal(ref, 'probe-ref'); removed = true; }
};
// The keystore canary uses the exact reference returned by put, while the SMTP
// preflight reads only the configured reference and never reports its value.
verifyKeystore(secretProvider).then(async () => {
  const queries = [];
  const fakeClient = { async query(sql, params) {
    queries.push({ sql, params: params?.map(value => Buffer.isBuffer(value) ? Buffer.from(value) : value) });
    if (sql.includes('current_database()')) return { rows: [{ database: 'rotamoto', role: 'rotamoto_app', session_role: 'rotamoto_app' }] };
    if (sql.includes('platform_admin_bootstrap_status')) return { rows: [{ state: 'ready' }] };
    if (sql.includes('SELECT 1 FROM rotamoto.bootstrap_authorizations')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO rotamoto.bootstrap_authorizations')) return { rowCount: 1, rows: [] };
    return { rows: [] };
  } };
  const issued = await issueBrowserBootstrapAuthorization(fakeClient, size => Buffer.alloc(size, 7));
  const rawBytes = Buffer.from(issued.capability);
  const raw = rawBytes.toString('base64url');
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(issued.digest.length, 32);
  assert.equal(issued.digest.equals(crypto.createHash('sha256').update(raw, 'utf8').digest()), true,
    'persisted digest matches the exact Base64URL capability received by the API');
  assert.equal(queries.some(query => query.sql.includes("interval '10 minutes'")), true, 'issued authorization expires after ten minutes');
  assert.equal(queries.at(-1).params[0].equals(issued.digest), true, 'raw token is not passed to the database insert');
  assert.equal(queries.some(query => query.params?.includes?.(raw)), false, 'raw token is absent from SQL parameters');
  await assert.rejects(issueBrowserBootstrapAuthorization({ query: async sql => sql.includes('current_database()')
    ? { rows: [{ database: 'rotamoto_e2e', role: 'rotamoto_app', session_role: 'rotamoto_app' }] }
    : { rows: [], rowCount: 0 } }), error => error.code === 'BOOTSTRAP_TARGET_INVALID',
  'issuer refuses the E2E and all other database identities');
  const unavailableClient = { async query(sql) {
    if (sql.includes('current_database()')) return { rows: [{ database: 'rotamoto', role: 'rotamoto_app', session_role: 'rotamoto_app' }] };
    if (sql.includes('platform_admin_bootstrap_status')) return { rows: [{ state: 'unavailable' }] };
    return { rows: [], rowCount: 0 };
  } };
  await assert.rejects(issueBrowserBootstrapAuthorization(unavailableClient), error => error.code === 'BOOTSTRAP_NOT_AVAILABLE',
    'issuer refuses a completed or reserved installation even if a caller invokes the helper');
  rawBytes.fill(0); issued.capability.fill(0); issued.digest.fill(0);
  assert.equal(removed, true, 'preflight removes only its own temporary keystore canary');
  await verifyInvitationDelivery(secretProvider, smtp);
  await assert.rejects(verifyInvitationDelivery({ get: async () => { throw new Error('secret path/value must not leak'); } }, smtp),
    error => error.code === 'BOOTSTRAP_EMAIL_UNAVAILABLE' && !/secret path|value/u.test(error.message));
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rotamoto-external-keystore-test-'));
  try {
    const writablePath = path.join(temporaryDirectory, 'writable-provider.cjs');
    fs.writeFileSync(writablePath, `const values=new Map(); module.exports={
      getDatabasePassword:async()=> 'synthetic-db-password',
      get:async(ref,context)=>{const value=values.get(ref); if(!value || value.name!==context.name || value.scope!==context.scope) throw new Error('not found'); return value.secret;},
      put:async(input)=>{const ref='external-ref-1'; values.set(ref,{...input,secret:input.value}); return {secretRef:ref};},
      remove:async(ref)=>{values.delete(ref);}
    };\n`, { mode: 0o600 });
    const external = loadSecretProvider(writablePath);
    assert.equal(typeof external.put, 'function', 'external secret providers can expose the MFA enrollment write contract');
    assert.equal(typeof external.remove, 'function');
    const saved = await external.put({ name: 'identity/mfa/test', scope: 'installation', value: 'synthetic-mfa-secret' });
    assert.equal(await external.get(saved.secretRef, { name: 'identity/mfa/test', scope: 'installation' }), 'synthetic-mfa-secret');
    await external.remove(saved.secretRef);
    await assert.rejects(external.get(saved.secretRef, { name: 'identity/mfa/test', scope: 'installation' }));
    await assert.rejects(external.put({ name: '../bad', scope: 'installation', value: 'x' }));
    const readonlyPath = path.join(temporaryDirectory, 'readonly-provider.cjs');
    fs.writeFileSync(readonlyPath, `module.exports={getDatabasePassword:async()=> 'synthetic-db-password',get:async()=> 'value'};\n`, { mode: 0o600 });
    const readonly = loadSecretProvider(readonlyPath);
    assert.equal(typeof readonly.put, 'undefined', 'read-only provider is not misreported as MFA-enrollment ready');
    assert.equal(typeof readonly.remove, 'undefined');
  } finally { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); }
  process.stdout.write('browser bootstrap CLI guards and keystore/email preflight: PASS\n');
}).catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
