'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { verifyRecoverySet } = require('./recovery-set');
const { getMigrations } = require('../postgres/migrate');

const SET_NAME = /^[0-9a-f-]{36}\.set$/u;

function compareMigrationCoverage(applied, expected = getMigrations()) {
  if (!Array.isArray(applied)) return Object.freeze({ state: 'UNKNOWN', appliedCount: null, latestApplied: null,
    missing: [], checksumMismatches: [], unexpected: [] });
  const actual = new Map(applied.map(row => [row.id, row.checksum]));
  const desired = new Map(expected.map(row => [row.id, row.checksum]));
  const missing = [...desired.keys()].filter(id => !actual.has(id));
  const checksumMismatches = [...desired].filter(([id, checksum]) => actual.has(id) && actual.get(id) !== checksum).map(([id]) => id);
  const unexpected = [...actual.keys()].filter(id => !desired.has(id));
  const state = checksumMismatches.length || unexpected.length ? 'DIVERGENT' : missing.length ? 'STALE' : 'CURRENT';
  return Object.freeze({ state, appliedCount: applied.length, latestApplied: applied.at(-1)?.id || null,
    expectedLatest: expected.at(-1)?.id || null, missing, checksumMismatches, unexpected });
}

async function inventoryRecoverySets({ directory, keyFile, verify = verifyRecoverySet, now = new Date() }) {
  if (!path.isAbsolute(directory || '') || !path.isAbsolute(keyFile || '')) {
    throw inventoryError('BACKUP_INVENTORY_CONFIGURATION_REQUIRED');
  }
  const root = path.resolve(directory);
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (rootStat.mode & 0o077) ||
      typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) {
    throw inventoryError('BACKUP_INVENTORY_DIRECTORY_UNSAFE');
  }
  const names = await fs.readdir(root);
  if (names.includes('.retention.lock')) throw inventoryError('BACKUP_INVENTORY_BUSY');

  const items = [];
  for (const name of names.sort()) {
    if (/^\.staging-set-/u.test(name)) {
      items.push({ id: null, state: 'INCOMPLETE', reason: 'STAGING_REQUIRES_REVIEW' });
      continue;
    }
    if (/^\.expired-/u.test(name)) {
      items.push({ id: null, state: 'INCOMPLETE', reason: 'QUARANTINE_REQUIRES_REVIEW' });
      continue;
    }
    if (!SET_NAME.test(name)) continue;
    const id = name.slice(0, -'.set'.length);
    try {
      const manifest = await verify({ directory: root, id, keyFile });
      items.push({ id, state: 'VERIFIED', format: manifest.format, createdAt: manifest.createdAt,
        databaseBytes: manifest.database.sizeBytes, databaseSha256: manifest.database.sha256,
        mediaObjects: manifest.media.objectCount, mediaBytes: manifest.media.plaintextBytes,
        schemaCoverage: compareMigrationCoverage(manifest.schemaMigrations) });
    } catch (_) {
      items.push({ id, state: 'INCOMPLETE', reason: 'RECOVERY_SET_VERIFICATION_FAILED' });
    }
  }
  const counts = { verified: 0, incomplete: 0 };
  for (const item of items) counts[item.state === 'VERIFIED' ? 'verified' : 'incomplete']++;
  return Object.freeze({ inventoryVersion: 1, checkedAt: now.toISOString(), counts, items });
}

function inventoryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = { inventoryRecoverySets, compareMigrationCoverage };
