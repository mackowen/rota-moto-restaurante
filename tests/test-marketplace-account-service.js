'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createMarketplaceAccountService}=require('../backend/integrations/marketplace-account-service');

function harness({exchangeError=false}={}){
  const company=crypto.randomUUID(),otherCompany=crypto.randomUUID(),integration=crypto.randomUUID();
  let currentTime=new Date();
  const states=new Map(),oauthSecrets=new Map(),secrets=new Map();let merchantCalls=0,exchangeCalls=0,provisioned=[];
  const pool={async connect(){return {async query(sql,v=[]){
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('set_config'))return {rows:[],rowCount:0};
    if(sql.startsWith('INSERT INTO rotamoto.integrations'))return {rows:[],rowCount:1};
    if(sql.includes('SELECT id::text FROM rotamoto.integrations'))return {rows:[{id:integration}],rowCount:1};
    if(sql.includes('SELECT state_digest FROM rotamoto.marketplace_oauth_states')){const rows=[];for(const [key,state] of states)if(state.company===v[0]&&state.expires<=new Date(v[1]))rows.push({state_digest:Buffer.from(key,'hex')});return {rows,rowCount:rows.length};}
    if(sql.includes('INSERT INTO rotamoto.marketplace_oauth_states')){states.set(Buffer.from(v[0]).toString('hex'),{company:v[1],integration:v[2],provider:v[3],expires:new Date(v[5]),consumed:false,onboarding:'pending'});return {rows:[],rowCount:1};}
    if(sql.includes('INSERT INTO rotamoto.marketplace_oauth_secrets')){oauthSecrets.set(Buffer.from(v[0]).toString('hex'),{company:v[1],ref:v[2]});return {rows:[],rowCount:1};}
    if(sql.includes("UPDATE rotamoto.marketplace_oauth_states SET consumed_at=now()")){const key=Buffer.from(v[0]).toString('hex'),row=states.get(key);if(!row||row.company!==v[1]||row.provider!==v[2]||row.consumed||row.expires<=new Date(v[3]))return {rows:[],rowCount:0};row.consumed=true;return {rows:[{integration_id:row.integration,redirect_uri:'https://callbacks.example.invalid/marketplace'}],rowCount:1};}
    if(sql.includes('SELECT secret_ref FROM rotamoto.marketplace_oauth_secrets')){const item=oauthSecrets.get(Buffer.from(v[1]).toString('hex'));return {rows:item&&item.company===v[0]?[{secret_ref:item.ref}]:[],rowCount:item?1:0};}
    if(sql.includes('SELECT s.secret_ref FROM rotamoto.marketplace_oauth_states')){const key=Buffer.from(v[1]).toString('hex'),state=states.get(key),secret=oauthSecrets.get(key);return {rows:state&&secret&&state.company===v[0]&&state.consumed&&state.onboarding==='merchant_lookup'&&state.expires>new Date(v[2])?[{secret_ref:secret.ref}]:[],rowCount:state&&secret?1:0};}
    if(sql.includes('UPDATE rotamoto.marketplace_oauth_secrets SET secret_ref=')){const key=Buffer.from(v[1]).toString('hex'),item=oauthSecrets.get(key);if(!item)return {rows:[],rowCount:0};const previous=item.ref;item.ref=v[2];return {rows:[{secret_ref:previous}],rowCount:1};}
    if(sql.includes("UPDATE rotamoto.marketplace_oauth_states SET onboarding_status='merchant_lookup'")){const row=states.get(Buffer.from(v[1]).toString('hex'));if(row){row.onboarding='merchant_lookup';row.expires=new Date(Date.now()+600000);}return {rows:[],rowCount:row?1:0};}
    if(sql.includes('onboarding_attempts=onboarding_attempts+1')){const row=states.get(Buffer.from(v[1]).toString('hex'));if(row)row.attempts=(row.attempts||0)+1;return {rows:[],rowCount:row?1:0};}
    if(sql.includes("UPDATE rotamoto.marketplace_oauth_states SET onboarding_status='complete'")){const row=states.get(Buffer.from(v[1]).toString('hex'));if(row)row.onboarding='complete';return {rows:[],rowCount:row?1:0};}
    if(sql.includes("UPDATE rotamoto.integrations SET status='active'"))return {rows:[],rowCount:1};
    if(sql.startsWith('DELETE FROM rotamoto.marketplace_oauth_secrets')){const key=Buffer.from(v[1]).toString('hex'),item=oauthSecrets.get(key);oauthSecrets.delete(key);return {rows:item?[{secret_ref:item.ref}]:[],rowCount:item?1:0};}
    if(sql.startsWith('DELETE FROM rotamoto.marketplace_oauth_states')){const key=Buffer.from(v[1]).toString('hex'),yes=states.delete(key);if(yes)oauthSecrets.delete(key);return {rows:[],rowCount:yes?1:0};}
    throw new Error(`Unexpected account service SQL: ${sql}`);
  },release(){}};}};
  const secretProvider={async put({value}){const secretRef=`test:${crypto.randomUUID()}`;secrets.set(secretRef,value);return {secretRef};},async get(ref){if(!secrets.has(ref))throw new Error('missing secret');return secrets.get(ref);},async remove(ref){secrets.delete(ref);}};
  const accountWriter={async scoped(_tenant,fn){const client=await pool.connect();try{return await fn(client);}finally{client.release();}},async provision(input){provisioned.push(input);return {id:crypto.randomUUID()};}};
  const adapters={ifood:{async requestUserCode(){return {authorizationCodeVerifier:'synthetic-verifier',userCode:'ABCD-EFGH',verificationUrlComplete:'https://ifood.example.invalid/auth',expiresIn:600};},
    async exchangeAuthorizationCode(){exchangeCalls++;if(exchangeError)throw Object.assign(new Error('synthetic exchange failure'),{code:'PROVIDER_AUTH_REJECTED',status:401});return {accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresIn:3600};},
    async merchants(){merchantCalls++;return merchantCalls===1?[]:[{id:'merchant-1',name:'Synthetic Restaurant'}];}}};
  const service=createMarketplaceAccountService({pool,accountWriter,secretProvider,adapters,applicationCredentials:async()=>({clientId:'synthetic-client',clientSecret:'synthetic-client-secret'}),
    publicCallbackUrl:'https://callbacks.example.invalid/marketplace',keetaWebhookBaseUrl:'https://callbacks.example.invalid/keeta',clock:()=>new Date(currentTime)});
  return {service,company,otherCompany,states,oauthSecrets,secrets,provisioned,setNow(value){currentTime=new Date(value);},get exchangeCalls(){return exchangeCalls;},get merchantCalls(){return merchantCalls;}};
}

