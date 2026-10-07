'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createMarketplaceWorker}=require('../backend/integrations/marketplace-worker');

async function scenario(outcome){
  const company=crypto.randomUUID(),accountId=crypto.randomUUID(),commandId=crypto.randomUUID(),lease=crypto.randomUUID();
  let claimed=false,settlement=null,adapterCalls=0;
  const command={company_id:company,command_id:commandId,external_account_id:accountId,provider:'ifood',external_order_id:'order-synthetic',
    operation:'CONFIRM',idempotency_key:'synthetic-command-idempotency',command_data:{},retry_class:'reconcile_before_retry',attempts:1,lease_token:lease};
  const pool={
    async query(sql){
      if(sql.includes('claim_marketplace_event'))return {rows:[]};
      if(sql.includes('claim_marketplace_poll_account'))return {rows:[]};
      if(sql.includes('claim_marketplace_command')){if(claimed)return {rows:[]};claimed=true;return {rows:[command]};}
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async connect(){return {async query(sql,values=[]){
      if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes('set_config'))return {rows:[]};
      if(sql.includes("status='unknown_outcome'"))return {rows:[]};
      if(sql.includes('UPDATE rotamoto.marketplace_command_outbox SET status=$4')){settlement=values;return {rowCount:1,rows:[]};}
      if(sql.includes('UPDATE rotamoto.external_accounts SET account_status'))return {rowCount:1,rows:[]};
      throw new Error(`Unexpected client query: ${sql}`);
    },release(){}};}
  };
  const worker=createMarketplaceWorker({pool,companyIds:[company],accountResolver:async()=>({id:accountId,companyId:company,provider:'ifood',status:'active',credentials:{accessToken:'synthetic'}}),
    adapters:{ifood:{async confirmOrder(){adapterCalls++;if(outcome instanceof Error)throw outcome;return outcome;}}},random:()=>0});
  assert.equal(await worker.runOnce(),true);
  assert.equal(adapterCalls,1);
  return settlement;
}

(async()=>{
  const pending=await scenario({accepted:true,confirmation:'pending'});assert.equal(pending[3],'pending','HTTP 202 remains pending');
  const auth=await scenario(Object.assign(new Error('auth'),{code:'AUTH_EXPIRED',status:401}));assert.equal(auth[3],'needs_review','401 requires reauthorization');
  const limited=await scenario(Object.assign(new Error('limited'),{code:'RATE_LIMIT',status:429,retryAfterSeconds:7}));assert.equal(limited[3],'queued');assert.equal(limited[4],7000);
  const server=await scenario(Object.assign(new Error('server'),{code:'PROVIDER_SERVER_ERROR',status:503}));assert.equal(server[3],'unknown_outcome','ambiguous side effect is reconciled before any retry');
  const timeout=await scenario(Object.assign(new Error('timeout'),{code:'PROVIDER_TIMEOUT'}));assert.equal(timeout[3],'unknown_outcome');
  process.stdout.write('Marketplace worker synthetic lifecycle: PASS (202 pending, 401 reauthorization, 429 Retry-After, 5xx/timeout UNKNOWN_OUTCOME)\n');
})().catch(error=>{process.stderr.write(`Marketplace worker synthetic lifecycle: FAIL (${error.stack||error})\n`);process.exitCode=1;});
