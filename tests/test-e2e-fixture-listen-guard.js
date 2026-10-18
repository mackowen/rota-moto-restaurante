'use strict';

const assert = require('node:assert/strict');
const { runFixtureLifecycle } = require('./e2e-support/fixture-lifecycle');

const base = {
  NODE_ENV: 'test',
  E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',
  E2E_MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e',
  ROTAMOTO_E2E_CAMPAIGN: '0251'
};

async function main() {
  await assert.rejects(runFixtureLifecycle({ env: base, listenPort: 8083 }), /Porta E2E 8787 fixa permitida somente/u);
  await assert.rejects(runFixtureLifecycle({ env: { ...base, ROTAMOTO_E2E_CAMPAIGN: '0243' }, listenPort: 8787 }),
    /Porta E2E 8787 fixa permitida somente/u);
  await assert.rejects(runFixtureLifecycle({ env: { ...base,
    E2E_RUNTIME_DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' }, listenPort: 8787 }),
  /aceita somente rotamoto_app@127\.0\.0\.1:5432\/rotamoto_e2e/u);
  await assert.rejects(runFixtureLifecycle({ env: { ...base, DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' },
    listenPort: 8787 }), /Porta E2E 8787 fixa permitida somente/u);
  console.log('E2E fixture listen guard: PASS (fixed API port is limited to campaign 0251 test fixtures in rotamoto_e2e).');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
