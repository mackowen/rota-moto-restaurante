'use strict';

const { inventoryFixtureManifests, markFixtureInterrupted, resumeFixtureManifest } = require('../tests/e2e-support/fixture-manifest');

async function main(args) {
  const [command, runId] = args;
  if (command === 'inventory' && !runId) {
    process.stdout.write(`${JSON.stringify(await inventoryFixtureManifests(), null, 2)}\n`);
    return;
  }
  if (command === 'recover' && runId) {
    const result = await markFixtureInterrupted({ runId });
    process.stdout.write(`${JSON.stringify({ runId: result.runId, status: result.status,
      databaseCommitted: result.databaseCommitted, retentionReason: result.retentionReason }, null, 2)}\n`);
    return;
  }
  if (command === 'resume' && runId) {
    const result = await resumeFixtureManifest({ runId });
    process.stdout.write(`${JSON.stringify({ runId: result.runId, status: result.status,
      recoveryStage: result.recoveryStage, databaseCommitted: result.databaseCommitted,
      retentionReason: result.retentionReason }, null, 2)}\n`);
    return;
  }
  throw new Error('Use: node scripts/e2e-fixtures.js inventory | recover <run-uuid> | resume <run-uuid>');
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`E2E fixture inventory: ${error.message}\n`);
  process.exitCode = 1;
});
