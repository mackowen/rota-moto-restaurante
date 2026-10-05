'use strict';
const { createFileSecretProvider } = require('../backend/runtime/file-secret-provider');

(async () => {
  const [scope, name, tenantId] = process.argv.slice(2);
  if (process.stdin.isTTY || !['installation', 'tenant'].includes(scope) || !name ||
      (scope === 'tenant' && !tenantId) || (scope === 'installation' && tenantId)) {
    throw new Error('Use stdin não interativo: store-local-secret.js <installation|tenant> <nome> [tenant-uuid].');
  }
  const provider = await createFileSecretProvider({ directory: process.env.ROTAMOTO_SECRET_STORE_DIRECTORY,
    masterKeyFile: process.env.ROTAMOTO_SECRET_MASTER_KEY_FILE });
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 16384) throw new Error('Secret excede o limite.'); chunks.push(chunk); }
  let value = Buffer.concat(chunks).toString('utf8');
  if (value.endsWith('\n')) value = value.slice(0, -1);
  const result = await provider.put({ scope, name, ...(tenantId ? { tenantId } : {}), value });
  value = '';
  process.stdout.write(`${result.secretRef}\n`);
})().catch(error => {
  process.stderr.write(`${error.code || 'SECRET_STORE_FAILED'}\n`);
  process.exitCode = 1;
});
