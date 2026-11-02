'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { completeInvitationConfiguration, verifyKeystore, verifyInvitationDelivery } = require('../scripts/prepare-browser-bootstrap');
const { loadSecretProvider } = require('../backend/runtime/secret-provider');

const script = path.join(__dirname, '..', 'scripts', 'prepare-browser-bootstrap.js');
const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5000,
  env: { ...process.env, DATABASE_URL: '', ROTAMOTO_SECRET_STORE_DIRECTORY: '', ROTAMOTO_SECRET_MASTER_KEY_FILE: '' } });
assert.notEqual(result.status, 0, 'non-interactive automation cannot issue a bootstrap capability');
assert.match(result.stderr, /BOOTSTRAP_TTY_REQUIRED/u);
assert.doesNotMatch(`${result.stdout}${result.stderr}`, /[A-Za-z0-9_-]{43}/u, 'guard failures never emit a capability');

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
