'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPool } = require('../backend/postgres/connection');
const { createMarketplaceRuntime, canonicalOrder } = require('../backend/integrations/marketplace-runtime');
const { e2eMigrationConnectionString } = require('../backend/postgres/migrate');
const { createFixtureManifest } = require('./e2e-support/fixture-manifest');

function id() { return crypto.randomUUID(); }

for (const [providerStatus, localStatus] of [['CANCELLED','CANCELADA'],['CANCELED','CANCELADA'],['DELIVERED','FINALIZADA'],
  ['COMPLETED','FINALIZADA'],['DISPATCHED','EM ROTA'],['OUT_FOR_DELIVERY','EM ROTA'],['ARRIVED','CHEGOU'],['PLACED','AGUARDANDO']]) {
  const projected = canonicalOrder('ifood',{externalId:'external-1',externalDisplayId:'F-1',status:providerStatus},
    {id:id(),companyId:id()});
  assert.equal(projected.status,localStatus,`external ${providerStatus} maps to local Order status ${localStatus}`);
  assert.equal(projected.extensions.x_rotamoto_external_order.providerStatus,providerStatus);
  assert.equal(projected.extensions.x_rotamoto_external_order.fulfillment,'unknown');
}

async function main() {
  const a = { company: id(), integration: id(), account: id(), merchant: id(), externalAccountId: id(), secret: 'synthetic-marketplace-webhook-secret' };
  const b = { company: id(), integration: id(), account: id(), merchant: id(), externalAccountId: id(), secret: 'synthetic-other-tenant-secret' };
  const fixture = await createFixtureManifest({ campaign: '0153', evidence: [{ kind: 'test', name: 'marketplace-runtime-postgres' }] });
  await fixture.update({ status: 'RUNNING', tenants: [{ id: a.company, counts: { companies: 1, integrations: 1, accounts: 1 } },
    { id: b.company, counts: { companies: 1, integrations: 1, accounts: 1 } }], records: {
    companies: [a.company,b.company], integrations: [a.integration,b.integration], accounts: [a.account,b.account],
    externalAccountIds: [a.externalAccountId,b.externalAccountId], merchants: [a.merchant,b.merchant] } });
  const migrator = createPool({ connectionString: e2eMigrationConnectionString(process.env), max: 1, application_name: 'marketplace-e2e-seed' });
  const app = createPool({ connectionString: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e', max: 2, application_name: 'marketplace-e2e-runtime' });
  let passed = false;
  try {
    for (const row of [a,b]) {
      await migrator.query('BEGIN');
      await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
      await migrator.query('INSERT INTO rotamoto.companies(id,name,status) VALUES($1,$2,\'active\')', [row.company, `Marketplace ${row.company.slice(0,8)}`]);
      await migrator.query("INSERT INTO rotamoto.integrations(id,company_id,provider,status) VALUES($1,$2,'ifood','active')", [row.integration,row.company]);
      await migrator.query(`INSERT INTO rotamoto.external_accounts(id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,account_status)
        VALUES($1,$2,$3,$4,'Synthetic merchant','confirmed',now(),'active')`, [row.account,row.company,row.integration,row.externalAccountId]);
      await migrator.query(`INSERT INTO rotamoto.marketplace_account_bindings(company_id,integration_id,external_account_id,provider,merchant_id,authorized)
        VALUES($1,$2,$3,'ifood',$4,true)`, [row.company,row.integration,row.account,row.merchant]);
      await migrator.query('COMMIT');
    }
    const orderId = id(); const eventId = `evt-${id()}`; const eventTime = new Date().toISOString();
    const raw = Buffer.from(JSON.stringify({ id:eventId, orderId, merchantId:a.merchant, fullCode:'PLACED', code:'PLACED', createdAt:eventTime }));
    const signature = crypto.createHmac('sha256',a.secret).update(raw).digest('hex');
    let detailRequests = 0, acknowledgments = 0, providerDetailGate = null;
    const providerOrderStates = new Map([[orderId, 'PLACED']]);
    const runtime = createMarketplaceRuntime({ pool: app,
      accountResolver: {
        async byId(provider, accountId) {
          const row = [a,b].find(item => item.account === accountId);
          return row ? { provider,id:row.account,integrationId:row.integration,companyId:row.company,merchantId:row.merchant,
            status:'active',authorized:true,webhookSecret:row.secret,credentials:{ accessToken:'synthetic' } } : null;
        },
        async byMerchant(provider, merchant) {
          const row = [a,b].find(item => item.merchant === merchant);
          return row ? { provider,id:row.account,integrationId:row.integration,companyId:row.company,merchantId:row.merchant,
            status:'active',authorized:true,webhookSecret:row.secret,credentials:{ accessToken:'synthetic' } } : null;
        }
      },
      adapters:{ ifood:{ async order({orderId: requestedOrderId}){ detailRequests++; if(providerDetailGate&&providerDetailGate.orderId===requestedOrderId){providerDetailGate.started();await providerDetailGate.promise;} return { source:'ifood',externalId:requestedOrderId,externalDisplayId:'S-1',status:providerOrderStates.get(requestedOrderId)||'PLACED',orderType:'DELIVERY',createdAt:eventTime,
        customer:{ name:'Synthetic customer',phone:'+550000000000' },address:'Rua Synthetic, 1',items:[{name:'Synthetic item',quantity:1}] }; },
        async pollEvents(){ return [{id:eventId,orderId,merchantId:a.merchant,fullCode:'PLACED',createdAt:eventTime}]; }, async acknowledgeEvents(){ acknowledgments++; return {acknowledged:true,confirmation:'pending'}; } } },
      logger:()=>{}
    });
    const result = await runtime.ingest({provider:'ifood',accountId:a.account,rawBody:raw,signature});
    assert.deepEqual(result,{duplicate:false,processed:true});
    assert.equal(detailRequests,1);
    await migrator.query('BEGIN'); await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[a.company]);
    const immediate = await migrator.query('SELECT status,last_error_code FROM rotamoto.marketplace_event_inbox WHERE company_id=$1 AND external_event_id=$2',[a.company,eventId]);
    assert.equal(immediate.rows[0]?.status,'processed',`Inbox state: ${JSON.stringify(immediate.rows[0])}`);
    const duplicate = await runtime.ingest({provider:'ifood',accountId:a.account,rawBody:raw,signature});
    assert.equal(duplicate.duplicate,true);
    const concurrentReplay=await Promise.all([1,2].map(()=>runtime.ingest({provider:'ifood',accountId:a.account,rawBody:raw,signature})));
    assert.deepEqual(concurrentReplay.map(item=>item.duplicate),[true,true],
      'concurrent replay of one provider event remains idempotent after its original commit');
    assert.equal(detailRequests,1,'duplicate webhook concurrency does not fetch or project the provider Order again');
    const duplicateOutbox = await migrator.query(`SELECT count(*)::int AS count FROM rotamoto.sync_outbox
      WHERE company_id=$1 AND payload->>'entity'='Order' AND payload->>'entityId'=(
        SELECT domain_order_id::text FROM rotamoto.marketplace_order_versions WHERE company_id=$1 AND external_order_id=$2)`,[a.company,orderId]);
    assert.equal(duplicateOutbox.rows[0].count,1,'webhook replay does not duplicate canonical outbox publication');
    await runtime.ingestPolled({provider:'ifood',id:a.account,companyId:a.company,integrationId:a.integration,merchantId:a.merchant,
      status:'active',authorized:true,credentials:{accessToken:'synthetic'}}, [{id:eventId,orderId,merchantId:a.merchant,fullCode:'PLACED',createdAt:eventTime}]);
    assert.equal(acknowledgments,1,'poll event is acked only after durable processing; duplicate webhook/poll converges on same inbox key');
    const version = await migrator.query('SELECT domain_order_id FROM rotamoto.marketplace_order_versions WHERE company_id=$1 AND external_order_id=$2',[a.company,orderId]);
    assert.equal(version.rowCount,1,'processed event must link one canonical Order');
    const domain = await migrator.query('SELECT company_id,entity_type,payload FROM rotamoto.domain_records WHERE record_id=$1', [version.rows[0].domain_order_id]);
    assert.equal(domain.rows[0].company_id,a.company,'tenant comes from the trusted account resolver');
    assert.equal(domain.rows[0].entity_type,'Order');
    assert.equal(domain.rows[0].payload.source,'ifood');
    assert.equal(domain.rows[0].payload.id,version.rows[0].domain_order_id,'canonical Order has the identity required by sync v1');
    assert.equal(domain.rows[0].payload.companyId,a.company);
    assert.equal(domain.rows[0].payload.version,1);
    assert.equal(domain.rows[0].payload.number,'S-1');
    assert.equal(domain.rows[0].payload.customer,'Pedido externo','provider PII is not copied into the local projection');
    assert.deepEqual(domain.rows[0].payload.extensions.x_rotamoto_external_order,
      {providerStatus:'PLACED',displayId:'S-1',orderType:'DELIVERY',fulfillment:'unknown'});
    assert.equal(Object.hasOwn(domain.rows[0].payload,'address'),false,'delivery address is not retained without a domain need');
    const published = await migrator.query(`SELECT o.payload,i.app_key,o.recipient_driver_id
      FROM rotamoto.sync_outbox o JOIN rotamoto.sync_installations i ON i.id=o.installation_id
      WHERE o.company_id=$1 AND o.payload->>'entity'='Order' AND o.payload->>'entityId'=$2`,[a.company,version.rows[0].domain_order_id]);
    assert.equal(published.rowCount,1,'external canonical Order is published to the ordinary sync outbox exactly once');
    assert.equal(published.rows[0].app_key,'restaurante');
    assert.equal(published.rows[0].recipient_driver_id,null,'external order is not assigned to a driver');
    assert.equal(published.rows[0].payload.payload.id,version.rows[0].domain_order_id);
    assert.equal(published.rows[0].payload.payload.companyId,a.company);
    assert.equal(published.rows[0].payload.payload.version,1);

    // A distinct event with an equal timestamp has no trustworthy ordering
    // relation to the accepted event. It must not win by arrival order. An
    // older event is ignored as well; only a strictly newer one may project.
    const orderedOrderId=id();
    providerOrderStates.set(orderedOrderId,'PLACED');
    const orderedBase=Date.parse(eventTime);
    async function sendOrderedEvent(suffix, offsetMs) {
      const occurredAt=new Date(orderedBase+offsetMs).toISOString();
      const orderedEventId=`ordered-${suffix}-${id()}`;
      const orderedRaw=Buffer.from(JSON.stringify({id:orderedEventId,orderId:orderedOrderId,merchantId:a.merchant,
        fullCode:providerOrderStates.get(orderedOrderId)==='CANCELLED'?'CANCELLED':'PLACED',createdAt:occurredAt}));
      const orderedSignature=crypto.createHmac('sha256',a.secret).update(orderedRaw).digest('hex');
      await runtime.ingest({provider:'ifood',accountId:a.account,rawBody:orderedRaw,signature:orderedSignature});
      return orderedEventId;
    }
    const firstOrderedEvent=await sendOrderedEvent('first',0);
    const firstOrderedEventId=(await migrator.query(`SELECT event_id FROM rotamoto.marketplace_event_inbox
      WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3`,[a.company,a.account,firstOrderedEvent])).rows[0].event_id;
    const orderedVersionQuery=()=>migrator.query(`SELECT v.last_event_id,v.last_event_at,d.payload
      FROM rotamoto.marketplace_order_versions v JOIN rotamoto.domain_records d ON d.record_id=v.domain_order_id
      WHERE v.company_id=$1 AND v.external_order_id=$2`,[a.company,orderedOrderId]);
    const acceptedOrder=await orderedVersionQuery();
    assert.equal(acceptedOrder.rowCount,1);
    assert.equal(acceptedOrder.rows[0].payload.extensions.x_rotamoto_external_order.providerStatus,'PLACED');
    providerOrderStates.set(orderedOrderId,'CANCELLED');
    await sendOrderedEvent('equal',0);
    await sendOrderedEvent('late',-1000);
    const afterStaleEvents=await orderedVersionQuery();
    assert.equal(afterStaleEvents.rows[0].last_event_id,firstOrderedEventId,'equal and older provider events do not replace the accepted event cursor');
    assert.equal(afterStaleEvents.rows[0].payload.extensions.x_rotamoto_external_order.providerStatus,'PLACED','stale cancellation does not regress the canonical Order');
    await sendOrderedEvent('newer',1000);
    const afterNewerEvent=await orderedVersionQuery();
    assert.notEqual(afterNewerEvent.rows[0].last_event_id,firstOrderedEventId);
    assert.equal(afterNewerEvent.rows[0].payload.extensions.x_rotamoto_external_order.providerStatus,'CANCELLED','a strictly newer provider cancellation is projected');
    const orderedOutbox=await migrator.query(`SELECT count(*)::int AS count FROM rotamoto.sync_outbox
      WHERE company_id=$1 AND payload->>'entity'='Order' AND payload->>'entityId'=$2`,[a.company,afterNewerEvent.rows[0].payload.id]);
    assert.equal(orderedOutbox.rows[0].count,2,'stale events produce no publication while the newer change is published once');
    const externalDeliveries=await migrator.query(`SELECT count(*)::int AS count FROM rotamoto.domain_records
      WHERE company_id=$1 AND entity_type='Delivery' AND related_entity_type='Order' AND related_record_id=$2 AND deleted_at IS NULL`,
    [a.company,afterNewerEvent.rows[0].payload.id]);
    assert.equal(externalDeliveries.rows[0].count,0,'a platform Order cancellation never fabricates an operational Delivery');
    const concurrentPair=await Promise.all([
      sendOrderedEvent('concurrent-older',1500),
      sendOrderedEvent('concurrent-newer',2500),
    ]);
    const afterConcurrentEvents=await orderedVersionQuery();
    const concurrentWinner=await migrator.query(`SELECT event_id FROM rotamoto.marketplace_event_inbox
      WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3`,[a.company,a.account,concurrentPair[1]]);
    assert.equal(afterConcurrentEvents.rows[0].last_event_id,concurrentWinner.rows[0].event_id,
      'concurrent events serialize on the canonical Order and retain the strictly newest provider timestamp');
    assert.equal(new Date(afterConcurrentEvents.rows[0].last_event_at).toISOString(),new Date(orderedBase+2500).toISOString());
    assert.equal(afterConcurrentEvents.rows[0].payload.extensions.x_rotamoto_external_order.providerStatus,'CANCELLED');
    const concurrentOutbox=await migrator.query(`SELECT count(*)::int AS count FROM rotamoto.sync_outbox
      WHERE company_id=$1 AND payload->>'entity'='Order' AND payload->>'entityId'=$2`,[a.company,afterConcurrentEvents.rows[0].payload.id]);
    assert(concurrentOutbox.rows[0].count>=3&&concurrentOutbox.rows[0].count<=4,
      'serialization may accept either only the newest event or both strictly increasing events, publishing each accepted version once');

    const unifiedOrders=await runtime.listOrders(a.company,50);
    assert.equal(unifiedOrders.length,2,'each external order is available once through the canonical administrative order projection');
    const originalUnifiedOrder=unifiedOrders.find(item=>item.externalOrderId===orderId);
    assert(originalUnifiedOrder,'the initial external order remains in the unified projection');
    assert.deepEqual({domainOrderId:originalUnifiedOrder.domainOrderId,provider:originalUnifiedOrder.provider,displayId:originalUnifiedOrder.displayId,providerStatus:originalUnifiedOrder.providerStatus},
      {domainOrderId:version.rows[0].domain_order_id,provider:'ifood',displayId:'S-1',providerStatus:'PLACED'});
    assert.deepEqual(await runtime.listOrders(b.company,50),[],'an external order projection cannot cross tenant boundaries');
    const raceOrderId=id(),raceEventId=`concurrent-${id()}`;
    providerOrderStates.set(raceOrderId,'PLACED');
    const raceRaw=Buffer.from(JSON.stringify({id:raceEventId,orderId:raceOrderId,merchantId:a.merchant,fullCode:'PLACED',createdAt:new Date().toISOString()}));
    const raceSignature=crypto.createHmac('sha256',a.secret).update(raceRaw).digest('hex');
    const detailsBeforeRace=detailRequests;
    let signalDetail,releaseDetail;
    const detailStarted=new Promise(resolve=>{signalDetail=resolve;});
    const detailGate=new Promise(resolve=>{releaseDetail=resolve;});
    providerDetailGate={orderId:raceOrderId,started:signalDetail,promise:detailGate};
    const firstConcurrentIngest=runtime.ingest({provider:'ifood',accountId:a.account,rawBody:raceRaw,signature:raceSignature});
    await detailStarted;
    await assert.rejects(runtime.ingest({provider:'ifood',accountId:a.account,rawBody:raceRaw,signature:raceSignature}),
      error=>error.code==='MARKETPLACE_EVENT_PENDING'&&error.status===503,
      'concurrent duplicate during active processing remains durably pending for provider retry');
    releaseDetail();
    assert.deepEqual(await firstConcurrentIngest,{duplicate:false,processed:true});
    providerDetailGate=null;
    const completedRaceReplay=await runtime.ingest({provider:'ifood',accountId:a.account,rawBody:raceRaw,signature:raceSignature});
    assert.deepEqual(completedRaceReplay,{duplicate:true,processed:true},'the provider retry converges after the original worker finishes');
    assert.equal(detailRequests,detailsBeforeRace+1,'concurrent duplicate never invokes a second provider detail request');
    const racedInbox=await migrator.query(`SELECT count(*)::int AS count,min(status) AS status FROM rotamoto.marketplace_event_inbox
      WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3`,[a.company,a.account,raceEventId]);
    assert.deepEqual(racedInbox.rows[0],{count:1,status:'processed'},'one durable inbox row reaches processed after the retry');
    const idempotencyKey=`browser-command-${id()}`;
    const command=await runtime.enqueueOrderCommand({companyId:a.company,domainOrderId:version.rows[0].domain_order_id,
      operation:'CONFIRM',idempotencyKey,commandData:{}});
    assert.equal(command.duplicate,false,'authenticated tenant producer inserts durable marketplace command');
    const replay=await runtime.enqueueOrderCommand({companyId:a.company,domainOrderId:version.rows[0].domain_order_id,
      operation:'CONFIRM',idempotencyKey,commandData:{}});
    assert.equal(replay.duplicate,true,'command producer is idempotent for client replay');
    await assert.rejects(runtime.enqueueOrderCommand({companyId:b.company,domainOrderId:version.rows[0].domain_order_id,
      operation:'CONFIRM',idempotencyKey:`cross-tenant-${id()}`,commandData:{}}),error=>error.code==='NOT_FOUND',
      'domain order UUID from another tenant cannot be used to enqueue a provider command');
    const persistedCommand=await migrator.query('SELECT status,retry_class,command_data FROM rotamoto.marketplace_command_outbox WHERE command_id=$1',[command.command_id]);
    assert.equal(persistedCommand.rows[0].status,'queued');
    assert.equal(persistedCommand.rows[0].retry_class,'reconcile_before_retry');
    assert.deepEqual(persistedCommand.rows[0].command_data,{});
    await migrator.query('COMMIT');await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[a.company]);
    const sideEffectLease=id();
    const eligibilityCheck=await migrator.query(`SELECT c.status,c.attempts,c.retry_class,a.account_status,a.link_status,i.status AS integration_status
      FROM rotamoto.marketplace_command_outbox c JOIN rotamoto.external_accounts a ON a.id=c.external_account_id AND a.company_id=c.company_id
      JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id WHERE c.company_id=$1 AND c.command_id=$2`,[a.company,command.command_id]);
    const claimedSideEffect=await migrator.query('SELECT * FROM rotamoto.claim_marketplace_command($1,$2,$3)',[a.company,sideEffectLease,30]);
    assert.equal(claimedSideEffect.rows[0]?.command_id,command.command_id,`worker claim uses durable command lease; eligible=${JSON.stringify(eligibilityCheck.rows)} claim=${JSON.stringify(claimedSideEffect.rows)}`);
    await migrator.query(`UPDATE rotamoto.marketplace_command_outbox SET lease_until=now()-interval '1 second' WHERE company_id=$1 AND command_id=$2`,[a.company,command.command_id]);
    const afterWorkerCrash=await migrator.query('SELECT * FROM rotamoto.claim_marketplace_command($1,$2,$3)',[a.company,id(),30]);
    assert.equal(afterWorkerCrash.rowCount,0,'expired side-effect lease is not handed to another worker blindly');
    const uncertain=await migrator.query('SELECT status,last_error_code FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND command_id=$2',[a.company,command.command_id]);
    assert.equal(uncertain.rows[0].status,'unknown_outcome');assert.equal(uncertain.rows[0].last_error_code,'WORKER_LEASE_EXPIRED');
    const readCommand=await runtime.enqueueOrderCommand({companyId:a.company,domainOrderId:version.rows[0].domain_order_id,
      operation:'SHIPPING_QUOTE',idempotencyKey:`safe-read-${id()}`,commandData:{}});
    await migrator.query('COMMIT');await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[a.company]);
    const firstReadLease=await migrator.query('SELECT * FROM rotamoto.claim_marketplace_command($1,$2,$3)',[a.company,id(),30]);
    assert.equal(firstReadLease.rows[0]?.command_id,readCommand.command_id,'safe read command may be claimed');
    await migrator.query(`UPDATE rotamoto.marketplace_command_outbox SET lease_until=now()-interval '1 second' WHERE company_id=$1 AND command_id=$2`,[a.company,readCommand.command_id]);
    const restartedRead=await migrator.query('SELECT * FROM rotamoto.claim_marketplace_command($1,$2,$3)',[a.company,id(),30]);
    assert.equal(restartedRead.rows[0]?.command_id,readCommand.command_id,'read-only command is reclaimable after worker restart');
    assert.equal((await migrator.query('SELECT count(*)::int AS count FROM rotamoto.marketplace_event_inbox WHERE external_event_id=$1',[eventId])).rows[0].count,1);
    const denied = await assert.rejects(runtime.ingest({provider:'ifood',accountId:b.account,rawBody:raw,signature}), error => error.code === 'INVALID_SIGNATURE');
    assert.equal(denied,undefined);
    const forgedMerchant=Buffer.from(JSON.stringify({id:`forged-${eventId}`,orderId,merchantId:'unbound-merchant',fullCode:'PLACED',createdAt:eventTime}));
    const forgedSignature=crypto.createHmac('sha256',a.secret).update(forgedMerchant).digest('hex');
    await assert.rejects(runtime.ingest({provider:'ifood',accountId:a.account,rawBody:forgedMerchant,signature:forgedSignature}),error=>error.code==='ACCOUNT_UNAVAILABLE',
      'a signed callback cannot route a merchant without a unique active binding');
    const routedEvent=Buffer.from(JSON.stringify({id:`routed-${eventId}`,orderId,merchantId:b.merchant,fullCode:'PLACED',createdAt:eventTime}));
    const routedSignature=crypto.createHmac('sha256',a.secret).update(routedEvent).digest('hex');
    await runtime.ingest({provider:'ifood',accountId:a.account,rawBody:routedEvent,signature:routedSignature});
    await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[b.company]);
    const routedOrder=await migrator.query('SELECT company_id FROM rotamoto.marketplace_event_inbox WHERE external_event_id=$1',[`routed-${eventId}`]);
    assert.equal(routedOrder.rows[0]?.company_id,b.company,'signed merchant identity routes the event to its bound tenant, not the webhook path tenant');
    await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[a.company]);
    const deferredEventId=`deferred-${eventId}`;
    const deferredRaw=Buffer.from(JSON.stringify({id:deferredEventId,orderId,merchantId:a.merchant,fullCode:'PLACED',createdAt:eventTime}));
    const deferredSignature=crypto.createHmac('sha256',a.secret).update(deferredRaw).digest('hex');
    const queued=await runtime.ingest({provider:'ifood',accountId:a.account,rawBody:deferredRaw,signature:deferredSignature,deferProcessing:true});
    assert.deepEqual(queued,{duplicate:false,processed:false,queued:true},'webhook response may follow durable inbox persistence while projection is delegated to the worker');
    const queueRow=await migrator.query('SELECT status,next_attempt_at,company_id,external_account_id FROM rotamoto.marketplace_event_inbox WHERE company_id=$1 AND external_event_id=$2',[a.company,deferredEventId]);
    assert.equal(queueRow.rowCount,1,`durable event exists before provider response: ${JSON.stringify(queueRow.rows)}`);
    const eligibility=await migrator.query(`SELECT a.account_status,a.link_status,i.status AS integration_status,b.authorized,
      e.next_attempt_at<=now() AS due FROM rotamoto.marketplace_event_inbox e JOIN rotamoto.external_accounts a ON a.id=e.external_account_id AND a.company_id=e.company_id
      JOIN rotamoto.integrations i ON i.id=a.integration_id AND i.company_id=a.company_id JOIN rotamoto.marketplace_account_bindings b
      ON b.company_id=a.company_id AND b.external_account_id=a.id WHERE e.company_id=$1 AND e.external_event_id=$2`,[a.company,deferredEventId]);
    const eventLease=id();
    await migrator.query('COMMIT'); await migrator.query('BEGIN'); await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[a.company]);
    const claim=(await migrator.query('SELECT * FROM rotamoto.claim_marketplace_event($1,$2,$3)',[a.company,eventLease,90])).rows[0];
    assert.equal(claim?.external_event_id,deferredEventId,`worker claims the durable webhook event through its lease function (row ${JSON.stringify(queueRow.rows[0])}, eligible ${JSON.stringify(eligibility.rows)})`);
    await migrator.query('COMMIT');
    await runtime.processClaimed({provider:'ifood',id:a.account,integrationId:a.integration,companyId:a.company,merchantId:a.merchant,
      status:'active',authorized:true,webhookSecret:a.secret,credentials:{accessToken:'synthetic'}},deferredEventId,eventLease);
    await migrator.query('BEGIN'); await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[a.company]);
    const deferredState=await migrator.query('SELECT status FROM rotamoto.marketplace_event_inbox WHERE company_id=$1 AND external_event_id=$2',[a.company,deferredEventId]);
    assert.equal(deferredState.rows[0].status,'processed','inbox worker completes projection before marking the event processed');
    const secretAcl = await migrator.query(`SELECT has_column_privilege('rotamoto_app','rotamoto.external_accounts','secret_ref','SELECT') AS secret_read,
      has_column_privilege('rotamoto_app','rotamoto.external_accounts','secret_ref','UPDATE') AS secret_write`);
    assert.deepEqual(secretAcl.rows[0],{secret_read:false,secret_write:false});
    await migrator.query('COMMIT');
    process.stdout.write('Marketplace runtime PostgreSQL E2E: PASS (tenant routing, raw HMAC, inbox idempotency, out-of-order/equal-timestamp protection, canonical Order projection, PII-free durable event, post-process poll ack, secret ACL)\n');
    passed = true;
  } finally {
    for (const row of [a,b]) {
      await migrator.query('BEGIN').catch(()=>{});
      await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.marketplace_order_versions WHERE company_id=$1',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.marketplace_command_outbox WHERE company_id=$1',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.marketplace_event_inbox WHERE company_id=$1',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.marketplace_account_bindings WHERE company_id=$1',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type=\'Order\' AND source_installation_id IN (SELECT id FROM rotamoto.sync_installations WHERE company_id=$1 AND local_device_id LIKE \'marketplace-%\')',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.sync_installations WHERE company_id=$1 AND local_device_id LIKE \'marketplace-%\' AND NOT EXISTS(SELECT 1 FROM rotamoto.domain_records d WHERE d.company_id=$1 AND d.source_installation_id=sync_installations.id)',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.external_accounts WHERE company_id=$1',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.integrations WHERE company_id=$1',[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.companies WHERE id=$1',[row.company]).catch(()=>{});
      await migrator.query('COMMIT').catch(()=>{});
    }
    await app.end(); await migrator.end();
    await fixture.update({ status: passed ? 'RETAINED' : 'FAILED', databaseCommitted: true,
      retentionReason: 'E2E-owned synthetic tenant cleanup was attempted; append-only audit records are never deleted and this run remains inventoried.',
      counts: { companies: 2, integrations: 2, accounts: 2, audit_log: 'retained-or-not-applicable' } });
  }
}

main().catch(error=>{process.stderr.write(`Marketplace runtime PostgreSQL E2E: FAIL (${error.message})\n`);process.exitCode=1;});
