'use strict';

const assert = require('node:assert/strict');
const { createProviderWorker } = require('../backend/logistics/provider-worker');

async function exercise(classification, operation = 'DISPATCH_REQUEST') {
  const state = { finalStatus: null, errorClass: null, delay: null, committed: false, calls: 0, token: null };
  const command = { company_id:'00000000-0000-4000-8000-000000000001',command_id:'00000000-0000-4000-8000-000000000002',
    provider_id:'00000000-0000-4000-8000-000000000003',delivery_id:'00000000-0000-4000-8000-000000000004',
    fulfillment_id:'00000000-0000-4000-8000-000000000005',operation,idempotency_key:'stable-key',payload:{deliveryId:'00000000-0000-4000-8000-000000000004'},attempts:1,
    correlation_id:'00000000-0000-4000-8000-000000000006' };
  const client = { async query(sql, params = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') { if (sql === 'COMMIT') state.committed = true; return { rowCount:0,rows:[] }; }
    if (sql.includes("set_config('app.tenant_id'")) { assert.equal(params[0],command.company_id); return {rows:[{}]}; }
    if (sql.includes('logistics_providers')) return {rowCount:1,rows:[{code:'test_provider',capabilities:['quote','dispatch'],enabled:true,api_enabled:true}]};
    if (sql.includes("SELECT o.payload->>'externalId'")) return {rowCount:1,rows:[{external_order_id:null,order_source:'manual'}]};
    if (sql.includes('FROM rotamoto.provider_event_inbox')) return {rowCount:0,rows:[]};
    if (sql.includes('provider_command_outbox SET status=$4')) {
      assert.equal(params[2],state.token);state.finalStatus=params[3];state.delay=params[4];state.errorClass=params[5];return {rowCount:1,rows:[{command_id:command.command_id}]};
    }
    if (sql.includes('INSERT INTO rotamoto.audit_log')) return {rowCount:1,rows:[]};
    throw new Error(`unexpected query ${sql}`);
  },release(){} };
  const pool = { async query(sql,params) {
    assert.match(sql,/claim_provider_command/);state.token=params[1];
    return state.calls++===0?{rowCount:1,rows:[command]}:{rowCount:0,rows:[]};
  },async connect(){return client;} };
  const method = { QUOTE_REQUEST:'quote', DISPATCH_REQUEST:'dispatch', CANCEL_REQUEST:'cancel', TRACKING_REFRESH:'tracking', RECONCILE:'reconcile' }[operation];
  const adapter = { async [method]() { throw Object.assign(new Error('sanitized test failure'),{classification,retryAfterSeconds:3}); } };
  const worker=createProviderWorker({pool,adapterRegistry:{get:()=>adapter},credentialResolver:async()=>({clientId:'x',clientSecret:'y'}),
    tenantResolver:async()=>[command.company_id],logger:()=>{},clock:()=>10000,randomUUID:()=>`lease-${state.calls}`});
  await worker.runOnce();
  assert.equal(state.committed,true);
  return state;
}

(async()=>{
  const unknown=await exercise('UNKNOWN_OUTCOME');
  assert.equal(unknown.finalStatus,'unknown_outcome');
  assert.equal(unknown.errorClass,'UNKNOWN_OUTCOME');
  const rateLimit=await exercise('RATE_LIMIT','QUOTE_REQUEST');
  assert.equal(rateLimit.finalStatus,'queued');
  assert.equal(rateLimit.errorClass,'RATE_LIMIT');
  assert.equal(rateLimit.delay instanceof Date,true);
  process.stdout.write('Provider worker lease, ambiguous outcome and durable retry tests passed.\n');
})().catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
