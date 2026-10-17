'use strict';

const assert = require('node:assert/strict');
const { target, PRESERVED } = require('../scripts/reset-e2e-installation');

const prior = { node: process.env.NODE_ENV, campaign: process.env.ROTAMOTO_DISPOSABLE_CAMPAIGN, url: process.env.E2E_MIGRATOR_DATABASE_URL };
try {
  process.env.NODE_ENV = 'test';
  process.env.ROTAMOTO_DISPOSABLE_CAMPAIGN = '0240';
  process.env.E2E_MIGRATOR_DATABASE_URL = 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e';
  assert.equal(target(), process.env.E2E_MIGRATOR_DATABASE_URL);
  assert.deepEqual([...PRESERVED].sort(), ['rotamoto.installation_bootstrap', 'rotamoto.permissions', 'rotamoto.schema_migrations'].sort());
  for (const invalid of [
    'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto',
    'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',
    'postgresql://rotamoto_migrator:secret@127.0.0.1:5432/rotamoto_e2e',
    'postgresql://rotamoto_migrator@db.example:5432/rotamoto_e2e',
  ]) {
    process.env.E2E_MIGRATOR_DATABASE_URL = invalid;
    assert.throws(() => target(), /Reset aceita somente/u);
  }
  process.env.E2E_MIGRATOR_DATABASE_URL = prior.url || '';
  process.env.ROTAMOTO_DISPOSABLE_CAMPAIGN = '0239';
  assert.throws(() => target(), /Reset exige NODE_ENV=test/u);
  console.log('E2E reset target and preservation guards: PASS');
} finally {
  for (const [key, value] of [['NODE_ENV', prior.node], ['ROTAMOTO_DISPOSABLE_CAMPAIGN', prior.campaign], ['E2E_MIGRATOR_DATABASE_URL', prior.url]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
