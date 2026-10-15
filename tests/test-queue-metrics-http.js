'use strict';

const assert=require('node:assert/strict');
const {createQueueMetricsHttpHandler}=require('../backend/runtime/queue-metrics-http');
const {createQueueMetrics}=require('../backend/runtime/queue-metrics');

const tenant='11111111-1111-4111-8111-111111111111';
const appToken='A'.repeat(43);
const sql=[];
const client={async query(text,values){sql.push({text,values});if(text.includes('GROUP BY status'))return{rows:[
  {status:'queued',item_count:'2',oldest_pending_age_ms:'1500'},{status:'leased',item_count:'1',oldest_pending_age_ms:'0'},
  {status:'unknown_outcome',item_count:'1',oldest_pending_age_ms:'0'}]};
  if(text.includes('AS retries'))return{rows:[{retries:'3',expired_leases:'1',processing_ms_p95:'240'}]};return{rows:[]}}};
const metrics=createQueueMetrics({pool:{connect:async()=>client},tenantResolver:async()=>[],clock:()=>1700000000000});
const identityService={async withAuthenticatedTenant(token,operation,permission){assert.equal(permission,'company.manage');assert.equal(token,appToken);return operation(client,{company_id:tenant})}};
function request({cookie=null,method='GET',path='/api/ops/queues'}={}){return{method,url:path,headers:{...(cookie?{cookie}:{})},clientIp:'127.0.0.1',requestId:'22222222-2222-4222-8222-222222222222'}};
function response(){return{statusCode:200,headers:null,body:null,writeHead(status,headers){this.statusCode=status;this.headers=headers},end(text){this.body=JSON.parse(text)}}}

(async()=>{
  const handler=createQueueMetricsHttpHandler({identityService,metrics});
  let res=response();assert.equal(await handler(request(),res),true);assert.equal(res.statusCode,401);
  res=response();await handler(request({cookie:`__Host-rotamoto_session=${appToken}`} ),res);
  assert.equal(res.statusCode,200);assert.equal(res.body.metrics.tenantCount,1);
  assert.equal(res.body.metrics.queues[0].retries,3);assert.equal(res.body.metrics.queues[0].expiredLeases,1);
  assert.equal(res.body.metrics.queues[0].processingMsP95,240);assert.equal(res.body.metrics.queues[0].workerAvailability,'unknown');
  assert.equal(JSON.stringify(res.body).includes(tenant),false);assert.equal(JSON.stringify(res.body).includes('commandId'),false);
  assert(sql.every(row=>row.values?.[0]===tenant));assert(sql.some(row=>row.text.includes('BEGIN')===false));
  res=response();await handler(request({method:'POST',cookie:`__Host-rotamoto_session=${appToken}`} ),res);assert.equal(res.statusCode,405);
  const deniedHandler=createQueueMetricsHttpHandler({identityService:{withAuthenticatedTenant:async()=>{throw Object.assign(new Error('denied'),{code:'FORBIDDEN'})}},metrics});
  res=response();await deniedHandler(request({cookie:`__Host-rotamoto_session=${appToken}`} ),res);assert.equal(res.statusCode,403);
  console.log('queue metrics HTTP auth, tenant privacy, fixed labels and read-only aggregates: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
