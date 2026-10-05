'use strict';
const { Pool } = require('pg');
const { loadRuntimeConfig } = require('../backend/runtime/config');
const { createFilesystemObjectStore } = require('../backend/domain/filesystem-object-store');
const { runProofMediaGc, DEFAULT_GRACE_MS } = require('../backend/domain/proof-media-gc');

(async () => {
  const config = loadRuntimeConfig(), apply = process.argv.includes('--apply');
  if (!config.mediaDirectory) throw new Error('Filesystem media não configurado.');
  const days = Number(process.env.ROTAMOTO_MEDIA_GC_GRACE_DAYS || DEFAULT_GRACE_MS / 86_400_000);
  if (!Number.isInteger(days) || days < 45 || days > 3650) throw new Error('Grace period deve ficar entre 45 e 3650 dias.');
  const pool = new Pool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
  try {
    const objectStore = await createFilesystemObjectStore({ directory: config.mediaDirectory });
    const result = await runProofMediaGc({ pool, objectStore, graceMs: days * 86_400_000, dryRun: !apply,
      log: entry => process.stdout.write(`${JSON.stringify({ ...entry, tenantId: undefined, deliveryId: undefined })}\n`) });
    process.stdout.write(`${JSON.stringify({ event: 'proof_media_gc.complete', ...result })}\n`);
  } finally { await pool.end(); }
})().catch(error => { process.stderr.write(`${JSON.stringify({ event: 'proof_media_gc.failed', code: /^[A-Z0-9_]{2,48}$/u.test(error.code || '') ? error.code : 'GC_FAILED' })}\n`); process.exitCode = 1; });
