'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { resolveMigrationInvocation } = require('../backend/postgres/migrate');

const runner = path.join(__dirname, '../backend/postgres/migrate.js');
const official = 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto';
const qa = 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e';
const env = { NODE_ENV: 'test', MIGRATOR_DATABASE_URL: official,
  E2E_MIGRATOR_DATABASE_URL: qa };

assert.deepEqual(resolveMigrationInvocation(['up', '--e2e'], env),
  { command: 'up', connectionString: qa });
assert.deepEqual(resolveMigrationInvocation(['status'], env),
  { command: 'status', connectionString: official }, 'normal mode keeps the official target');
assert.throws(() => resolveMigrationInvocation(['up'], env),
  /Migrations mutáveis em NODE_ENV=test exigem --e2e/, 'tests cannot run mutable migrations against the official target');
assert.throws(() => resolveMigrationInvocation(['up'], { ...env, MIGRATOR_DATABASE_URL: qa }),
  /Migrations mutáveis em NODE_ENV=test exigem --e2e/, 'normal mode refuses mutable migrations in test mode');
assert.throws(() => resolveMigrationInvocation(['down', '--e2e'], env), /Uso:/,
  'E2E mode does not offer a destructive down command');

const invalid = [
  ['official database', { E2E_MIGRATOR_DATABASE_URL: official }],
  ['postgres database', { E2E_MIGRATOR_DATABASE_URL: qa.replace('/rotamoto_e2e', '/postgres') }],
  ['template0', { E2E_MIGRATOR_DATABASE_URL: qa.replace('/rotamoto_e2e', '/template0') }],
  ['template1', { E2E_MIGRATOR_DATABASE_URL: qa.replace('/rotamoto_e2e', '/template1') }],
  ['non-loopback host', { E2E_MIGRATOR_DATABASE_URL: qa.replace('127.0.0.1', '192.0.2.1') }],
  ['non-test environment', { NODE_ENV: 'development' }],
  ['password in URL', { E2E_MIGRATOR_DATABASE_URL: qa.replace('rotamoto_migrator@',
    `rotamoto_migrator:${String.fromCharCode(120)}@`) }],
  ['runtime role', { E2E_MIGRATOR_DATABASE_URL: qa.replace('rotamoto_migrator@', 'rotamoto_app@') }],
  ['unexpected URL query', { E2E_MIGRATOR_DATABASE_URL: `${qa}?sslmode=disable` }],
];

for (const [label, change] of invalid) {
  const input = { ...env, ...change };
  assert.throws(() => resolveMigrationInvocation(['up', '--e2e'], input),
    /Migrations E2E exigem/, `${label} must fail before a client exists`);
  const result = spawnSync(process.execPath, [runner, 'up', '--e2e'], {
    env: { ...process.env, ...input }, encoding: 'utf8'
  });
  assert.equal(result.status, 1, `${label}: CLI must fail`);
  assert.match(result.stderr, /Migrations E2E exigem/);
  assert.doesNotMatch(result.stderr, /ECONN|ENOTFOUND|falha PostgreSQL|:x@/,
    `${label}: validation must precede connection and not log URL secrets`);
}

console.log('E2E migration guards: OK (pre-connection rejection)');
