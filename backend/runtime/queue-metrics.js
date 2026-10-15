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
    const aggregate = new Map(QUEUES.map(queue => [queue.name, {
      queue: queue.name, pending: 0, leased: 0, succeeded: 0, failed: 0, unknown: 0, oldestPendingAgeMs: 0
    }]));
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

  return Object.freeze({ snapshot });
}

module.exports = { createQueueMetrics, QUEUES };
