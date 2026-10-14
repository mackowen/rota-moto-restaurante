'use strict';

const { inventoryRecoverySets } = require('../backend/runtime/backup-inventory');

(async () => {
  const directory = process.env.ROTAMOTO_BACKUP_DIRECTORY;
  const keyFile = process.env.ROTAMOTO_BACKUP_KEY_FILE;
  const inventory = await inventoryRecoverySets({ directory, keyFile });
  process.stdout.write(`${JSON.stringify({ event: 'operator.backup.inventory', ...inventory })}\n`);
})().catch(error => {
  const code = /^[A-Z0-9_]{2,48}$/u.test(error.code || '') ? error.code : 'BACKUP_INVENTORY_FAILED';
  process.stderr.write(`${JSON.stringify({ event: 'operator.backup.inventory.failed', code })}\n`);
  process.exitCode = 1;
});
