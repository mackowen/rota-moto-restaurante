'use strict';

const assert = require('node:assert/strict');
const { createWorkerMetrics } = require('../backend/runtime/worker-metrics');

let now = 1000;
const metrics = createWorkerMetrics({ now: () => now });
metrics.record({ worker: 'marketplace', outcome: 'work', durationMs: 8 });
metrics.record({ worker: 'logistics', outcome: 'idle', durationMs: 52 });
metrics.record({ worker: 'tenant-123/order-456', outcome: 'oops', durationMs: 1500 });
now += 4000;
const snapshot = metrics.snapshot();
assert.equal(snapshot.uptimeSeconds, 4);
assert.deepEqual(snapshot.series.map(row => [row.worker, row.outcome, row.runs]), [
  ['logistics', 'idle', 1], ['marketplace', 'work', 1], ['other', 'error', 1]
]);
assert.equal(snapshot.series[0].buckets.le_100, 1);
assert.equal(snapshot.series[2].buckets.gt_1000, 1);
assert.equal(JSON.stringify(snapshot).includes('tenant-123'), false);
assert.equal(JSON.stringify(snapshot).includes('order-456'), false);
console.log('bounded worker metrics and cardinality privacy: PASS');
