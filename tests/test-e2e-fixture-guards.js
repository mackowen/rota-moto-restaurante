'use strict';

const assert = require('node:assert/strict');
const { validateConnectionUrl, resolveE2eTargets, createE2eClients } = require('./e2e-support/guards');

const valid = Object.freeze({ NODE_ENV: 'test',
  E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',
  E2E_MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e' });
assert.doesNotThrow(() => resolveE2eTargets(valid));
const disposable0234={...valid,ROTAMOTO_BOOTSTRAP_DISPOSABLE:'0234',ROTAMOTO_BOOTSTRAP_PGPORT:'55473',
  E2E_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:55473/rotamoto_e2e',
  E2E_MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:55473/rotamoto_e2e'};
assert.equal(resolveE2eTargets(disposable0234).disposable0234,true,'campaign 0234 accepts only the explicitly guarded isolated test port');
assert.throws(()=>resolveE2eTargets({...disposable0234,ROTAMOTO_BOOTSTRAP_PGPORT:'5432'}),/porta loopback exclusiva/u);
const lote1bDatabase='rotamoto_e2e_lote1b_20261030_a1b2c3d4';
const lote1b={NODE_ENV:'test',ROTAMOTO_DISPOSABLE_CAMPAIGN:'0304B',ROTAMOTO_LOTE1B_DATABASE:lote1bDatabase,
  ROTAMOTO_DISPOSABLE_RUNTIME_DATABASE_URL:`postgresql://rotamoto_app@127.0.0.1:5432/${lote1bDatabase}`,
  ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL:`postgresql://rotamoto_migrator@127.0.0.1:5432/${lote1bDatabase}`};
assert.equal(resolveE2eTargets(lote1b).database,lote1bDatabase,'Lote 1B may target only its generated disposable database');
assert.throws(()=>resolveE2eTargets({...lote1b,ROTAMOTO_LOTE1B_DATABASE:'rotamoto_e2e'}),/nome de banco gerado/u);
assert.throws(()=>resolveE2eTargets({...lote1b,ROTAMOTO_DISPOSABLE_RUNTIME_DATABASE_URL:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto'}),/aceita somente/u);

const rejected = [
  { ...valid, NODE_ENV: 'development' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: undefined },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/postgres' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/template0' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/template1' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@db.example:5432/rotamoto_e2e' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@localhost:5432/rotamoto_e2e' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@[::1]:5432/rotamoto_e2e' },
  { ...valid, E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e' },
  { ...valid, E2E_MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e' },
  { ...valid, E2E_MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_migrator:secret@127.0.0.1:5432/rotamoto_e2e' },
  { ...valid, E2E_MIGRATOR_DATABASE_URL: `${valid.E2E_MIGRATOR_DATABASE_URL}?sslmode=disable` },
  { ...valid, E2E_MIGRATOR_DATABASE_URL: `${valid.E2E_MIGRATOR_DATABASE_URL}#fragment` }
];
let constructed = 0;
class CountingClient { constructor() { constructed += 1; } }
for (const env of rejected) {
  assert.throws(() => resolveE2eTargets(env));
  assert.throws(() => createE2eClients(env, CountingClient));
}
assert.equal(constructed, 0, 'all invalid targets are rejected before client construction');
assert.throws(() => validateConnectionUrl(valid.E2E_RUNTIME_DATABASE_URL,
  { database: 'rotamoto_e2e', role: 'rotamoto_app', nodeEnv: 'production' }));
console.log('E2E fixture guards: PASS (hostile database/role/host/environment inputs rejected before client construction)');
