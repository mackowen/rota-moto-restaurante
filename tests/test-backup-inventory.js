'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { inventoryRecoverySets, compareMigrationCoverage } = require('../backend/runtime/backup-inventory');
const { getMigrations } = require('../backend/postgres/migrate');

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-backup-inventory-'));
  const directory = path.join(root, 'sets');
  const keyFile = path.join(root, 'key');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(keyFile, 'x', { mode: 0o600 });
  const validId = '11111111-1111-4111-8111-111111111111';
  const invalidId = '22222222-2222-4222-8222-222222222222';
  await fs.mkdir(path.join(directory, `${validId}.set`), { mode: 0o700 });
  await fs.mkdir(path.join(directory, `${invalidId}.set`), { mode: 0o700 });
  await fs.mkdir(path.join(directory, '.staging-set-interrupted'), { mode: 0o700 });
  const verify = async ({ id }) => {
    if (id !== validId) throw new Error('sensitive diagnostic must not escape');
    return { id, format: 'rotamoto-recovery-set-v1', createdAt: '2026-10-14T00:00:00.000Z',
      database: { sizeBytes: 12, sha256: 'a'.repeat(64) },
      schemaMigrations: getMigrations().slice(0, 41).map(({ id: migrationId, checksum }) => ({ id: migrationId, checksum })),
      media: { objectCount: 0, plaintextBytes: 0 } };
  };
  const result = await inventoryRecoverySets({ directory, keyFile, verify, now: new Date('2026-10-14T01:00:00.000Z') });
  assert.deepEqual(result.counts, { verified: 1, incomplete: 2 });
  assert.equal(result.items.find(item => item.id === validId).state, 'VERIFIED');
  const coverage = result.items.find(item => item.id === validId).schemaCoverage;
  assert.equal(coverage.state, 'STALE');
  assert.equal(coverage.latestApplied, '0041_delivery_custody_return');
  assert.deepEqual(coverage.missing, ['0042_marketplace_99food_runtime','0043_99food_application_and_cash_commands',
    '0044_99food_distributed_rate_limit','0045_installation_bootstrap','0046_bootstrap_legacy_installation_latch','0047_administrative_mfa_recovery',
    '0048_platform_administration','0049_platform_administration_hardening']);
  assert.equal(compareMigrationCoverage(null).state, 'UNKNOWN', 'legacy recovery sets without ledger metadata remain explicitly unknown');
  assert.equal(compareMigrationCoverage([{ id: getMigrations()[0].id, checksum: '0'.repeat(64) }]).state, 'DIVERGENT',
    'a recovery set with a mismatched migration checksum is visibly divergent');
  assert.equal(result.items.find(item => item.id === invalidId).reason, 'RECOVERY_SET_VERIFICATION_FAILED');
  assert(result.items.some(item => item.reason === 'STAGING_REQUIRES_REVIEW'));
  assert.equal((await fs.readdir(directory)).length, 3, 'inventory must not modify or remove artifacts');
  await fs.writeFile(path.join(directory, '.retention.lock'), 'active', { mode: 0o600 });
  await assert.rejects(() => inventoryRecoverySets({ directory, keyFile, verify }), /BACKUP_INVENTORY_BUSY/);
  await fs.unlink(path.join(directory, '.retention.lock'));
  const unsafe = path.join(root, 'unsafe');
  await fs.mkdir(unsafe, { mode: 0o755 });
  await fs.chmod(unsafe, 0o755);
  await assert.rejects(() => inventoryRecoverySets({ directory: unsafe, keyFile, verify }), /BACKUP_INVENTORY_DIRECTORY_UNSAFE/);
  await fs.rm(root, { recursive: true, force: true });
  console.log('Backup inventory: verified/incomplete states, private-path guard, retention lock, no-write behavior PASS');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
