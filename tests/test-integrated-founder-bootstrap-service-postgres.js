'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createPool}=require('../backend/postgres/connection');
const {createIdentityService}=require('../backend/identity/service');
const {createEmailDeliveryProvider}=require('../backend/identity/email-provider');
const {resolveE2eTargets,assertConnectedIdentity}=require('./e2e-support/guards');

function savepointPool(client){let n=0;const stack=[];return{async connect(){return{async query(sql,values){const normalized=sql.trim().toUpperCase();if(normalized==='BEGIN'){const name=`founder_bootstrap_${++n}`;stack.push(name);return client.query(`SAVEPOINT ${name}`)}if(normalized==='COMMIT'){const name=stack.pop();return client.query(`RELEASE SAVEPOINT ${name}`)}if(normalized==='ROLLBACK'){const name=stack.pop();await client.query(`ROLLBACK TO SAVEPOINT ${name}`);return client.query(`RELEASE SAVEPOINT ${name}`)}return client.query(sql,values)},release(){}}}}}
async function main(){
 assert.equal(process.env.NODE_ENV,'test');const targets=resolveE2eTargets(process.env),pool=createPool({connectionString:targets.runtime,max:1,connectionTimeoutMillis:3000});
 const client=await pool.connect();let outer=false;
 try{
  await assertConnectedIdentity(client,{database:'rotamoto_e2e',role:'rotamoto_app',env:process.env});
  await client.query('BEGIN');outer=true;
  const capability=crypto.randomBytes(32),digest=crypto.createHash('sha256').update(capability).digest();
  await client.query('UPDATE rotamoto.installation_bootstrap SET completed_at=NULL,request_digest=NULL WHERE singleton=true');
  await client.query("INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at) VALUES($1,'rotamoto',now()+interval '10 minutes')",[digest]);
  const deliveries=[],emailProvider=createEmailDeliveryProvider(async message=>{deliveries.push(message);return{accepted:true}});
  const identityPool=savepointPool(client);
  const bootstrapService=createIdentityService({pool:identityPool,emailProvider,requireBootstrapAuthorization:true,
    authorizeProvisioner:async()=>({actorRef:'test:authorized-initial-bootstrap',bootstrapCapabilityDigest:digest})});
  const firstRequest={companyName:'Q first company',email:`q-first-${crypto.randomUUID()}@example.invalid`,idempotencyKey:`bootstrap-${crypto.randomUUID()}`};
  const first=await bootstrapService.provisionInitialOwner(firstRequest);
  assert.equal(first.delivery,'sent');assert.equal(first.replayed,false);
  const grant=await client.query("SELECT grant_kind FROM rotamoto.platform_administrators WHERE user_id=$1 AND revoked_at IS NULL",[first.userId]);
  assert.equal(grant.rows[0]?.grant_kind,'founder_bootstrap','first bootstrap owner receives exactly the global founder grant');
  const replay=await bootstrapService.provisionInitialOwner(firstRequest);assert.equal(replay.replayed,true);
  assert.equal(deliveries.length,1,'repeated bootstrap does not send another invitation or create another founder');
  const regularService=createIdentityService({pool:identityPool,emailProvider,authorizeProvisioner:async()=>({actorRef:'test:tenant-provisioner'})});
  const second=await regularService.provisionInitialOwner({companyName:'Q second company',email:`q-second-${crypto.randomUUID()}@example.invalid`,idempotencyKey:`tenant-${crypto.randomUUID()}`});
  assert.equal(second.delivery,'sent');
  const admins=await client.query('SELECT count(*)::int AS n,bool_and(user_id=$1) AS first_only FROM rotamoto.platform_administrators WHERE revoked_at IS NULL',[first.userId]);
  assert.equal(admins.rows[0].n,1,'a later company owner is not auto-elevated');assert.equal(admins.rows[0].first_only,true);
  assert.equal(deliveries.length,2);
  await client.query('ROLLBACK');outer=false;
  process.stdout.write('integrated founder bootstrap service E2E: first owner grant in provisioning transaction, idempotent retry and second owner without global privilege PASS (outer transaction rolled back)\n');
 }finally{if(outer)await client.query('ROLLBACK').catch(()=>{});client.release();await pool.end()}
}
main().catch(error=>{process.stderr.write(`integrated founder bootstrap service E2E FAIL: ${error.code||'ERROR'} ${error.message}\n`);process.exitCode=1});
