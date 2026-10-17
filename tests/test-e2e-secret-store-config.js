'use strict';

const assert = require('node:assert/strict');
const { resolveE2eSecretStore } = require('../backend/runtime/e2e-secret-store-config');

const base = {
  NODE_ENV: 'test', ROTAMOTO_E2E_CAMPAIGN: '0243', ROTAMOTO_E2E_RUNTIME_ROLE: 'rotamoto_e2e_app',
  E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_e2e_app@127.0.0.1:5432/rotamoto_e2e',
  ROTAMOTO_E2E_SECRET_STORE_DIRECTORY: '/private/e2e/keystore',
  ROTAMOTO_E2E_SECRET_MASTER_KEY_FILE: '/private/e2e/keys/master.key'
};

assert.deepEqual(resolveE2eSecretStore(base), {
  directory: '/private/e2e/keystore', masterKeyFile: '/private/e2e/keys/master.key'
});
assert.equal(resolveE2eSecretStore({}), null);
for (const override of [
  { NODE_ENV: 'development' }, { ROTAMOTO_E2E_CAMPAIGN: '0242' }, { ROTAMOTO_E2E_RUNTIME_ROLE: 'rotamoto_app' },
  { E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' },
  { E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_e2e_app@192.0.2.8:5432/rotamoto_e2e' },
  { E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_e2e_app:secret@127.0.0.1:5432/rotamoto_e2e' },
  { DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' },
  { ROTAMOTO_SECRET_STORE_DIRECTORY: '/private/official/keystore' },
  { ROTAMOTO_E2E_SECRET_MASTER_KEY_FILE: undefined },
  { ROTAMOTO_E2E_SECRET_STORE_DIRECTORY: 'relative/keystore' },
  { ROTAMOTO_E2E_SECRET_STORE_DIRECTORY: `${process.cwd()}/.secret-store` }
]) {
  assert.throws(() => resolveE2eSecretStore({ ...base, ...override }), { code: 'E2E_SECRET_STORE_CONFIGURATION_INVALID' });
}
process.stdout.write('E2E secret-store campaign and target guards: PASS\n');
