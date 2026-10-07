'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createPool}=require('../backend/postgres/connection');
const {e2eMigrationConnectionString}=require('../backend/postgres/migrate');
const {createMarketplaceRuntime}=require('../backend/integrations/marketplace-runtime');
const {createMarketplaceWorker}=require('../backend/integrations/marketplace-worker');

const id=()=>crypto.randomUUID();
async function main(){
  const migrator=createPool({connectionString:e2eMigrationConnectionString(process.env),max:1,application_name:'marketplace-worker-e2e-seed'});
  const app=createPool({connectionString:'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',max:2,application_name:'marketplace-worker-e2e-app'});
  const row={company:id(),integration:id(),account:id(),merchant:id(),secret:'synthetic-runtime-secret'},orderId=id();
  let confirms=0,detailStatus='PLACED';
  try{
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query('INSERT INTO rotamoto.companies(id,name,status) VALUES($1,$2,\'active\')',[row.company,'Marketplace worker synthetic']);
    await migrator.query("INSERT INTO rotamoto.integrations(id,company_id,provider,status) VALUES($1,$2,'ifood','active')",[row.integration,row.company]);
    await migrator.query(`INSERT INTO rotamoto.external_accounts(id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,account_status,poll_next_at)
      VALUES($1,$2,$3,$4,'Synthetic merchant','confirmed',now(),'active',now()+interval '1 day')`,[row.account,row.company,row.integration,row.merchant]);
    await migrator.query(`INSERT INTO rotamoto.marketplace_account_bindings(company_id,integration_id,external_account_id,provider,merchant_id,authorized)
      VALUES($1,$2,$3,'ifood',$4,true)`,[row.company,row.integration,row.account,row.merchant]);
    await migrator.query('COMMIT');
    const account={provider:'ifood',id:row.account,integrationId:row.integration,companyId:row.company,merchantId:row.merchant,status:'active',authorized:true,
      webhookSecret:row.secret,credentials:{clientId:'synthetic-client',clientSecret:'synthetic-client-secret',accessToken:'synthetic-access'}};
    const adapters={ifood:{async order(){return {source:'ifood',externalId:orderId,externalDisplayId:'E2E-WORKER',status:detailStatus,orderType:'DELIVERY',createdAt:new Date().toISOString(),
      customer:{name:'PII must not persist',phone:'+55000000000'},address:'Synthetic address',items:[{name:'Meal',quantity:1}]};},
      async confirmOrder(){confirms++;return {accepted:true,confirmation:'pending'};},async pollEvents(){return [];},async acknowledgeEvents(){return {accepted:true};}}};
    const resolver={async byId(provider,accountId){return provider==='ifood'&&accountId===row.account?account:null;},async byMerchant(provider,merchantId){return provider==='ifood'&&merchantId===row.merchant?account:null;}};
    const runtime=createMarketplaceRuntime({pool:app,adapters,accountResolver:resolver});
    const event=(status,eventId)=>Buffer.from(JSON.stringify({id:eventId,orderId,merchantId:row.merchant,fullCode:status,createdAt:new Date().toISOString()}));
    const signature=raw=>crypto.createHmac('sha256',row.secret).update(raw).digest('hex');
    const placed=event('PLACED',`worker-${id()}`);
    await runtime.ingest({provider:'ifood',accountId:row.account,rawBody:placed,signature:signature(placed)});
    const order=(await runtime.listOrders(row.company))[0];assert(order?.domainOrderId);
    const command=await runtime.enqueueOrderCommand({companyId:row.company,domainOrderId:order.domainOrderId,operation:'CONFIRM',idempotencyKey:`worker-${id()}`,commandData:{}});
    const worker=createMarketplaceWorker({pool:migrator,companyIds:[row.company],adapters,accountResolver:async(_provider,accountId,companyId)=>accountId===row.account&&companyId===row.company?account:null,random:()=>0});
    assert.equal(await worker.runOnce(),true,'worker claims real durable command and executes only the synthetic adapter');
    assert.equal(confirms,1);
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    const pending=await migrator.query('SELECT status,attempts FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND command_id=$2',[row.company,command.command_id]);
    assert.deepEqual(pending.rows[0],{status:'pending',attempts:1},'adapter 202 is persisted as pending, never final success');
    await migrator.query('COMMIT');
    detailStatus='CONFIRMED';const confirmed=event('CONFIRMED',`worker-${id()}`);
    await runtime.ingest({provider:'ifood',accountId:row.account,rawBody:confirmed,signature:signature(confirmed)});
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    const final=await migrator.query(`SELECT c.status,d.payload->>'source' AS source,d.payload ? 'customer' AS customer_persisted,d.payload ? 'address' AS address_persisted
      FROM rotamoto.marketplace_command_outbox c JOIN rotamoto.marketplace_order_versions v ON v.company_id=c.company_id AND v.external_order_id=c.external_order_id
      JOIN rotamoto.domain_records d ON d.company_id=v.company_id AND d.record_id=v.domain_order_id
      WHERE c.company_id=$1 AND c.command_id=$2`,[row.company,command.command_id]);
    assert.deepEqual(final.rows[0],{status:'succeeded',source:'ifood',customer_persisted:false,address_persisted:false},'confirmed event reconciles the command and Order.source stays commercial');
    assert.equal(confirms,1,'reconciliation never replays the side effect');
    await migrator.query('COMMIT');
    process.stdout.write('Marketplace worker PostgreSQL E2E: PASS (Order→producer→durable outbox→leased worker→synthetic adapter 202→event reconciliation; no PII or provider traffic)\n');
  }finally{
    await migrator.query('BEGIN').catch(()=>{});await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]).catch(()=>{});
    for(const sql of [
      'DELETE FROM rotamoto.marketplace_order_versions WHERE company_id=$1',
      'DELETE FROM rotamoto.marketplace_command_outbox WHERE company_id=$1',
      'DELETE FROM rotamoto.marketplace_event_inbox WHERE company_id=$1',
      'DELETE FROM rotamoto.marketplace_account_bindings WHERE company_id=$1',
      "DELETE FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Order' AND source_installation_id IN (SELECT id FROM rotamoto.sync_installations WHERE company_id=$1 AND local_device_id LIKE 'marketplace-%')",
      "DELETE FROM rotamoto.sync_installations WHERE company_id=$1 AND local_device_id LIKE 'marketplace-%' AND NOT EXISTS(SELECT 1 FROM rotamoto.domain_records d WHERE d.company_id=$1 AND d.source_installation_id=sync_installations.id)",
      'DELETE FROM rotamoto.external_accounts WHERE company_id=$1','DELETE FROM rotamoto.integrations WHERE company_id=$1','DELETE FROM rotamoto.companies WHERE id=$1'])
      await migrator.query(sql,[row.company]).catch(()=>{});
    await migrator.query('COMMIT').catch(()=>{});await app.end();await migrator.end();
  }
}
main().catch(error=>{process.stderr.write(`Marketplace worker PostgreSQL E2E: FAIL (${error.stack||error})\n`);process.exitCode=1;});
