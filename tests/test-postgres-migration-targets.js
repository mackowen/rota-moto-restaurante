'use strict';

const assert = require('node:assert/strict');
const { getMigrations, resolveMigrationInvocation, assert0110RehearsalState } = require('../backend/postgres/migrate');

const database = 'rotamoto_disposable_0110_20261009_004823_6e50bdf3';
const url = `postgresql://rotamoto_migrator@127.0.0.1:5432/${database}`;
const env = { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0110', ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL: url };

assert.equal(resolveMigrationInvocation(['up', '--rehearsal-0110'], env).connectionString, url);
assert.equal(resolveMigrationInvocation(['status', '--rehearsal-0110'], env).rehearsal0110, true);
assert.throws(() => resolveMigrationInvocation(['down', '--rehearsal-0110'], env), /Uso:/u);
assert.throws(() => resolveMigrationInvocation(['up', '--rehearsal-0110'], { ...env, NODE_ENV: 'production' }), /NODE_ENV=test/u);
assert.throws(() => resolveMigrationInvocation(['up', '--rehearsal-0110'], { ...env, ROTAMOTO_DISPOSABLE_CAMPAIGN: '0109' }), /0110/u);
for (const target of [
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto',
  'postgresql://rotamoto_migrator@192.0.2.1:5432/rotamoto_disposable_0110_20261009_004823_6e50bdf3',
  'postgresql://rotamoto_migrator:secret@127.0.0.1:5432/rotamoto_disposable_0110_20261009_004823_6e50bdf3',
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_disposable_0068_source',
  'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_disposable_0110_20261009_004823_6e50bdf3',
]) assert.throws(() => resolveMigrationInvocation(['up', '--rehearsal-0110'], { ...env, ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL: target }));

const migrations = getMigrations();
const targetIndex = migrations.findIndex(migration => migration.id === '0039_driver_operational_availability');
const priorLedger = new Map(migrations.slice(0, targetIndex).map(migration => [migration.id, migration.checksum]));
assert.equal(assert0110RehearsalState(priorLedger, migrations), '0039_driver_operational_availability');
assert.throws(() => assert0110RehearsalState(new Map(), migrations), /ledger 0038 íntegro/u);
assert.equal(assert0110RehearsalState(new Map([...priorLedger, [migrations[targetIndex].id, migrations[targetIndex].checksum]]), migrations), null,
  'a second rehearsal up is a no-op after 0039 is applied');
assert.throws(() => assert0110RehearsalState(new Map([...priorLedger].slice(1)), migrations), /ledger 0038 íntegro/u);

console.log('PostgreSQL migration target guards: OK');
