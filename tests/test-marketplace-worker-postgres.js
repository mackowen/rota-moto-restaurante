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
  let confirms=0,confirmOutcome={accepted:true,confirmation:'pending'},detailStatus='PLACED',seeded=false;
  const secretProvider={async get(ref,context){assert.equal(ref,row.secretRef);assert.equal(context.name,`marketplace/ifood/${row.account}`);assert.equal(context.scope,'tenant');assert.equal(context.tenantId,row.company);
    return JSON.stringify({clientId:'synthetic-client',clientSecret:row.secret,accessToken:'synthetic-access',accountScope:row.account,companyId:row.company});}};
  const resolver=createMarketplaceAccountResolver({privilegedPool:resolverPool,secretProvider});
  const adapters={ifood:{async order(){return {source:'ifood',externalId:orderId,externalDisplayId:'E2E-WORKER',status:detailStatus,orderType:'DELIVERY',createdAt:new Date().toISOString(),
      customer:{name:'PII must not persist',phone:'+55000000000'},address:'Synthetic address',items:[{name:'Meal',quantity:1}]};},
    async confirmOrder(){confirms++;if(confirmOutcome instanceof Error)throw confirmOutcome;return confirmOutcome;},async pollEvents(){return [];},async acknowledgeEvents(){return {accepted:true};}}};
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
    const roleCatalog=await migrator.query(`SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolreplication,r.rolbypassrls,
      EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS has_memberships
      FROM pg_roles r WHERE r.rolname=ANY($1::text[]) ORDER BY r.rolname`,[['rotamoto_provider_resolver','rotamoto_provider_worker']]);
    assert.deepEqual(roleCatalog.rows,[
      {rolname:'rotamoto_provider_resolver',rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,has_memberships:false},
      {rolname:'rotamoto_provider_worker',rolcanlogin:true,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,has_memberships:false}
    ],'dedicated roles retain least-privilege attributes and no memberships');
    const secretAcl=await workerPool.query(`SELECT has_column_privilege(current_user,'rotamoto.external_accounts','secret_ref','SELECT') AS secret_select,
      has_table_privilege(current_user,'rotamoto.marketplace_oauth_secrets','SELECT') AS oauth_select`);
    assert.deepEqual(secretAcl.rows[0],{secret_select:false,oauth_select:false},'worker must not read secret refs or OAuth verifier state');
    const boundaryAcl=await resolverPool.query(`SELECT has_column_privilege(current_user,'rotamoto.external_accounts','secret_ref','SELECT') AS secret_ref_select,
      has_table_privilege(current_user,'rotamoto.marketplace_oauth_secrets','SELECT') AS oauth_boundary_select,
      has_table_privilege(current_user,'rotamoto.companies','SELECT') AS broad_company_select,
      has_column_privilege('rotamoto_app','rotamoto.external_accounts','secret_ref','SELECT') AS app_secret_select,
      has_column_privilege('rotamoto_app','rotamoto.external_accounts','secret_ref','UPDATE') AS app_secret_update`);
    assert.deepEqual(boundaryAcl.rows[0],{secret_ref_select:true,oauth_boundary_select:true,broad_company_select:false,app_secret_select:false,app_secret_update:false},
      'only resolver has its explicit secret boundary; app stays denied');
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

    const outsider=await workerPool.connect();
    try{await outsider.query('BEGIN');await outsider.query("SELECT set_config('app.tenant_id',$1,true)",[row.otherCompany]);
      const hidden=await outsider.query('SELECT company_id FROM rotamoto.marketplace_order_versions WHERE company_id=$1',[row.company]);
      assert.equal(hidden.rowCount,0,'worker cannot cross tenant RLS even with a forged company filter');await outsider.query('COMMIT');
    }catch(error){await outsider.query('ROLLBACK').catch(()=>{});throw error;}finally{outsider.release();}

    async function enqueueAndRun(key,retryClass='reconcile_before_retry'){
      return runtime.enqueueOrderCommand({companyId:row.company,domainOrderId:order.domainOrderId,operation:'CONFIRM',idempotencyKey:key.padEnd(16,'x'),commandData:{},retryClass});
    }
    async function commandState(commandId){
      await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
      const result=await migrator.query('SELECT status,attempts,last_error_code FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND command_id=$2',[row.company,commandId]);
      await migrator.query('COMMIT');return result.rows[0];
    }
    confirmOutcome=Object.assign(new Error('synthetic unauthorized'),{code:'AUTH_EXPIRED',status:401});
    const authCommand=await enqueueAndRun(`worker-401-${id()}`);await worker.runOnce();
    assert.equal((await commandState(authCommand.command_id)).status,'needs_review','401 moves the command to reauthorization review');
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query("UPDATE rotamoto.external_accounts SET account_status='active' WHERE company_id=$1 AND id=$2",[row.company,row.account]);await migrator.query('COMMIT');

    confirmOutcome=Object.assign(new Error('synthetic forbidden'),{code:'FORBIDDEN',status:403});
    const forbiddenCommand=await enqueueAndRun(`worker-403-${id()}`);await worker.runOnce();
    assert.equal((await commandState(forbiddenCommand.command_id)).status,'needs_review','403 requires reauthorization and is never blindly retried');
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query("UPDATE rotamoto.external_accounts SET account_status='active' WHERE company_id=$1 AND id=$2",[row.company,row.account]);await migrator.query('COMMIT');
    confirmOutcome=Object.assign(new Error('synthetic rate limit'),{code:'RATE_LIMIT',status:429,retryAfterSeconds:60});
    const limitedCommand=await enqueueAndRun(`worker-429-${id()}`,'safe_retry');await worker.runOnce();
    assert.equal((await commandState(limitedCommand.command_id)).status,'queued','429 is retried only as an explicitly safe command');
    confirmOutcome=Object.assign(new Error('synthetic upstream failure'),{code:'PROVIDER_SERVER_ERROR',status:503});
    const serverCommand=await enqueueAndRun(`worker-503-${id()}`);await worker.runOnce();
    assert.equal((await commandState(serverCommand.command_id)).status,'unknown_outcome','5xx side effect is not retried blindly');
    const beforeReconciliation=confirms;detailStatus='CONFIRMED';
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query("UPDATE rotamoto.marketplace_command_outbox SET created_at=now()-interval '70 seconds',updated_at=now()-interval '61 seconds' WHERE company_id=$1 AND command_id=$2",[row.company,serverCommand.command_id]);await migrator.query('COMMIT');
    assert.equal(await worker.reconcileUnknown(row.company),true,'worker reconciles unknown side effect via provider detail');
    assert.equal((await commandState(serverCommand.command_id)).status,'succeeded');assert.equal(confirms,beforeReconciliation,'reconciliation does not repeat confirm');
    detailStatus='PLACED';confirmOutcome=Object.assign(new Error('synthetic timeout'),{code:'PROVIDER_TIMEOUT'});
    const timeoutCommand=await enqueueAndRun(`worker-timeout-${id()}`);await worker.runOnce();
    assert.equal((await commandState(timeoutCommand.command_id)).status,'unknown_outcome','timeout remains ambiguous');
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query("UPDATE rotamoto.marketplace_command_outbox SET created_at=now()-interval '70 seconds',updated_at=now()-interval '61 seconds' WHERE company_id=$1 AND command_id=$2",[row.company,timeoutCommand.command_id]);await migrator.query('COMMIT');
    assert.equal(await worker.reconcileUnknown(row.company),true);assert.equal((await commandState(timeoutCommand.command_id)).status,'unknown_outcome');

    confirmOutcome={accepted:true,confirmation:'pending'};
    const leaseCommand=await enqueueAndRun(`worker-lease-${id()}`);
    const oldLease=crypto.randomUUID(),newLease=crypto.randomUUID();
    const firstClaim=await workerPool.query('SELECT * FROM rotamoto.claim_marketplace_command($1,$2,$3)',[row.company,oldLease,10]);
    assert.equal(firstClaim.rows[0]?.command_id,leaseCommand.command_id,'dedicated worker claims its command lease');
    await workerPool.query('BEGIN');await workerPool.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    const expired=await workerPool.query("UPDATE rotamoto.marketplace_command_outbox SET lease_until=now()-interval '1 second' WHERE company_id=$1 AND command_id=$2 AND lease_token=$3",[row.company,leaseCommand.command_id,oldLease]);
    assert.equal(expired.rowCount,1,'worker can only expire its own tenant-scoped lease');await workerPool.query('COMMIT');
    const secondClaim=await workerPool.query('SELECT * FROM rotamoto.claim_marketplace_command($1,$2,$3)',[row.company,newLease,10]);
    assert.equal(secondClaim.rowCount,0,'expired ambiguous side effect is not reclaimed for blind retry after restart');
    assert.deepEqual(await commandState(leaseCommand.command_id),{status:'unknown_outcome',attempts:1,last_error_code:'WORKER_LEASE_EXPIRED'});
    await workerPool.query('BEGIN');await workerPool.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    const staleFence=await workerPool.query("UPDATE rotamoto.marketplace_command_outbox SET status='succeeded' WHERE company_id=$1 AND command_id=$2 AND lease_token=$3",[row.company,leaseCommand.command_id,oldLease]);await workerPool.query('COMMIT');
    assert.equal(staleFence.rowCount,0,'fenced old lease cannot settle the recovered command');

    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query("UPDATE rotamoto.external_accounts SET account_status='disabled' WHERE company_id=$1 AND id=$2",[row.company,row.account]);
    await migrator.query('COMMIT');
    assert.equal(await resolver.byMerchant('ifood',row.merchant),null,'disabled account cannot be resolved by worker');
    await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[row.company]);
    await migrator.query("UPDATE rotamoto.external_accounts SET account_status='active' WHERE company_id=$1 AND id=$2",[row.company,row.account]);
    await migrator.query('UPDATE rotamoto.marketplace_account_bindings SET authorized=false WHERE company_id=$1 AND external_account_id=$2',[row.company,row.account]);
    await migrator.query('COMMIT');
    assert.equal(await resolver.byMerchant('ifood',row.merchant),null,'revoked authorization cannot be resolved');
    process.stdout.write('Marketplace worker PostgreSQL E2E: PASS (real resolver/worker identities, RLS isolation, 401/403/429/503/timeout, UNKNOWN_OUTCOME reconciliation, lease expiry/fencing, secret boundary)\n');
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
if(require.main===module)main().catch(error=>{process.stderr.write(`Marketplace worker PostgreSQL E2E: FAIL (${error.code||'ERROR'}: ${error.message||'operation failed'})\n${error.stack||''}\n`);process.exitCode=1;});
module.exports={roleUrl,assertRole};
