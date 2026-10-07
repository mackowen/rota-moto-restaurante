'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPool } = require('../backend/postgres/connection');
const { createMarketplaceRuntime } = require('../backend/integrations/marketplace-runtime');
const { e2eMigrationConnectionString } = require('../backend/postgres/migrate');

function id() { return crypto.randomUUID(); }

async function main() {
  const migrator = createPool({ connectionString: e2eMigrationConnectionString(process.env), max: 1, application_name: 'marketplace-e2e-seed' });
  const app = createPool({ connectionString: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e', max: 2, application_name: 'marketplace-e2e-runtime' });
  const a = { company: id(), integration: id(), account: id(), merchant: id(), externalAccountId: id(), secret: 'synthetic-marketplace-webhook-secret' };
  const b = { company: id(), integration: id(), account: id(), merchant: id(), externalAccountId: id(), secret: 'synthetic-other-tenant-secret' };
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
    let detailRequests = 0, acknowledgments = 0;
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
      adapters:{ ifood:{ async order(){ detailRequests++; return { source:'ifood',externalId:orderId,externalDisplayId:'S-1',status:'PLACED',orderType:'DELIVERY',createdAt:eventTime,
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
    await runtime.ingestPolled({provider:'ifood',id:a.account,companyId:a.company,integrationId:a.integration,merchantId:a.merchant,
      status:'active',authorized:true,credentials:{accessToken:'synthetic'}}, [{id:eventId,orderId,merchantId:a.merchant,fullCode:'PLACED',createdAt:eventTime}]);
    assert.equal(acknowledgments,1,'poll event is acked only after durable processing; duplicate webhook/poll converges on same inbox key');
    const version = await migrator.query('SELECT domain_order_id FROM rotamoto.marketplace_order_versions WHERE company_id=$1 AND external_order_id=$2',[a.company,orderId]);
    assert.equal(version.rowCount,1,'processed event must link one canonical Order');
    const domain = await migrator.query('SELECT company_id,entity_type,payload FROM rotamoto.domain_records WHERE record_id=$1', [version.rows[0].domain_order_id]);
    assert.equal(domain.rows[0].company_id,a.company,'tenant comes from the trusted account resolver');
    assert.equal(domain.rows[0].entity_type,'Order');
    assert.equal(domain.rows[0].payload.source,'ifood');
    assert.equal(domain.rows[0].payload.logistics,null);
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
    process.stdout.write('Marketplace runtime PostgreSQL E2E: PASS (tenant routing, raw HMAC, inbox idempotency, canonical Order projection, PII-free durable event, post-process poll ack, secret ACL)\n');
  } finally {
    for (const row of [a,b]) {
      await migrator.query('BEGIN').catch(()=>{});
      await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]).catch(()=>{});
      await migrator.query('DELETE FROM rotamoto.marketplace_order_versions WHERE company_id=$1',[row.company]).catch(()=>{});
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
  }
}

main().catch(error=>{process.stderr.write(`Marketplace runtime PostgreSQL E2E: FAIL (${error.message})\n`);process.exitCode=1;});
