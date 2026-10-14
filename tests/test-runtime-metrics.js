'use strict';

const assert = require('node:assert/strict');
const { createRuntimeMetrics, sanitizeLogPath } = require('../backend/runtime/metrics');

let time = 1_000;
const metrics = createRuntimeMetrics({ now: () => time });
metrics.record({ method: 'POST', category: 'sync', status: 503, durationMs: 41 });
metrics.record({ method: 'GET', category: 'api', status: 200, durationMs: 8 });
metrics.record({ method: 'GET', category: 'health', status: 200, durationMs: 1 });
time += 5_000;

const snapshot = metrics.snapshot();
assert.equal(snapshot.uptimeSeconds, 5);
assert.deepEqual(snapshot.series.map(row => [row.method, row.category, row.statusClass, row.requests]), [
  ['GET', 'api', '2xx', 1], ['POST', 'sync', '5xx', 1]
], 'health probes are excluded and metrics use bounded categories without paths or tenant labels');
assert.equal(snapshot.series[0].durationMs.buckets.le_10ms, 1);
assert.equal(snapshot.series[1].durationMs.buckets.le_50ms, 1);
assert.equal(JSON.stringify(snapshot).includes('companyId'), false);
assert.equal(JSON.stringify(snapshot).includes('/api/orders/'), false);
assert.equal(sanitizeLogPath('/api/domain/deliveries/7f8e7d6c-5b4a-4321-9876-123456789abc/proofs?token=private'),
  '/api/domain/deliveries/:id/proofs', 'request logs drop query strings and mask record identifiers');
console.log('bounded runtime metrics and privacy contract: PASS');
