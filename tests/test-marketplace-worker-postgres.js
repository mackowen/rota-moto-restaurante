'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createPool}=require('../backend/postgres/connection');
const {e2eMigrationConnectionString}=require('../backend/postgres/migrate');
const {createMarketplaceRuntime}=require('../backend/integrations/marketplace-runtime');
const {createMarketplaceWorker}=require('../backend/integrations/marketplace-worker');
const {createMarketplaceAccountResolver}=require('../backend/integrations/marketplace-account-resolver');

const id=()=>crypto.randomUUID();
function roleUrl(name,envName){
  const value=process.env[envName];
  if(!value)throw Object.assign(new Error(`${envName} must point to an authenticated dedicated provider role.`),{code:'DEDICATED_PROVIDER_ROLES_REQUIRED'});
  let url;try{url=new URL(value);}catch(_){throw new Error(`${envName} is invalid.`);}
  if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!==name||url.password||
    url.hostname!=='127.0.0.1'||url.port!=='5432'||url.pathname!=='/rotamoto_e2e'||url.search||url.hash)
    throw new Error(`${envName} must use ${name} without a URL password on the exact rotamoto_e2e target.`);
  return value;
}
async function assertRole(pool,expected){
  const result=await pool.query('SELECT current_user AS role,session_user AS session_role');
  assert.deepEqual(result.rows[0],{role:expected,session_role:expected},`database test must authenticate as ${expected}, never rotamoto_migrator`);
}
async function main(){
  const e2e=e2eMigrationConnectionString(process.env);
  const workerUrl=roleUrl('rotamoto_provider_worker','E2E_PROVIDER_WORKER_DATABASE_URL');
  const resolverUrl=roleUrl('rotamoto_provider_resolver','E2E_PROVIDER_RESOLVER_DATABASE_URL');
  const migrator=createPool({connectionString:e2e,max:1,application_name:'marketplace-worker-e2e-seed'});
  const app=createPool({connectionString:process.env.E2E_RUNTIME_DATABASE_URL||'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',max:2,application_name:'marketplace-worker-e2e-app'});
  const workerPool=createPool({connectionString:workerUrl,max:2,application_name:'marketplace-worker-e2e-worker'});
  const resolverPool=createPool({connectionString:resolverUrl,max:2,application_name:'marketplace-worker-e2e-resolver'});
  const row={company:id(),otherCompany:id(),integration:id(),account:id(),merchant:`synthetic-${id()}`,secretRef:`synthetic-${id()}`,
    secret:'synthetic-runtime-secret'},orderId=id();
  let confirms=0,detailStatus='PLACED',seeded=false;
  const secretProvider={async get(ref,context){assert.equal(ref,row.secretRef);assert.equal(context.name,`marketplace/ifood/${row.account}`);assert.equal(context.scope,'tenant');assert.equal(context.tenantId,row.company);
    return JSON.stringify({clientId:'synthetic-client',clientSecret:row.secret,accessToken:'synthetic-access',accountScope:row.account,companyId:row.company});}};
  const resolver=createMarketplaceAccountResolver({privilegedPool:resolverPool,secretProvider});
  const adapters={ifood:{async order(){return {source:'ifood',externalId:orderId,externalDisplayId:'E2E-WORKER',status:detailStatus,orderType:'DELIVERY',createdAt:new Date().toISOString(),
      customer:{name:'PII must not persist',phone:'+55000000000'},address:'Synthetic address',items:[{name:'Meal',quantity:1}]};},
    async confirmOrder(){confirms++;return {accepted:true,confirmation:'pending'};},async pollEvents(){return [];},async acknowledgeEvents(){return {accepted:true};}}};
  const runtime=createMarketplaceRuntime({pool:app,adapters,accountResolver:resolver});
  const workerResolver=async(provider,accountId,companyId)=>resolver.byId(provider,accountId,companyId);
  workerResolver.byMerchant=(provider,merchantId)=>resolver.byMerchant(provider,merchantId);
  const worker=createMarketplaceWorker({pool:workerPool,companyIds:[row.company],adapters,accountResolver:workerResolver,random:()=>0});
  const event=(status,eventId)=>Buffer.from(JSON.stringify({id:eventId,orderId,merchantId:row.merchant,fullCode:status,createdAt:new Date().toISOString()}));
  const signature=raw=>crypto.createHmac('sha256',row.secret).update(raw).digest('hex');
  try{
    await assertRole(workerPool,'rotamoto_provider_worker');
    await assertRole(resolverPool,'rotamoto_provider_resolver');
    await assertRole(app,'rotamoto_app');
    const secretAcl=await workerPool.query(`SELECT has_column_privilege(current_user,'rotamoto.external_accounts','secret_ref','SELECT') AS secret_select,
      has_table_privilege(current_user,'rotamoto.marketplace_oauth_secrets','SELECT') AS oauth_select`);
    assert.deepEqual(secretAcl.rows[0],{secret_select:false,oauth_select:false},'worker must not read secret refs or OAuth verifier state');
    await assert.equal(await resolver.byId('ifood',row.account,row.otherCompany),null,'account route must reject caller-selected cross-tenant context');

    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query('INSERT INTO rotamoto.companies(id,name,status) VALUES($1,$2,\'active\')',[row.company,'Marketplace worker synthetic']);
    await migrator.query("INSERT INTO rotamoto.integrations(id,company_id,provider,status) VALUES($1,$2,'ifood','active')",[row.integration,row.company]);
    await migrator.query(`INSERT INTO rotamoto.external_accounts(id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,account_status,poll_next_at,secret_ref)
      VALUES($1,$2,$3,$4,'Synthetic merchant','confirmed',now(),'active',now()+interval '1 day',$5)`,[row.account,row.company,row.integration,row.merchant,row.secretRef]);
    await migrator.query(`INSERT INTO rotamoto.marketplace_account_bindings(company_id,integration_id,external_account_id,provider,merchant_id,authorized)
      VALUES($1,$2,$3,'ifood',$4,true)`,[row.company,row.integration,row.account,row.merchant]);
    await migrator.query('COMMIT');seeded=true;

    const resolved=await resolver.byMerchant('ifood',row.merchant);
    assert.equal(resolved.companyId,row.company);assert.equal(resolved.credentials.clientSecret,row.secret);
    const placed=event('PLACED',`worker-${id()}`);
    await runtime.ingest({provider:'ifood',accountId:row.account,rawBody:placed,signature:signature(placed)});
    const order=(await runtime.listOrders(row.company))[0];assert(order?.domainOrderId);
    const command=await runtime.enqueueOrderCommand({companyId:row.company,domainOrderId:order.domainOrderId,operation:'CONFIRM',idempotencyKey:`worker-${id()}`,commandData:{}});
    assert.equal(await worker.runOnce(),true,'dedicated worker role claims and executes the durable command');
    assert.equal(confirms,1);
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    const pending=await migrator.query('SELECT status,attempts FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND command_id=$2',[row.company,command.command_id]);
    assert.deepEqual(pending.rows[0],{status:'pending',attempts:1},'adapter 202 is persisted as pending, never final success');await migrator.query('COMMIT');
    detailStatus='CONFIRMED';const confirmed=event('CONFIRMED',`worker-${id()}`);
    await runtime.ingest({provider:'ifood',accountId:row.account,rawBody:confirmed,signature:signature(confirmed)});
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    const final=await migrator.query(`SELECT c.status,d.payload->>'source' AS source,d.payload ? 'customer' AS customer_persisted,d.payload ? 'address' AS address_persisted
      FROM rotamoto.marketplace_command_outbox c JOIN rotamoto.marketplace_order_versions v ON v.company_id=c.company_id AND v.external_order_id=c.external_order_id
      JOIN rotamoto.domain_records d ON d.company_id=v.company_id AND d.record_id=v.domain_order_id
      WHERE c.company_id=$1 AND c.command_id=$2`,[row.company,command.command_id]);
    assert.deepEqual(final.rows[0],{status:'succeeded',source:'ifood',customer_persisted:false,address_persisted:false});
    assert.equal(confirms,1,'event reconciliation never replays the side effect');await migrator.query('COMMIT');

    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query("UPDATE rotamoto.external_accounts SET account_status='disabled' WHERE company_id=$1 AND id=$2",[row.company,row.account]);
    await migrator.query('COMMIT');
    assert.equal(await resolver.byMerchant('ifood',row.merchant),null,'disabled account cannot be resolved by worker');
    process.stdout.write('Marketplace worker PostgreSQL E2E: PASS (authenticated worker/resolver roles, least-privilege secrets, producer→outbox→worker→synthetic adapter→event reconciliation)\n');
  }finally{
    if(seeded){
      await migrator.query('BEGIN').catch(()=>{});await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]).catch(()=>{});
      for(const sql of [
        'DELETE FROM rotamoto.marketplace_order_versions WHERE company_id=$1','DELETE FROM rotamoto.marketplace_command_outbox WHERE company_id=$1',
        'DELETE FROM rotamoto.marketplace_event_inbox WHERE company_id=$1','DELETE FROM rotamoto.marketplace_account_bindings WHERE company_id=$1',
        "DELETE FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Order' AND source_installation_id IN (SELECT id FROM rotamoto.sync_installations WHERE company_id=$1 AND local_device_id LIKE 'marketplace-%')",
        "DELETE FROM rotamoto.sync_installations WHERE company_id=$1 AND local_device_id LIKE 'marketplace-%' AND NOT EXISTS(SELECT 1 FROM rotamoto.domain_records d WHERE d.company_id=$1 AND d.source_installation_id=sync_installations.id)",
        'DELETE FROM rotamoto.external_accounts WHERE company_id=$1','DELETE FROM rotamoto.integrations WHERE company_id=$1','DELETE FROM rotamoto.companies WHERE id=$1'])
        await migrator.query(sql,[row.company]).catch(()=>{});
      await migrator.query('COMMIT').catch(()=>{});
    }
    await Promise.all([app.end(),workerPool.end(),resolverPool.end(),migrator.end()]);
  }
}
if(require.main===module)main().catch(error=>{process.stderr.write(`Marketplace worker PostgreSQL E2E: FAIL (${error.code||error.stack||error})\n`);process.exitCode=1;});
module.exports={roleUrl,assertRole};
