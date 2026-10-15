'use strict';

const assert = require('node:assert/strict');
const { createWorkerMetrics } = require('../backend/runtime/worker-metrics');
const { createQueueMetrics } = require('../backend/runtime/queue-metrics');

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
const companyA='11111111-1111-4111-8111-111111111111', companyB='22222222-2222-4222-8222-222222222222';
const sql=[];
const fakePool={async connect(){return {async query(text,values){sql.push({text,values});if(text.includes('GROUP BY status'))return {rows:[
  {status:'queued',item_count:'2',oldest_pending_age_ms:'1500'},{status:'leased',item_count:'1',oldest_pending_age_ms:'900'},
  {status:'succeeded',item_count:'8',oldest_pending_age_ms:'0'}]};return {rows:[]}},release(){}}}};
(async()=>{
  const queues=await createQueueMetrics({pool:fakePool,tenantResolver:async()=>[companyA,companyB],clock:()=>1700000000000}).snapshot();
  assert.equal(queues.tenantCount,2);
  assert.deepEqual(queues.queues.map(row=>[row.queue,row.pending,row.leased,row.succeeded,row.oldestPendingAgeMs]),[
    ['provider_commands',4,2,16,1500],['marketplace_commands',4,2,16,1500]
  ]);
  assert.equal(JSON.stringify(queues).includes(companyA),false);
  assert.equal(JSON.stringify(queues).includes(companyB),false);
  assert.equal(sql.filter(row=>row.text==='BEGIN READ ONLY').length,2);
  assert.equal(sql.filter(row=>row.text.includes('set_config')).length,2);
  await assert.rejects(createQueueMetrics({pool:fakePool,tenantResolver:async()=>['tenant-raw']}).snapshot(),/tenant scope/);
  console.log('tenant-scoped queue metrics, fixed labels, read-only transactions and privacy: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
console.log('bounded worker metrics and cardinality privacy: PASS');