(async()=>{
  const h=harness();const started=await h.service.begin(h.company,'ifood');const digest=crypto.createHash('sha256').update(started.state).digest('hex');
  assert.equal(h.states.has(started.state),false,'raw OAuth state is not persisted');assert.equal(h.states.has(digest),true,'only state digest is persisted');
  await assert.rejects(h.service.finishIfood(h.otherCompany,{state:started.state,authorizationCode:'synthetic-code'}),e=>e.code==='OAUTH_STATE_EXPIRED_OR_USED','state cannot cross tenants');
  await assert.rejects(h.service.finishIfood(h.company,{state:started.state,authorizationCode:'synthetic-code'}),e=>e.code==='AUTHORIZED_MERCHANT_NOT_VISIBLE_YET'&&e.status===202,'eventually invisible merchant stays resumable');
  assert.equal(h.exchangeCalls,1);assert.equal(h.secrets.size,1,'short-lived exchanged tokens remain only in secret provider');
  const complete=await h.service.finishIfood(h.company,{state:started.state});assert.equal(complete.accounts.length,1);assert.equal(h.exchangeCalls,1,'resume does not consume authorization code twice');
  assert.equal(h.provisioned[0].credentials.accessToken,'synthetic-access');assert.equal(h.secrets.size,0,'temporary verifier/token secret is removed after provisioning');
  await assert.rejects(h.service.finishIfood(h.company,{state:started.state}),e=>e.code==='OAUTH_STATE_EXPIRED_OR_USED','completed OAuth state cannot replay');
  const expired=harness();const expiring=await expired.service.begin(expired.company,'ifood');expired.setNow(Date.now()+601000);
  await assert.rejects(expired.service.finishIfood(expired.company,{state:expiring.state,authorizationCode:'synthetic-code'}),e=>e.code==='OAUTH_STATE_EXPIRED_OR_USED','expired state is rejected before code exchange');
  const expiringHash=crypto.createHash('sha256').update(expiring.state).digest('hex');await expired.service.begin(expired.company,'ifood');
  assert.equal(expired.states.has(expiringHash),false);assert.equal(expired.secrets.size,1,'expired OAuth verifier is removed on the next account lifecycle operation');
  const failure=harness({exchangeError:true});const failedStart=await failure.service.begin(failure.company,'ifood');
  await assert.rejects(failure.service.finishIfood(failure.company,{state:failedStart.state,authorizationCode:'bad-code'}),e=>e.code==='PROVIDER_AUTH_REJECTED');
  assert.equal(failure.secrets.size,0,'failed token exchange removes verifier secret');
  process.stdout.write('Marketplace account lifecycle synthetic: PASS (state hash, cross-tenant, one-shot, resumable merchant visibility, secret cleanup)\n');
})().catch(error=>{process.stderr.write(`Marketplace account lifecycle synthetic: FAIL (${error.stack||error})\n`);process.exitCode=1;});
