'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createClient}=require('../backend/postgres/connection');
const {createFinanceService}=require('../backend/finance/service');

function assertE2eTarget(name,value,expectedUser){
  assert.equal(typeof value,'string',`${name} is required`);
  const url=new URL(value);
  assert(['postgres:','postgresql:'].includes(url.protocol));
  assert.equal(decodeURIComponent(url.username),expectedUser);
  assert.equal(url.password,'');
  assert(['127.0.0.1','localhost','::1','[::1]'].includes(url.hostname));
  assert.equal(url.pathname,'/rotamoto_e2e');
  assert.equal(url.search,'');assert.equal(url.hash,'');
}
function uuid(){return crypto.randomUUID()}
function eventInput(overrides={}){
  return {eventId:uuid(),idempotencyKey:uuid(),kind:'PAYMENT_CONFIRMED',orderId:null,
    amountMinor:100,currency:'BRL',method:'pix',reference:`REF-${uuid()}`,reason:'Evento de concorrência E2E descartável',...overrides};
}
async function tx(client,companyId,operation){
  await client.query('BEGIN');
  try{
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
    const value=await operation();await client.query('COMMIT');return value;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}

async function run(){
  assert.equal(process.env.NODE_ENV,'test','finance concurrency test requires NODE_ENV=test');
  assertE2eTarget('DATABASE_URL',process.env.DATABASE_URL,'rotamoto_app');
  assertE2eTarget('E2E_MIGRATOR_DATABASE_URL',process.env.E2E_MIGRATOR_DATABASE_URL,'rotamoto_migrator');
  const migrator=createClient({connectionString:process.env.E2E_MIGRATOR_DATABASE_URL});
  const clients=[createClient({connectionString:process.env.DATABASE_URL}),createClient({connectionString:process.env.DATABASE_URL})];
  const finance=createFinanceService(),companyId=uuid(),userId=uuid(),orderId=uuid(),deliveryId=uuid(),earningId=uuid();
  const restaurantInstallId=uuid(),motoboyInstallId=uuid();
  const principal={company_id:companyId,user_id:userId};
  let fixtureCommitted=false,cleanupComplete=false,tenantRlsDisabled=false,fixtureSecurity=null;
  async function restoreSecurity(){
    for(const name of ['companies','users','sync_installations','domain_records','financial_events']){
      const original=fixtureSecurity.get(name);
      if(original.rls){await migrator.query(`ALTER TABLE rotamoto.${name} ENABLE ROW LEVEL SECURITY`);await migrator.query(`ALTER TABLE rotamoto.${name} ${original.force?'FORCE':'NO FORCE'} ROW LEVEL SECURITY`)}
      else await migrator.query(`ALTER TABLE rotamoto.${name} DISABLE ROW LEVEL SECURITY`);
    }
    await migrator.query(`ALTER TABLE rotamoto.financial_events ${fixtureSecurity.get('financial_events').trigger==='O'?'ENABLE':'DISABLE'} TRIGGER financial_events_immutable`);
  }
  try{
    await migrator.connect();await Promise.all(clients.map(client=>client.connect()));
    const migrations=await migrator.query("SELECT migration_id FROM rotamoto.schema_migrations WHERE migration_id='0055_financial_reference_uniqueness'");
    assert.equal(migrations.rowCount,1,'finance uniqueness migration must be applied to the isolated E2E database');
    const identities=await Promise.all(clients.map(client=>client.query('SELECT pg_backend_pid() AS pid')));
    assert.notEqual(identities[0].rows[0].pid,identities[1].rows[0].pid,'race test uses two independent PostgreSQL backends');

    const security=await migrator.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
      (SELECT tgenabled FROM pg_trigger WHERE tgrelid=c.oid AND tgname='financial_events_immutable') AS immutable_trigger
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relname=ANY($1::text[])`,[['users','companies','sync_installations','domain_records','financial_events']]);
    fixtureSecurity=new Map(security.rows.map(row=>[row.relname,{rls:row.relrowsecurity,force:row.relforcerowsecurity,trigger:row.immutable_trigger}]));
    assert.equal(fixtureSecurity.size,5,'all fixture tables expose their security state');
    assert.deepEqual(fixtureSecurity.get('users'),{rls:false,force:false,trigger:null},'global users table follows migrations and has no RLS policy');
    for(const name of ['companies','sync_installations','domain_records','financial_events'])
      assert.deepEqual({rls:fixtureSecurity.get(name)?.rls,force:fixtureSecurity.get(name)?.force},{rls:true,force:true},`${name} keeps forced tenant RLS`);
    assert.equal(fixtureSecurity.get('financial_events')?.trigger,'O','financial event immutability trigger is enabled');

    await migrator.query('BEGIN');
    try{
      for(const table of ['companies','users','sync_installations','domain_records'])await migrator.query(`ALTER TABLE rotamoto.${table} DISABLE ROW LEVEL SECURITY`);
      await migrator.query('COMMIT');tenantRlsDisabled=true;
    }catch(error){await migrator.query('ROLLBACK');throw error}
    await migrator.query('BEGIN');
    try{
      await migrator.query("INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Finance concurrency disposable','active')",[companyId]);
      await migrator.query("INSERT INTO rotamoto.users(id,email,email_verified_at) VALUES($1,$2,now())",[userId,`finance-${companyId}@example.invalid`]);
      await migrator.query(`INSERT INTO rotamoto.sync_installations(id,company_id,app_key,local_device_id,registered_by_user_id)
        VALUES($1,$3,'restaurante',$4,$5),($2,$3,'motoboy',$6,$5)`,[restaurantInstallId,motoboyInstallId,companyId,
          `restaurant-${companyId}`,userId,`motoboy-${companyId}`]);
      const now=new Date().toISOString();
      await migrator.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,$5,$5),
              ($1,$6,'Delivery','restaurante',$3,$7::jsonb,1,$5,$5),
              ($1,$8,'Earning','motoboy',$9,$10::jsonb,1,$5,$5)`,[
        companyId,orderId,restaurantInstallId,JSON.stringify({status:'CONFIRMADO',money:{currency:'BRL',completeness:'complete',components:{totalMinor:10000}}}),now,
        deliveryId,JSON.stringify({status:'DELIVERED',orderId}),earningId,motoboyInstallId,
        JSON.stringify({deliveryId,amountMinor:10000,currency:'BRL',ruleVersion:'finance-concurrency-e2e'})]);
      await migrator.query('COMMIT');fixtureCommitted=true;
    }catch(error){await migrator.query('ROLLBACK');throw error}
    await migrator.query('BEGIN');
    try{
      await restoreSecurity();
      await migrator.query('COMMIT');tenantRlsDisabled=false;
    }catch(error){await migrator.query('ROLLBACK');throw error}

    async function race(inputs){
      assert.equal(inputs.length,2);
      let arrivals=0,openGate;
      const gate=new Promise(resolve=>{openGate=resolve});
      const pids=[];
      const outcomes=await Promise.all(clients.map(async(client,index)=>{
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
        pids[index]=(await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        arrivals++;if(arrivals===2)openGate();await gate;
        try{
          const result=await finance.record(client,principal,inputs[index]);
          await client.query('COMMIT');return{ok:true,...result};
        }catch(error){await client.query('ROLLBACK').catch(()=>{});return{ok:false,code:error.code||error.message}}
      }));
      assert.notEqual(pids[0],pids[1],'both requests must overlap on separate PostgreSQL connections');
      return outcomes;
    }
    const list=()=>tx(clients[0],companyId,()=>finance.list(clients[0],principal,{}));
    function oneWon(outcomes,expectedError){
      assert.equal(outcomes.filter(result=>result.ok&&!result.duplicate).length,1,JSON.stringify(outcomes));
      assert.equal(outcomes.filter(result=>!result.ok&&result.code===expectedError).length,1,JSON.stringify(outcomes));
      return outcomes.find(result=>result.ok&&!result.duplicate).event;
    }

    const sameReference=await race([
      eventInput({orderId,amountMinor:1500,reference:'SAME-RECEIPT-REF'}),
      eventInput({orderId,amountMinor:1500,reference:' same-receipt-ref '})
    ]);
    const firstReceipt=oneWon(sameReference,'DUPLICATE_FINANCIAL_REFERENCE');
    assert.equal((await list()).events.filter(row=>row.event_kind==='PAYMENT_CONFIRMED'&&row.reference.toLowerCase().trim()==='same-receipt-ref').length,1);

    const balanceRace=await race([
      eventInput({orderId,amountMinor:7000,reference:'BALANCE-RACE-A'}),
      eventInput({orderId,amountMinor:6000,reference:'BALANCE-RACE-B'})
    ]);
    const balanceWinner=oneWon(balanceRace,'PAYMENT_EXCEEDS_ORDER');

    const refundRace=await race([
      eventInput({kind:'REFUND',orderId,relatedEventId:firstReceipt.event_id,amountMinor:751,method:'pix',reference:'REFUND-RACE-A'}),
      eventInput({kind:'REFUND',orderId,relatedEventId:firstReceipt.event_id,amountMinor:751,method:'pix',reference:'REFUND-RACE-B'})
    ]);
    oneWon(refundRace,'REFUND_EXCEEDS_PAYMENT');

    const payoutRace=await race([
      eventInput({kind:'PAYOUT_SETTLED',orderId:undefined,earningId,amountMinor:6000,method:undefined,reference:'PAYOUT-RACE-A'}),
      eventInput({kind:'PAYOUT_SETTLED',orderId:undefined,earningId,amountMinor:6000,method:undefined,reference:'PAYOUT-RACE-B'})
    ]);
    oneWon(payoutRace,'PAYOUT_EXCEEDS_EARNING');

    const retry=eventInput({orderId,amountMinor:500,reference:'SAME-IDEMPOTENCY-RETRY'});
    const retryRace=await race([retry,{...retry}]);
    assert.equal(retryRace.filter(result=>result.ok&&!result.duplicate).length,1,JSON.stringify(retryRace));
    assert.equal(retryRace.filter(result=>result.ok&&result.duplicate).length,1,JSON.stringify(retryRace));

    const adjustmentRace=await race([
      eventInput({kind:'ADJUSTMENT',orderId,relatedEventId:firstReceipt.event_id,amountMinor:-100,method:undefined,reference:'ADJUSTMENT-RACE-A'}),
      eventInput({kind:'ADJUSTMENT',orderId,relatedEventId:firstReceipt.event_id,amountMinor:-200,method:undefined,reference:'ADJUSTMENT-RACE-B'})
    ]);
    assert(adjustmentRace.every(result=>result.ok&&!result.duplicate),JSON.stringify(adjustmentRace));

    const reconciled=await list(),rows=reconciled.events;
    assert.equal(rows.filter(row=>row.event_kind==='PAYMENT_CONFIRMED').length,3);
    assert.equal(rows.filter(row=>row.event_kind==='REFUND').reduce((sum,row)=>sum+Number(row.amount_minor),0),751);
    assert.equal(rows.filter(row=>row.event_kind==='PAYOUT_SETTLED').reduce((sum,row)=>sum+Number(row.amount_minor),0),6000);
    assert.equal(rows.filter(row=>row.event_kind==='ADJUSTMENT').reduce((sum,row)=>sum+Number(row.amount_minor),0),-300);
    assert.equal(rows.filter(row=>row.event_id===balanceWinner.event_id).length,1);
    console.log(JSON.stringify({test:'finance-two-connection-concurrency',database:'rotamoto_e2e',backendPids:identities.map(row=>row.rows[0].pid),
      receiptReference:'one persisted / one conflict',overpayment:'one persisted / one rejected',refund:'within original payment',payout:'within earning',
      idempotentRetry:'one persisted / one duplicate',adjustments:'both persisted',events:rows.length,fixtureCommitted:true,cleanup:'PENDING'}));
  }finally{
    if(fixtureCommitted){
      await migrator.query('BEGIN');
      try{
        if(!tenantRlsDisabled){for(const table of ['companies','users','sync_installations','domain_records'])await migrator.query(`ALTER TABLE rotamoto.${table} DISABLE ROW LEVEL SECURITY`);tenantRlsDisabled=true}
        await migrator.query('ALTER TABLE rotamoto.financial_events DISABLE ROW LEVEL SECURITY');
        await migrator.query('ALTER TABLE rotamoto.financial_events DISABLE TRIGGER financial_events_immutable');
        await migrator.query('DELETE FROM rotamoto.financial_events WHERE company_id=$1',[companyId]);
        await migrator.query('DELETE FROM rotamoto.domain_records WHERE company_id=$1',[companyId]);
        await migrator.query('DELETE FROM rotamoto.sync_installations WHERE company_id=$1',[companyId]);
        await migrator.query('DELETE FROM rotamoto.users WHERE id=$1',[userId]);
        await migrator.query('DELETE FROM rotamoto.companies WHERE id=$1',[companyId]);
        await migrator.query('COMMIT');
        await migrator.query('BEGIN');
        await restoreSecurity();
        await migrator.query('COMMIT');tenantRlsDisabled=false;cleanupComplete=true;
      }catch(error){await migrator.query('ROLLBACK').catch(()=>{});throw error}
    }else if(tenantRlsDisabled){
      await migrator.query('BEGIN');
      try{if(fixtureSecurity)await restoreSecurity();await migrator.query('COMMIT');tenantRlsDisabled=false}
      catch(error){await migrator.query('ROLLBACK').catch(()=>{});throw error}
    }
    await Promise.all(clients.map(client=>client.end().catch(()=>{})));
    if(migrator)await migrator.end().catch(()=>{});
  }
  assert(cleanupComplete,'fixture financial events, domain records, installations, user and company must be cleaned');
  console.log(JSON.stringify({test:'finance-two-connection-concurrency-cleanup',database:'rotamoto_e2e',cleanup:'COMPLETED',residuals:0}));
}
run().catch(error=>{console.error(error);process.exitCode=1});
