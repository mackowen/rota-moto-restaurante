'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const QUEUES = Object.freeze([
  Object.freeze({ name: 'provider_commands', table: 'provider_command_outbox', pending: ['queued'], leased: ['leased'], succeeded: ['succeeded'], failed: ['rejected', 'needs_review'], unknown: ['unknown_outcome'] }),
  Object.freeze({ name: 'marketplace_commands', table: 'marketplace_command_outbox', pending: ['queued', 'pending'], leased: ['leased'], succeeded: ['succeeded'], failed: ['rejected', 'needs_review'], unknown: ['unknown_outcome'] })
]);

function createQueueMetrics({ pool, tenantResolver, clock = () => Date.now(), maxTenants = 1000 } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof tenantResolver !== 'function')
    throw new TypeError('Queue metrics require a pool and tenant resolver.');

  async function snapshot() {
    const resolved = await tenantResolver();
    if (!Array.isArray(resolved) || resolved.length > maxTenants || resolved.some(id => typeof id !== 'string' || !UUID.test(id)))
      throw new TypeError('Queue metrics tenant scope is invalid.');
    const tenants = [...new Set(resolved)];
    const aggregate = new Map(QUEUES.map(queue => [queue.name, emptyQueue(queue.name)]));
    for (const companyId of tenants) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
        for (const queue of QUEUES) {
          const query = await client.query(`SELECT status,COUNT(*)::bigint AS item_count,
              COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-MIN(created_at) FILTER (WHERE status=ANY($2::text[]))))*1000,0)::bigint AS oldest_pending_age_ms
            FROM rotamoto.${queue.table} WHERE company_id=$1 GROUP BY status`,
          [companyId, queue.pending]);
          const target = aggregate.get(queue.name);
          for (const row of query.rows) {
            const count = Number(row.item_count);
            if (!Number.isSafeInteger(count) || count < 0) throw new Error('QUEUE_METRICS_COUNT_INVALID');
            const category = Object.keys(target).find(key => key !== 'queue' && key !== 'oldestPendingAgeMs' && queue[key]?.includes(row.status));
            if (category) target[category] += count;
            if ([...queue.pending, ...queue.leased].includes(row.status))
              target.oldestPendingAgeMs = Math.max(target.oldestPendingAgeMs, Number(row.oldest_pending_age_ms) || 0);
          }
          applyOperationalMetrics(target, await readOperationalMetrics(client, queue, companyId));
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    }
    return Object.freeze({ observedAt: new Date(clock()).toISOString(), tenantCount: tenants.length,
      queues: Object.freeze([...aggregate.values()].map(row => Object.freeze({ ...row }))) });
  }

  async function snapshotForTenant(client, companyId) {
    if (!client || typeof client.query !== 'function' || typeof companyId !== 'string' || !UUID.test(companyId))
      throw new TypeError('Queue metrics tenant scope is invalid.');
    const queues = [];
    for (const queue of QUEUES) {
      const base = emptyQueue(queue.name);
      const grouped = await client.query(`SELECT status,COUNT(*)::bigint AS item_count,
          COALESCE(EXTRACT(EPOCH FROM (clock_timestamp()-MIN(created_at) FILTER (WHERE status=ANY($2::text[]))))*1000,0)::bigint AS oldest_pending_age_ms
        FROM rotamoto.${queue.table} WHERE company_id=$1 GROUP BY status`, [companyId, queue.pending]);
      for (const row of grouped.rows) {
        const count=Number(row.item_count);
        if(!Number.isSafeInteger(count)||count<0)throw new Error('QUEUE_METRICS_COUNT_INVALID');
        const category=Object.keys(base).find(key=>key!=='queue'&&key!=='oldestPendingAgeMs'&&key!=='retries'&&key!=='expiredLeases'&&key!=='processingMsP95'&&key!=='workerAvailability'&&queue[key]?.includes(row.status));
        if(category)base[category]+=count;
        if(queue.pending.includes(row.status))base.oldestPendingAgeMs=Math.max(base.oldestPendingAgeMs,Number(row.oldest_pending_age_ms)||0);
      }
      applyOperationalMetrics(base, await readOperationalMetrics(client, queue, companyId));
      queues.push(Object.freeze(base));
    }
    return Object.freeze({ observedAt:new Date(clock()).toISOString(), tenantCount:1, queues:Object.freeze(queues) });
  }

  return Object.freeze({ snapshot, snapshotForTenant });
}

function emptyQueue(name) {
  return { queue:name,pending:0,leased:0,succeeded:0,failed:0,unknown:0,oldestPendingAgeMs:0,
    retries:0,expiredLeases:0,processingMsP95:0,workerAvailability:'unknown' };
}

async function readOperationalMetrics(client, queue, companyId) {
  const result=await client.query(`SELECT
      COUNT(*) FILTER(WHERE attempts>1)::bigint AS retries,
      COUNT(*) FILTER(WHERE status='leased' AND lease_until<clock_timestamp())::bigint AS expired_leases,
      COALESCE(percentile_cont(0.95) WITHIN GROUP(ORDER BY EXTRACT(EPOCH FROM(completed_at-created_at))*1000)
        FILTER(WHERE completed_at IS NOT NULL),0)::bigint AS processing_ms_p95
    FROM rotamoto.${queue.table} WHERE company_id=$1`,[companyId]);
  const row=result.rows[0]||{};
  return {retries:Number(row.retries)||0,expiredLeases:Number(row.expired_leases)||0,processingMsP95:Number(row.processing_ms_p95)||0};
}

function applyOperationalMetrics(target, values) {
  for(const key of ['retries','expiredLeases','processingMsP95']){
    const value=Number(values[key]||0);
    if(!Number.isSafeInteger(value)||value<0)throw new Error('QUEUE_METRICS_VALUE_INVALID');
    target[key]=value;
  }
  // Queue leases are evidence of in-flight claims, not proof that a worker process is alive.
  target.workerAvailability='unknown';
}

module.exports = { createQueueMetrics, QUEUES };
