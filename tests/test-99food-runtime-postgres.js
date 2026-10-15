'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createPool}=require('../backend/postgres/connection');
const {e2eMigrationConnectionString}=require('../backend/postgres/migrate');
const {createMarketplaceRuntime}=require('../backend/integrations/marketplace-runtime');
const {createMarketplaceWorker}=require('../backend/integrations/marketplace-worker');
const {createFixtureManifest}=require('./e2e-support/fixture-manifest');

const id=()=>crypto.randomUUID();
const secret=crypto.randomBytes(32).toString('hex');
function webhook(shop,orderId,type='orderNew',timestamp=Math.floor(Date.now()/1000)){
  const rawBody=Buffer.from(JSON.stringify({app_id:123456,app_shop_id:shop,timestamp,type,data:{order_id:orderId}}));
  const signature=crypto.createHash('md5').update(Buffer.concat([rawBody,Buffer.from(secret)])).digest('hex');
  return {rawBody,signature};
}

async function main(){
  const a={company:id(),integration:id(),account:id(),shop:`shop-${id()}`};
  const b={company:id(),integration:id(),account:id(),shop:`shop-${id()}`};
  const manifest=await createFixtureManifest({campaign:'0153',evidence:[{kind:'test',name:'99food-runtime-postgres'}]});
  await manifest.update({status:'RUNNING',tenants:[{id:a.company,counts:{companies:1,integrations:1,accounts:1}},{id:b.company,counts:{companies:1,integrations:1,accounts:1}}],
    records:{companies:[a.company,b.company],integrations:[a.integration,b.integration],accounts:[a.account,b.account],shops:[a.shop,b.shop]}});
  const migrator=createPool({connectionString:e2eMigrationConnectionString(process.env),max:1,application_name:'99food-runtime-e2e-inspect'});
  const app=createPool({connectionString:process.env.E2E_RUNTIME_DATABASE_URL||'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',max:2,application_name:'99food-runtime-e2e'});
  const workerUrl=process.env.E2E_PROVIDER_WORKER_DATABASE_URL;
  assert(workerUrl,'E2E provider worker role URL is required.');
  const workerA=createPool({connectionString:workerUrl,max:1,application_name:'99food-runtime-worker-a'});
  const workerB=createPool({connectionString:workerUrl,max:1,application_name:'99food-runtime-worker-b'});
  async function readTenant(company,sql,values){await migrator.query('BEGIN READ ONLY');try{await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[company]);return await migrator.query(sql,values);}finally{await migrator.query('ROLLBACK');}}
  let passed=false,seeded=false,orderCalls=0,commandCalls=0,statusByOrder=new Map();
  const accountFor=shop=>{const row=[a,b].find(item=>item.shop===shop);return row?{
    id:row.account,companyId:row.company,integrationId:row.integration,provider:'99food',merchantId:row.shop,status:'active',authorized:true,
    webhookSecret:secret,credentials:{appId:'123456',appSecret:secret,appShopId:row.shop,authToken:'synthetic-token',tokenExpiresAt:Date.now()+3_600_000}
  }:null;};
  const accountResolver={async byId(provider,accountId,companyId){const row=[a,b].find(item=>item.account===accountId&&item.company===companyId);return row?accountFor(row.shop):null;},
    async byMerchant(provider,shop){return accountFor(shop);}};
  const adapter={async order({id:externalId,credentials}){orderCalls++;const shop=credentials.appShopId;
    return {provider:'99food',externalId:externalId,externalDisplayId:`99-${externalId}`,status:statusByOrder.get(externalId)||'placed',providerStatus:statusByOrder.get(externalId)==='cancelled'?901:200,
      createdAt:new Date().toISOString(),orderType:'delivery',fulfillment:'platform',deliveryType:1,fulfillmentMode:0,
      money:{currency:'BRL',completeness:'partial',provenance:{kind:'external',sourceId:'99food'},components:{totalMinor:1290}},
      priceBreakdown:{order_price:1290,customer_need_paying_money:1290,shop_paid_money:1290},payment:{payType:2,payChannel:153,payMethod:2},
      items:[{name:'Synthetic item',quantity:1,unitPriceMinor:1290,lineTotalMinor:1290,providerItemId:'synthetic-sku',options:[],promotionSummary:[],promotions:[]}],shop};
  },async command(){commandCalls++;return {errno:0,errmsg:'ok',data:true};}};
  const runtime=createMarketplaceRuntime({pool:app,adapters:{'99food':adapter},accountResolver,clock:()=>Date.now(),logger:()=>{}});
  try{
    for(const row of [a,b]){
      await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
      await migrator.query('INSERT INTO rotamoto.companies(id,name,status) VALUES($1,$2,\'active\')',[row.company,`Synthetic 99Food ${row.company.slice(0,8)}`]);
      await migrator.query("INSERT INTO rotamoto.integrations(id,company_id,provider,status) VALUES($1,$2,'99food','active')",[row.integration,row.company]);
      await migrator.query(`INSERT INTO rotamoto.external_accounts(id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,account_status)
        VALUES($1,$2,$3,$4,'Synthetic 99Food store','confirmed',now(),'active')`,[row.account,row.company,row.integration,row.shop]);
      await migrator.query(`INSERT INTO rotamoto.marketplace_account_bindings(company_id,integration_id,external_account_id,provider,merchant_id,authorized)
        VALUES($1,$2,$3,'99food',$4,true)`,[row.company,row.integration,row.account,row.shop]);
      await migrator.query('COMMIT');
    }
    seeded=true;
    const eventId=`order-${id()}`,orderId=`${Date.now()}${Math.floor(Math.random()*100000)}`;
    statusByOrder.set(orderId,'placed');
    const first=webhook(a.shop,orderId);
    assert.deepEqual(await runtime.ingest({provider:'99food',...first}),{duplicate:false,processed:true},'valid signed webhook is durably consumed and normalized through the PostgreSQL runtime');
    assert.deepEqual(await runtime.ingest({provider:'99food',...first}),{duplicate:true,processed:true},'replay deduplicates the event and does not fetch detail again');
    assert.equal(orderCalls,1);
    await assert.rejects(runtime.ingest({provider:'99food',rawBody:first.rawBody,signature:'0'.repeat(32)}),error=>error.code==='INVALID_SIGNATURE');
    const versions=await readTenant(a.company,`SELECT v.domain_order_id::text,d.payload FROM rotamoto.marketplace_order_versions v
      JOIN rotamoto.domain_records d ON d.company_id=v.company_id AND d.record_id=v.domain_order_id
      WHERE v.company_id=$1 AND v.external_order_id=$2`,[a.company,orderId]);
    assert.equal(versions.rowCount,1);assert.equal(versions.rows[0].payload.source,'99food');
    assert.equal(versions.rows[0].payload.extensions.x_rotamoto_external_order.fulfillment,'platform');
    assert.equal(versions.rows[0].payload.extensions.x_rotamoto_external_order.priceBreakdown.order_price,1290);
    assert.equal(versions.rows[0].payload.items[0].providerItemId,'synthetic-sku');
    assert.equal(Object.hasOwn(versions.rows[0].payload,'delivery'),false);
    const outbox=await readTenant(a.company,`SELECT count(*)::int AS count, max(app_key) AS app FROM rotamoto.sync_outbox
      WHERE company_id=$1 AND payload->>'entity'='Order' AND payload->>'entityId'=$2`,[a.company,versions.rows[0].domain_order_id]);
    assert.deepEqual(outbox.rows[0],{count:1,app:'restaurante'},'canonical Order appears exactly once in the normal sync outbox');
    const inbox=await readTenant(a.company,`SELECT count(*)::int AS count,bool_and(event_data ? 'status') AS normalized,
      bool_and(NOT (event_data ? 'rawBody')) AS no_raw_body FROM rotamoto.marketplace_event_inbox WHERE company_id=$1`,[a.company]);
    assert.deepEqual(inbox.rows[0],{count:1,normalized:true,no_raw_body:true},'inbox stores normalized metadata, not raw body or credentials');
    assert.equal((await runtime.listOrders(a.company)).length,1);
    assert.deepEqual(await runtime.listOrders(b.company),[],'account and order resolution remain tenant scoped');
    await assert.rejects(runtime.enqueueOrderCommand({companyId:a.company,domainOrderId:versions.rows[0].domain_order_id,operation:'DELIVERED',idempotencyKey:`wrong-${id()}`,commandData:{}}),
      error=>error.code==='FULFILLMENT_MISMATCH','platform fulfillment cannot use store-delivery completion or create a Delivery');
    const cashCommand=await runtime.enqueueOrderCommand({companyId:a.company,domainOrderId:versions.rows[0].domain_order_id,
      operation:'CONFIRM_CASH_PAYMENT',idempotencyKey:`cash-${id()}`,commandData:{}});
    const workerAccount=async(provider,accountId,companyId)=>accountResolver.byId(provider,accountId,companyId);
    workerAccount.byMerchant=(provider,merchantId)=>accountResolver.byMerchant(provider,merchantId);
    const worker=createMarketplaceWorker({pool:workerA,companyIds:[a.company],adapters:{'99food':adapter},accountResolver:workerAccount,
      clock:()=>Date.now(),random:()=>0});
    assert.equal(await worker.runOnce(),true,'the dedicated 99Food worker claims and executes a documented payment command');
    assert.deepEqual(worker.metrics().series.map(row=>[row.worker,row.outcome,row.runs]),[['marketplace','work',1]],'real dedicated PostgreSQL worker exposes only bounded aggregate metrics');
    assert.equal(commandCalls,1);
    const cashState=await readTenant(a.company,'SELECT status FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND command_id=$2',[a.company,cashCommand.command_id]);
    assert.equal(cashState.rows[0]?.status,'succeeded','provider success settles the cash confirmation command');

    const applyId=`apply-${id()}`,applyBody=Buffer.from(JSON.stringify({app_id:123456,app_shop_id:a.shop,timestamp:Math.floor(Date.now()/1000)+2,
      type:'orderCancelApply',data:{order_id:orderId,apply_id:applyId,apply_reason:'not stored',reason_list:[{reason:'preparing'}],images:['https://example.invalid/evidence.jpg']}}));
    const applySignature=crypto.createHash('md5').update(Buffer.concat([applyBody,Buffer.from(secret)])).digest('hex');
    await runtime.ingest({provider:'99food',rawBody:applyBody,signature:applySignature});
    const applicationOrder=(await runtime.listOrders(a.company)).find(order=>order.externalOrderId===orderId);
    assert.equal(applicationOrder.latestEventType,'orderCancelApply');
    assert.deepEqual(applicationOrder.application,{id:applyId,reasons:[{id:'preparing',label:'preparing'}]},'the operations UI receives only the bounded response data needed for this customer cancellation request');
    const applicationCommand=await runtime.enqueueOrderCommand({companyId:a.company,domainOrderId:versions.rows[0].domain_order_id,
      operation:'CANCEL_REQUEST',idempotencyKey:`cancel-apply-${id()}`,commandData:{applyId,agree:false,reason:'preparing'}});
    assert.equal(applicationCommand.duplicate,false,'documented cancellation application can be durably answered once');

    const pendingId=`queued-${id()}`,queuedBody=webhook(a.shop,pendingId,'orderNew',Math.floor(Date.now()/1000)+1);
    const queued=await runtime.ingest({provider:'99food',...queuedBody,deferProcessing:true});
    assert.deepEqual(queued,{duplicate:false,processed:false,queued:true},'webhook ACK path requires durable inbox before async work');
    const claimA=id(),claimB=id();
    const claims=await Promise.all([
      workerA.query('SELECT * FROM rotamoto.claim_marketplace_event($1,$2,$3)',[a.company,claimA,90]),
      workerB.query('SELECT * FROM rotamoto.claim_marketplace_event($1,$2,$3)',[a.company,claimB,90])
    ]);
    const acquired=claims.flatMap(result=>result.rows);
    assert.equal(acquired.length,1,'concurrent claims produce one active event lease');
    await runtime.processClaimed(accountFor(a.shop),acquired[0].external_event_id,claims[0].rows.length?claimA:claimB);
    const queuedState=await readTenant(a.company,'SELECT status FROM rotamoto.marketplace_event_inbox WHERE company_id=$1 AND external_event_id=$2',[a.company,`99f:${crypto.createHash('sha256').update(queuedBody.rawBody).digest('hex')}`]);
    assert.equal(queuedState.rows[0]?.status,'processed','the claimed event resumes safely and reaches canonical projection');
    const delivered=await readTenant(a.company,`SELECT count(*)::int AS count FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Delivery'
      AND related_record_id=$2 AND deleted_at IS NULL`,[a.company,versions.rows[0].domain_order_id]);
    assert.equal(delivered.rows[0].count,0,'platform delivery never creates an operational Delivery');
    await manifest.update({databaseCommitted:true,counts:{companies:2,integrations:2,accounts:2,domain_orders:2,inbox_events:2,sync_outbox:2,audit_log:'retained-or-not-applicable'}});
    passed=true;
    process.stdout.write('99Food runtime PostgreSQL E2E: PASS (signature, tenant lookup, inbox replay, full-order normalization, outbox, fulfillment boundary, concurrent lease, deferred processing)\n');
  }finally{
    await app.end();await workerA.end();await workerB.end();await migrator.end();
    await manifest.update({status:passed?'RETAINED':'FAILED',databaseCommitted:seeded,
      retentionReason:'Synthetic 99Food E2E rows are retained and inventoried for this campaign; no cleanup was attempted.',
      lastError:passed?undefined:{message:'99Food PostgreSQL E2E did not complete.'}});
  }
}

main().catch(error=>{process.stderr.write(`99Food runtime PostgreSQL E2E: FAIL (${error.stack||error.message})\n`);process.exitCode=1;});
