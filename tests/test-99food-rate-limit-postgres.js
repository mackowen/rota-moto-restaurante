'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createPool}=require('../backend/postgres/connection');
const {e2eMigrationConnectionString}=require('../backend/postgres/migrate');
const {create99FoodRateLimiter}=require('../backend/integrations/99food-rate-limiter');
const {createFixtureManifest}=require('./e2e-support/fixture-manifest');

const id=()=>crypto.randomUUID();
async function main(){
  const a={company:id(),integration:id(),account:id(),shop:`0154-shop-${id()}`};
  const b={company:id(),integration:id(),account:id(),shop:`0154-shop-${id()}`};
  const manifest=await createFixtureManifest({campaign:'0154',evidence:[{kind:'test',name:'99food-distributed-rate-limit-postgres'}]});
  await manifest.update({status:'RUNNING',tenants:[{id:a.company,counts:{companies:1,integrations:1,accounts:1}},{id:b.company,counts:{companies:1,integrations:1,accounts:1}}],
    records:{companies:[a.company,b.company],integrations:[a.integration,b.integration],accounts:[a.account,b.account],shops:[a.shop,b.shop]}});
  const migrator=createPool({connectionString:e2eMigrationConnectionString(process.env),max:1,application_name:'99food-rate-limit-seed'});
  const app=createPool({connectionString:process.env.E2E_RUNTIME_DATABASE_URL||'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e',max:2,application_name:'99food-rate-limit-app'});
  const workerUrl=process.env.E2E_PROVIDER_WORKER_DATABASE_URL;
  assert(workerUrl,'E2E provider worker role URL is required.');
  const workerA=createPool({connectionString:workerUrl,max:1,application_name:'99food-rate-limit-worker-a'});
  const workerB=createPool({connectionString:workerUrl,max:1,application_name:'99food-rate-limit-worker-b'});
  let committed=false;
  try{
    for(const tenant of [a,b]){
      await migrator.query('BEGIN');await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[tenant.company]);
      await migrator.query('INSERT INTO rotamoto.companies(id,name,status) VALUES($1,$2,\'active\')',[tenant.company,`Synthetic 0154 ${tenant.company.slice(0,8)}`]);
      await migrator.query("INSERT INTO rotamoto.integrations(id,company_id,provider,status) VALUES($1,$2,'99food','active')",[tenant.integration,tenant.company]);
      await migrator.query(`INSERT INTO rotamoto.external_accounts(id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,account_status)
        VALUES($1,$2,$3,$4,'Synthetic store','confirmed',now(),'active')`,[tenant.account,tenant.company,tenant.integration,tenant.shop]);
      await migrator.query(`INSERT INTO rotamoto.marketplace_account_bindings(company_id,integration_id,external_account_id,provider,merchant_id,authorized)
        VALUES($1,$2,$3,'99food',$4,true)`,[tenant.company,tenant.integration,tenant.account,tenant.shop]);
      await migrator.query('COMMIT');
    }
    committed=true;
    const appLimiter=create99FoodRateLimiter({pool:app});
    const workerLimiterA=create99FoodRateLimiter({pool:workerA});
    const workerLimiterB=create99FoodRateLimiter({pool:workerB});
    const common={appId:'0154-synthetic-app',operation:'order_detail'};
    const attempts=await Promise.allSettled([
      workerLimiterA({...common,companyId:a.company,accountId:a.account,appShopId:a.shop}),
      workerLimiterB({...common,companyId:b.company,accountId:b.account,appShopId:b.shop})
    ]);
    assert.equal(attempts.filter(item=>item.status==='fulfilled').length,1,'two independent workers share the app-level bucket atomically');
    assert.equal(attempts.filter(item=>item.status==='rejected'&&item.reason.status===429).length,1,'contender receives deterministic local 429');

    const anotherOperation=await appLimiter({appId:'0154-synthetic-app',appShopId:a.shop,companyId:a.company,accountId:a.account,operation:'order_command'});
    assert.equal(anotherOperation,undefined,'command quota is independent from detail quota');
    await assert.rejects(appLimiter({appId:'0154-synthetic-app',appShopId:a.shop,companyId:b.company,accountId:a.account,operation:'order_command'}),
      error=>error.code==='42501'||error.code==='28000','an account cannot be consumed under another tenant context');
    await assert.rejects(workerLimiterA({appId:'0154-synthetic-app',appShopId:a.shop,companyId:a.company,accountId:a.account,operation:'order_command'}),
      error=>error.status===429&&error.retryAfterSeconds>=1,'same store quota is shared across API and worker connections');

    const security=await migrator.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,
      has_table_privilege('rotamoto_app','rotamoto.marketplace_99food_rate_limits','SELECT') AS app_read,
      has_table_privilege('rotamoto_provider_worker','rotamoto.marketplace_99food_rate_limits','SELECT') AS worker_read,
      has_function_privilege('rotamoto_app','rotamoto.consume_99food_rate_limit(uuid,uuid,bytea,bytea,text)','EXECUTE') AS app_exec,
      has_function_privilege('rotamoto_provider_worker','rotamoto.consume_99food_rate_limit(uuid,uuid,bytea,bytea,text)','EXECUTE') AS worker_exec
      FROM pg_class c WHERE c.oid='rotamoto.marketplace_99food_rate_limits'::regclass`);
    assert.deepEqual(security.rows[0],{relrowsecurity:true,relforcerowsecurity:true,app_read:false,worker_read:false,app_exec:true,worker_exec:true});
    const rows=await migrator.query('SELECT count(*)::int AS count FROM rotamoto.marketplace_99food_rate_limits');
    await manifest.update({status:'RETAINED',databaseCommitted:true,counts:{companies:2,integrations:2,accounts:2,rateLimitRows:rows.rows[0].count},
      tenantDatabaseCounts:[{tenantId:a.company,counts:{companies:1,integrations:1,accounts:1}},{tenantId:b.company,counts:{companies:1,integrations:1,accounts:1}}],
      retentionReason:'0154 rate-limit concurrency evidence is retained; cleanup was not authorized.'});
    process.stdout.write(`99Food distributed rate limit PostgreSQL E2E: PASS (manifest ${manifest.runId}; ${rows.rows[0].count} shared buckets; two workers; tenant guard; FORCE RLS; least privilege)\n`);
  }catch(error){
    await manifest.update({status:committed?'RETAINED':'FAILED',databaseCommitted:committed,
      retentionReason:committed?'Seed committed before test failure; preserve for audit.':undefined,
      lastError:{message:String(error.message||error).slice(0,300)}}).catch(()=>{});
    throw error;
  }finally{await Promise.all([migrator.end(),app.end(),workerA.end(),workerB.end()]);}
}
main().catch(error=>{process.stderr.write(`99Food distributed rate limit PostgreSQL E2E: FAIL (${error.stack||error.message})\n`);process.exitCode=1;});
