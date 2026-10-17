'use strict';

const assert = require('node:assert/strict');
const { resolveE2eBootstrapTarget, validateE2eDatabaseIdentity } = require('../backend/identity/e2e-bootstrap-guard');

const base = { NODE_ENV: 'test', ROTAMOTO_E2E_CAMPAIGN: '0243',
  E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_e2e_app@127.0.0.1:5432/rotamoto_e2e' };
assert.deepEqual(resolveE2eBootstrapTarget(base), {
  connectionString: base.E2E_RUNTIME_DATABASE_URL, host: '127.0.0.1', port: 5432,
  database: 'rotamoto_e2e', sessionUser: 'rotamoto_e2e_app', applicationRole: 'rotamoto_app'
});
assert.equal(validateE2eDatabaseIdentity({ database: 'rotamoto_e2e', current_user: 'rotamoto_app',
  session_user: 'rotamoto_e2e_app', server_address: '127.0.0.1' }), true);
for (const override of [
  { NODE_ENV: 'development' }, { ROTAMOTO_E2E_CAMPAIGN: '0242' },
  { E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' },
  { E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_e2e_app@192.0.2.1:5432/rotamoto_e2e' },
  { E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_e2e_app:secret@127.0.0.1:5432/rotamoto_e2e' },
  { DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' },
  { SMTP_HOST: 'smtp.gmail.com' }, { PUBLIC_BASE_URL: 'https://example.test' }
]) assert.throws(() => resolveE2eBootstrapTarget({ ...base, ...override }), { code: 'E2E_BOOTSTRAP_TARGET_INVALID' });
for (const identity of [
  { database: 'rotamoto', current_user: 'rotamoto_app', session_user: 'rotamoto_app', server_address: '127.0.0.1' },
  { database: 'rotamoto_e2e', current_user: 'rotamoto_app', session_user: 'rotamoto_app', server_address: '127.0.0.1' },
  { database: 'rotamoto_e2e', current_user: 'rotamoto_app', session_user: 'rotamoto_e2e_app', server_address: '192.0.2.1' }
]) assert.throws(() => validateE2eDatabaseIdentity(identity), { code: 'E2E_BOOTSTRAP_IDENTITY_MISMATCH' });
process.stdout.write('E2E bootstrap target and connection identity guards: PASS\n');
