'use strict';

const assert = require('node:assert/strict');
const { getMigrations, resolveMigrationInvocation, assert0110RehearsalState, assert0115RehearsalState } = require('../backend/postgres/migrate');

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

const database0115 = 'rotamoto_disposable_0115_20261009_e67e6a45';
const url0115 = `postgresql://rotamoto_migrator@127.0.0.1:5432/${database0115}`;
const env0115 = { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0115', ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL: url0115 };
assert.equal(resolveMigrationInvocation(['up', '--rehearsal-0115'], env0115).connectionString, url0115);
assert.equal(resolveMigrationInvocation(['status', '--rehearsal-0115'], env0115).rehearsal0115, true);
assert.throws(() => resolveMigrationInvocation(['down', '--rehearsal-0115'], env0115), /Uso:/u);
assert.throws(() => resolveMigrationInvocation(['up', '--rehearsal-0115'], { ...env0115, NODE_ENV: 'production' }), /NODE_ENV=test/u);
assert.throws(() => resolveMigrationInvocation(['up', '--rehearsal-0115'], { ...env0115, ROTAMOTO_DISPOSABLE_CAMPAIGN: '0114' }), /0115/u);
for (const target of [
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto',
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e',
  'postgresql://rotamoto_migrator@192.0.2.1:5432/rotamoto_disposable_0115_20261009_e67e6a45',
  'postgresql://rotamoto_migrator:secret@127.0.0.1:5432/rotamoto_disposable_0115_20261009_e67e6a45',
  'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_disposable_0115_20261009_e67e6a45',
  'postgresql://rotamoto_migrator@127.0.0.1:5433/rotamoto_disposable_0115_20261009_e67e6a45',
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_disposable_0114_clone'
]) assert.throws(() => resolveMigrationInvocation(['up', '--rehearsal-0115'], { ...env0115, ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL: target }));
const migration0040Index = migrations.findIndex(migration => migration.id === '0040_restaurant_driver_queue');
assert.equal(migration0040Index, migrations.length - 1, '0040 is the final migration in the current codebase');
const ledger0039 = new Map(migrations.slice(0, migration0040Index).map(migration => [migration.id, migration.checksum]));
assert.equal(assert0115RehearsalState(ledger0039, migrations), '0040_restaurant_driver_queue');
assert.throws(() => assert0115RehearsalState(new Map([...ledger0039].slice(1)), migrations), /ledger (?:exato|íntegro) 0001–0039/u);
assert.throws(() => assert0115RehearsalState(new Map([...ledger0039].map(([id, checksum], index) => [id, index === 0 ? '0'.repeat(64) : checksum])), migrations), /ledger íntegro 0001–0039/u);
assert.equal(assert0115RehearsalState(new Map([...ledger0039, [migrations[migration0040Index].id, migrations[migration0040Index].checksum]]), migrations), null,
  'a second rehearsal up is a no-op after 0040 is applied');
assert.throws(() => assert0115RehearsalState(new Map([...ledger0039, ['0041_future', '0'.repeat(64)]]), migrations), /ledger exato/u);
assert.throws(() => assert0115RehearsalState(ledger0039, [...migrations, { id: '0041_future', checksum: '0'.repeat(64) }]), /0040 como última migration/u);

console.log('PostgreSQL migration target guards: OK');
