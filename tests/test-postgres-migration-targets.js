'use strict';

const assert = require('node:assert/strict');
const { getMigrations, checksumMatches, resolveMigrationInvocation, assert0110RehearsalState, assert0115RehearsalState,
  assert0116RehearsalState, assertOfficial0116State, assertOfficial0154State,
  official0154MigrationConnectionString, official0234MigrationConnectionString, assertOfficial0234State } = require('../backend/postgres/migrate');

const database = 'rotamoto_disposable_0110_20261009_004823_6e50bdf3';
const url = `postgresql://rotamoto_migrator@127.0.0.1:5432/${database}`;
const env = { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0110', ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL: url };

const e2eThroughEnv = { NODE_ENV: 'test', ROTAMOTO_BOOTSTRAP_DISPOSABLE: '0234', ROTAMOTO_BOOTSTRAP_PGPORT: '55491',
  E2E_MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_migrator@127.0.0.1:55491/rotamoto_e2e' };
const e2eThrough = resolveMigrationInvocation(['up', '--e2e-through=0044_99food_distributed_rate_limit'], e2eThroughEnv);
assert.equal(e2eThrough.connectionString, e2eThroughEnv.E2E_MIGRATOR_DATABASE_URL);
assert.equal(e2eThrough.throughId, '0044_99food_distributed_rate_limit');
assert.throws(() => resolveMigrationInvocation(['up', '--e2e-through=0044_99food_distributed_rate_limit'], { ...e2eThroughEnv, ROTAMOTO_BOOTSTRAP_PGPORT: '5432' }), /porta descartável/u);
assert.throws(() => resolveMigrationInvocation(['down', '--e2e-through=0044_99food_distributed_rate_limit'], e2eThroughEnv), /Uso:/u);

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
assert.equal(migration0040Index, 39, '0040 remains at its immutable historical position');
const migrationsThrough0040 = migrations.slice(0, migration0040Index + 1);
assert.deepEqual(migrations.slice(-10).map(migration => migration.id), ['0042_marketplace_99food_runtime','0043_99food_application_and_cash_commands','0044_99food_distributed_rate_limit','0045_installation_bootstrap','0046_bootstrap_legacy_installation_latch','0047_administrative_mfa_recovery','0048_platform_administration','0049_platform_administration_hardening','0050_company_role_descriptions','0051_company_role_description_runtime_update'], 'company role descriptions append after immutable identity migrations');
const migration0042 = migrations.find(migration => migration.id === '0042_marketplace_99food_runtime');
const migration0043 = migrations.find(migration => migration.id === '0043_99food_application_and_cash_commands');
assert.match(migration0042.up,/claim_marketplace_99food_token_refresh/u);
assert.match(migration0042.up,/CHECK \(provider IN \('ifood','keeta','99food'\)\)/u);
assert.match(migration0042.down,/rollback 0042 bloqueado/iu);
assert.match(migration0043.up,/CONFIRM_CASH_PAYMENT/u);
assert.match(migration0043.down,/rollback 0043 blocked/iu);
const migration0044 = migrations.find(migration => migration.id === '0044_99food_distributed_rate_limit');
assert.match(migration0044.up,/FORCE ROW LEVEL SECURITY/u);
assert.match(migration0044.up,/consume_99food_rate_limit/u);
assert.match(migration0044.up,/rotamoto_provider_worker/u);
assert.match(migration0044.down,/rollback bloqueado/u);
const migration0045 = migrations.find(migration => migration.id === '0045_installation_bootstrap');
assert.match(migration0045.up,/bootstrap_authorizations/u);
assert.match(migration0045.up,/REVOKE ALL[\s\S]*FROM PUBLIC/u);
assert.match(migration0045.down,/rollback blocked: bootstrap history exists/u);
const migration0046 = migrations.find(migration => migration.id === '0046_bootstrap_legacy_installation_latch');
assert.match(migration0046.up,/EXISTS \(SELECT 1 FROM rotamoto\.companies\)/u);
assert.match(migration0046.down,/rollback blocked/u);
const migration0047=migrations.find(migration=>migration.id==='0047_administrative_mfa_recovery');
assert.match(migration0047.up,/FORCE ROW LEVEL SECURITY/u);
assert.match(migration0047.up,/token_digest bytea NOT NULL UNIQUE/u);
assert.match(migration0047.up,/request_id uuid REFERENCES rotamoto\.mfa_recovery_requests/u);
assert.match(migration0047.down,/rollback blocked/u);
const migration0048=migrations.find(migration=>migration.id==='0048_platform_administration');
assert.match(migration0048.up,/platform_administrators/u);
assert.match(migration0048.up,/platform_admin_context_is_active/u);
assert.match(migration0048.up,/platform_admin_audit_log/u);
assert.match(migration0048.up,/platform_admin_bootstrap_founder/u);
assert.match(migration0048.up,/session_user <> 'rotamoto_migrator'/u);
assert.match(migration0048.up,/current_database\(\) NOT IN \('rotamoto','rotamoto_e2e'\)/u);
assert.match(migration0048.down,/rollback blocked/u);
const migration0049=migrations.find(migration=>migration.id==='0049_platform_administration_hardening');
assert.match(migration0049.up,/actor_kind,action,resource_type/u);
assert.match(migration0049.down,/rollback 0049 blocked/u);
assert.equal(checksumMatches(migration0048,'ac8d0896daa6b5b75b98c15c79d2ade03943d0f6e5cfc93525d5d026d745e547'),true,
  'the original 0048 content matches its recorded E2E digest');
assert.equal(checksumMatches(migration0048,'0'.repeat(64)),false,'unknown checksum changes remain rejected');
const ledger0039 = new Map(migrationsThrough0040.slice(0, migration0040Index).map(migration => [migration.id, migration.checksum]));
const ledger0040 = new Map([...ledger0039, [migrationsThrough0040.at(-1).id, migrationsThrough0040.at(-1).checksum]]);
assert.equal(assert0115RehearsalState(ledger0039, migrationsThrough0040), '0040_restaurant_driver_queue');
assert.throws(() => assert0115RehearsalState(new Map([...ledger0039].slice(1)), migrationsThrough0040), /ledger (?:exato|íntegro) 0001–0039/u);
assert.throws(() => assert0115RehearsalState(new Map([...ledger0039].map(([id, checksum], index) => [id, index === 0 ? '0'.repeat(64) : checksum])), migrationsThrough0040), /ledger íntegro 0001–0039/u);
assert.equal(assert0115RehearsalState(new Map([...ledger0039, [migrations[migration0040Index].id, migrations[migration0040Index].checksum]]), migrationsThrough0040), null,
  'a second rehearsal up is a no-op after 0040 is applied');
assert.throws(() => assert0115RehearsalState(new Map([...ledger0039, ['0041_future', '0'.repeat(64)]]), migrationsThrough0040), /ledger exato/u);
assert.throws(() => assert0115RehearsalState(ledger0039, [...migrationsThrough0040, { id: '0041_future', checksum: '0'.repeat(64) }]), /0040 como última migration/u);

const database0116 = 'rotamoto_disposable_0116_20261009_152123_114b093a';
const url0116 = `postgresql://rotamoto_migrator@127.0.0.1:5432/${database0116}`;
const env0116 = { NODE_ENV: 'test', ROTAMOTO_DISPOSABLE_CAMPAIGN: '0116', ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL: url0116 };
assert.equal(resolveMigrationInvocation(['up', '--rehearsal-0116'], env0116).connectionString, url0116);
assert.equal(resolveMigrationInvocation(['status', '--rehearsal-0116'], env0116).rehearsal0116, true);
assert.throws(() => resolveMigrationInvocation(['down', '--rehearsal-0116'], env0116), /Uso:/u);
for (const target of [
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto',
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e',
  'postgresql://rotamoto_migrator@192.0.2.1:5432/rotamoto_disposable_0116_20261009_152123_114b093a',
  'postgresql://rotamoto_migrator:secret@127.0.0.1:5432/rotamoto_disposable_0116_20261009_152123_114b093a',
  'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_disposable_0116_20261009_152123_114b093a',
  'postgresql://rotamoto_migrator@127.0.0.1:5433/rotamoto_disposable_0116_20261009_152123_114b093a',
  'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_disposable_0115_clone'
]) assert.throws(() => resolveMigrationInvocation(['up', '--rehearsal-0116'], { ...env0116, ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL: target }));
assert.equal(assert0116RehearsalState(ledger0039, migrationsThrough0040), '0040_restaurant_driver_queue');
assert.equal(assert0116RehearsalState(ledger0040, migrationsThrough0040), null);
assert.throws(() => assert0116RehearsalState(new Map([...ledger0039].slice(1)), migrationsThrough0040), /ledger (?:exato|íntegro) 0001–0039/u);

const official0116Env = { NODE_ENV: 'production', MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto',
  ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN: '0116', ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE: 'rotamoto',
  ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATION: '0040_restaurant_driver_queue' };
assert.equal(resolveMigrationInvocation(['status', '--verify-0116'], official0116Env).verifyOfficial0116, true);
assert.equal(resolveMigrationInvocation(['up', '--apply-0116'], official0116Env).applyOfficial0116, true);
assert.throws(() => resolveMigrationInvocation(['down', '--apply-0116'], official0116Env), /Uso:/u);
for (const patch of [
  { NODE_ENV: 'test' },
  { ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN: '0115' },
  { ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE: 'rotamoto_e2e' },
  { ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATION: '0041_future' },
  { MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e' },
  { MIGRATOR_DATABASE_URL: 'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto?sslmode=disable' }
]) assert.throws(() => resolveMigrationInvocation(['up', '--apply-0116'], { ...official0116Env, ...patch }));
assert.equal(assertOfficial0116State(ledger0039, migrationsThrough0040), 'pending');
assert.equal(assertOfficial0116State(ledger0040, migrationsThrough0040, { allowApplied: true }), 'applied');
assert.throws(() => assertOfficial0116State(ledger0040, migrationsThrough0040), /ledger íntegro/u);
assert.throws(() => assertOfficial0116State(new Map([...ledger0039, ['0041_future', '0'.repeat(64)]]), migrationsThrough0040), /ledger íntegro/u);
assert.throws(() => assertOfficial0116State(ledger0039, [...migrationsThrough0040, { id: '0041_future', checksum: '0'.repeat(64) }]), /0040 como única migration/u);

const official0154Env={NODE_ENV:'production',ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN:'0154',
  ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE:'rotamoto',
  ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATIONS:'0042_marketplace_99food_runtime,0043_99food_application_and_cash_commands,0044_99food_distributed_rate_limit',
  MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto'};
assert.equal(official0154MigrationConnectionString(official0154Env),official0154Env.MIGRATOR_DATABASE_URL);
assert.throws(()=>official0154MigrationConnectionString({...official0154Env,ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE:'rotamoto_e2e'}),/confirmações explícitas/u);
const official0154Prior=new Map(migrations.slice(0,41).map(migration=>[migration.id,migration.checksum]));
const migrationsThrough0044=migrations.slice(0,migrations.findIndex(migration=>migration.id==='0045_installation_bootstrap'));
assert.deepEqual(assertOfficial0154State(official0154Prior,migrationsThrough0044),{applied:[],pending:['0042_marketplace_99food_runtime','0043_99food_application_and_cash_commands','0044_99food_distributed_rate_limit']});
assert.throws(()=>assertOfficial0154State(new Map([...official0154Prior,['0042_marketplace_99food_runtime','0'.repeat(64)]]),migrationsThrough0044),/ledger íntegro/u);
assert.throws(()=>assertOfficial0154State(new Map([...official0154Prior,['0043_99food_application_and_cash_commands',migrations.find(item=>item.id==='0043_99food_application_and_cash_commands').checksum]]),migrationsThrough0044,{allowApplied:true}),/fora de sequência/u);

const official0234Env={NODE_ENV:'production',ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN:'0234',
  ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE:'rotamoto',
  ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATIONS:'0045_installation_bootstrap,0046_bootstrap_legacy_installation_latch,0047_administrative_mfa_recovery',
  MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto'};
assert.equal(official0234MigrationConnectionString(official0234Env),official0234Env.MIGRATOR_DATABASE_URL);
assert.equal(resolveMigrationInvocation(['status','--verify-0234'],official0234Env).verifyOfficial0234,true);
assert.equal(resolveMigrationInvocation(['up','--apply-0234'],official0234Env).applyOfficial0234,true);
assert.throws(()=>resolveMigrationInvocation(['down','--apply-0234'],official0234Env),/Uso:/u);
for(const patch of [
  {NODE_ENV:'test'}, {ROTAMOTO_OFFICIAL_MIGRATION_CAMPAIGN:'0233'},
  {ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_DATABASE:'rotamoto_e2e'},
  {ROTAMOTO_OFFICIAL_MIGRATION_CONFIRM_MIGRATIONS:'0045_installation_bootstrap'},
  {MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e'},
  {MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto?sslmode=disable'}
]) assert.throws(()=>official0234MigrationConnectionString({...official0234Env,...patch}));
const officialPrefix=migrations.slice(0,44);
const official0234Prior=new Map(officialPrefix.map(migration=>[migration.id,migration.checksum]));
assert.deepEqual(assertOfficial0234State(official0234Prior,migrations),{
  applied:[],pending:['0045_installation_bootstrap','0046_bootstrap_legacy_installation_latch','0047_administrative_mfa_recovery']});
const with0045=new Map([...official0234Prior,[migrations[44].id,migrations[44].checksum]]);
assert.deepEqual(assertOfficial0234State(with0045,migrations,{allowApplied:true}),{
  applied:['0045_installation_bootstrap'],pending:['0046_bootstrap_legacy_installation_latch','0047_administrative_mfa_recovery']});
assert.throws(()=>assertOfficial0234State(with0045,migrations),/migrations 0045–0047 pendentes/u);
assert.throws(()=>assertOfficial0234State(new Map([...official0234Prior,[migrations[45].id,migrations[45].checksum]]),migrations,{allowApplied:true}),/sequencialmente aplicadas/u);
assert.throws(()=>assertOfficial0234State(new Map([...official0234Prior,[migrations[43].id,'0'.repeat(64)]]),migrations),/ledger íntegro/u);
assert.throws(()=>assertOfficial0234State(new Map([...official0234Prior,['0048_future','0'.repeat(64)]]),migrations),/ledger íntegro/u);
assert.throws(()=>assertOfficial0234State(official0234Prior,[...migrations,{id:'0048_future',checksum:'0'.repeat(64)}]),/somente 0045–0047/u);

console.log('PostgreSQL migration target guards: OK');
