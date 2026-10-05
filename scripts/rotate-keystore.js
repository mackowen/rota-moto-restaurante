'use strict';
const { rotateFileKeystore } = require('../backend/runtime/keystore-rotation');
const { appendOperatorAudit } = require('../backend/runtime/operator-audit');

(async () => {
  const [directory, masterKeyFile, manifestFile] = process.argv.slice(2);
  if (process.argv.length !== 5) throw new Error('Uso: node scripts/rotate-keystore.js <keystore-dir> <master-key-file> <manifesto-privado.json>');
  await appendOperatorAudit('keystore.rotate.started');
  const result = await rotateFileKeystore({ directory, masterKeyFile, manifestFile });
  await appendOperatorAudit('keystore.rotate.completed', { secretCount: result.secrets });
  process.stdout.write(`${JSON.stringify({ event: 'keystore.rotation.complete', secretCount: result.secrets, backupDirectory: result.backupDirectory })}\n`);
})().catch(error => { process.stderr.write(`${JSON.stringify({ event: 'keystore.rotation.failed', code: /^[A-Z0-9_]{2,48}$/u.test(error.code || '') ? error.code : 'ROTATION_FAILED' })}\n`); process.exitCode = 1; });
