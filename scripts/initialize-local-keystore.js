'use strict';
const { initializeFileSecretStore } = require('../backend/runtime/file-secret-provider');

(async () => {
  const directory = process.env.ROTAMOTO_SECRET_STORE_DIRECTORY;
  const masterKeyFile = process.env.ROTAMOTO_SECRET_MASTER_KEY_FILE;
  await initializeFileSecretStore({ directory, masterKeyFile });
  process.stdout.write('Local keystore initialized; protect the master key file with a separate operator backup.\n');
})().catch(error => {
  process.stderr.write(`${error.code || 'KEYSTORE_INITIALIZATION_FAILED'}\n`);
  process.exitCode = 1;
});
