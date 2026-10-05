'use strict';

const DEFAULT_GRACE_MS = 45 * 24 * 60 * 60 * 1000;

async function runProofMediaGc({ pool, objectStore, now = () => new Date(), graceMs = DEFAULT_GRACE_MS, dryRun = true, limit = 500, log = () => {} }) {
  if (!pool || typeof pool.connect !== 'function' || !objectStore || typeof objectStore.listProofObjects !== 'function' ||
      !Number.isSafeInteger(graceMs) || graceMs < 60_000 || typeof dryRun !== 'boolean') throw new TypeError('Parâmetros do coletor inválidos.');
  const cutoff = new Date(now().getTime() - graceMs);
  const candidates = await objectStore.listProofObjects({ olderThan: cutoff, limit });
  const result = { scanned: candidates.length, orphaned: 0, removed: 0, dryRun, skipped: 0 };
  for (const item of candidates) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [item.companyId]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`proof-media:${item.companyId}:${item.deliveryId}`]);
      const referenced = await client.query(`SELECT 1 FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type='DeliveryProof'
          AND payload->'media'->'storageRef'->>'provider'='filesystem-v1'
          AND payload->'media'->'storageRef'->>'objectKey'=$2 LIMIT 1`, [item.companyId, item.reference.objectKey]);
      const intent = await client.query(`SELECT 1 FROM rotamoto.proof_media_upload_intents
        WHERE company_id=$1 AND delivery_id=$2::uuid AND object_key=$3 LIMIT 1`, [item.companyId, item.deliveryId, item.reference.objectKey]);
      if (referenced.rowCount || intent.rowCount) { result.skipped++; await client.query('COMMIT'); continue; }
      result.orphaned++;
      if (!dryRun) { await objectStore.remove(item.reference); result.removed++; }
      await client.query('COMMIT');
      log({ event: dryRun ? 'proof_media_gc.candidate' : 'proof_media_gc.removed', tenantId: item.companyId, deliveryId: item.deliveryId, bytes: item.sizeBytes });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      result.skipped++;
      log({ event: 'proof_media_gc.error', code: /^[A-Z0-9_]{2,48}$/u.test(error.code || '') ? error.code : 'GC_ERROR' });
    } finally { client.release(); }
  }
  return Object.freeze(result);
}

module.exports = { runProofMediaGc, DEFAULT_GRACE_MS };
