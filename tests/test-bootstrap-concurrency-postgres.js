'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createPool}=require('../backend/postgres/connection');
const {createIdentityService}=require('../backend/identity/service');
const {createEmailDeliveryProvider}=require('../backend/identity/email-provider');
const {createNativeMfaProvider}=require('../backend/identity/native-mfa-provider');
const {codeAt}=require('../backend/identity/totp');
const {resolveE2eTargets,assertConnectedIdentity}=require('./e2e-support/guards');

async function main(){
  const env=process.env;
  assert.equal(env.NODE_ENV,'test');assert.equal(env.ROTAMOTO_BOOTSTRAP_DISPOSABLE,'0234');
  const targets=resolveE2eTargets(env),pool=createPool({connectionString:targets.runtime,password:async()=>undefined,max:6,connectionTimeoutMillis:3000});
  const migrator=createPool({connectionString:targets.migrator,password:async()=>undefined,max:2,connectionTimeoutMillis:3000});
  const runtimeClient=await pool.connect(),migrationClient=await migrator.connect();
  const issued=[],digests=[],capabilities=[];let emailAttempt=0;
  const emailProvider=createEmailDeliveryProvider(async message=>{
    emailAttempt++;
    if(emailAttempt===1)throw new Error('injected post-commit delivery interruption');
    issued.push(message);return {accepted:true};
  });
  try{
    await assertConnectedIdentity(runtimeClient,{database:'rotamoto_e2e',role:'rotamoto_app',env});
    await assertConnectedIdentity(migrationClient,{database:'rotamoto_e2e',role:'rotamoto_migrator',env});
    const empty=await migrationClient.query(`SELECT (SELECT count(*) FROM rotamoto.companies)::int AS companies,
      (SELECT completed_at IS NOT NULL FROM rotamoto.installation_bootstrap WHERE singleton=true) AS initialized`);
    assert.equal(empty.rows[0].companies,0,'cluster starts without companies');assert.equal(empty.rows[0].initialized,false);

    const failedCapability=crypto.randomBytes(32),failedDigest=crypto.createHash('sha256').update(failedCapability).digest();
    capabilities.push(failedCapability);digests.push(failedDigest);
    await migrationClient.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
      VALUES($1,'rotamoto',now()+interval '10 minutes')`,[failedDigest]);
    await migrationClient.query(`CREATE FUNCTION rotamoto.test_fail_bootstrap_company() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'injected bootstrap transaction failure' USING ERRCODE='P0001'; END $$`);
    await migrationClient.query(`CREATE TRIGGER test_fail_bootstrap_company BEFORE INSERT ON rotamoto.companies
      FOR EACH ROW EXECUTE FUNCTION rotamoto.test_fail_bootstrap_company()`);
    const failedService=createService(failedDigest,emailProvider,pool);
    await assert.rejects(failedService.provisionInitialOwner({companyName:'Transient Failure',email:'rollback@example.invalid',
      idempotencyKey:`bootstrap-${crypto.randomUUID()}`}),error=>error.code==='P0001');
    await migrationClient.query('DROP TRIGGER test_fail_bootstrap_company ON rotamoto.companies');
    await migrationClient.query('DROP FUNCTION rotamoto.test_fail_bootstrap_company()');
    const rolledBack=await migrationClient.query(`SELECT (SELECT count(*) FROM rotamoto.companies)::int AS companies,
      (SELECT consumed_at FROM rotamoto.bootstrap_authorizations WHERE token_digest=$1) AS consumed,
      (SELECT completed_at FROM rotamoto.installation_bootstrap WHERE singleton=true) AS completed`,[failedDigest]);
    assert.equal(rolledBack.rows[0].companies,0);assert.equal(rolledBack.rows[0].consumed,null);assert.equal(rolledBack.rows[0].completed,null,
      'failure rolls back the capability, owner and installation latch together');

    const raceCapabilities=[crypto.randomBytes(32),crypto.randomBytes(32)];capabilities.push(...raceCapabilities);
    const raceDigests=raceCapabilities.map(value=>crypto.createHash('sha256').update(value).digest());digests.push(...raceDigests);
    for(const digest of raceDigests)await migrationClient.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
      VALUES($1,'rotamoto',now()+interval '10 minutes')`,[digest]);
    const services=raceDigests.map(digest=>createService(digest,emailProvider,pool));
    const inputs=raceDigests.map((_,index)=>({companyName:`Concorrente ${index+1}`,email:`bootstrap-${index+1}@example.invalid`,
      idempotencyKey:`bootstrap-${crypto.randomUUID()}`}));
    const races=await Promise.allSettled(services.map((service,index)=>service.provisionInitialOwner(inputs[index])));
    const winners=races.map((result,index)=>({result,index})).filter(item=>item.result.status==='fulfilled');
    const losers=races.filter(result=>result.status==='rejected');
    assert.equal(winners.length,1,'exactly one concurrent first-owner transaction claims the installation');
    assert.equal(losers.length,1);assert.equal(losers[0].reason.code,'PROVISIONER_UNAUTHORIZED');
    assert.equal(winners[0].result.value.delivery,'failed','remote delivery failure does not roll back the valid committed local owner');
    const firstCompany=winners[0].result.value.companyId,index=winners[0].index;
    await migrationClient.query("SELECT set_config('app.tenant_id',$1,false)",[firstCompany]);
    const counts=await migrationClient.query(`SELECT (SELECT count(*) FROM rotamoto.companies WHERE id=$1)::int AS companies,
      (SELECT count(*) FROM rotamoto.users WHERE id=$2)::int AS users,
      (SELECT count(*) FROM rotamoto.memberships WHERE company_id=$1 AND user_id=$2)::int AS memberships`,[firstCompany,winners[0].result.value.userId]);
    assert.equal(counts.rows[0].companies,1);assert.equal(counts.rows[0].users,1);assert.equal(counts.rows[0].memberships,1);
    const retry=await services[index].provisionInitialOwner(inputs[index]);
    assert.equal(retry.delivery,'sent','retry recovers the same committed invitation after delivery interruption');
    assert.equal(retry.replayed,true);assert.equal(issued.length,1);
    const replay=await services[index].provisionInitialOwner(inputs[index]);
    assert.equal(replay.replayed,true);assert.equal(emailAttempt,2,'replay does not duplicate a successfully delivered invitation');
    await assert.rejects(services[1-index].provisionInitialOwner({...inputs[1-index],email:'another@example.invalid'}),
      error=>error.code==='PROVISIONER_UNAUTHORIZED','the unused concurrent authorization cannot create another owner');
    const final=await migrationClient.query(`SELECT count(*)::int AS companies FROM rotamoto.companies WHERE id=$1`,[firstCompany]);
    assert.equal(final.rows[0].companies,1);

    const secretValues=new Map();
    const secretProvider={async put({value}){const secretRef=`test-secret:${crypto.randomUUID()}`;secretValues.set(secretRef,value);return{secretRef}},
      async get(secretRef){if(!secretValues.has(secretRef))throw new Error('synthetic secret not found');return secretValues.get(secretRef)},
      async remove(secretRef){secretValues.delete(secretRef)}};
    const fullIdentity=createIdentityService({pool,emailProvider,secretProvider,mfaProvider:createNativeMfaProvider({secretProvider})});
    const ownerPassword='synthetic-owner-password-0234';
    const activation=await fullIdentity.consumeOwnerInvitation({token:issued[0].token,password:ownerPassword});
    const firstLogin=await fullIdentity.authenticate(inputs[index].email,ownerPassword,firstCompany);
    assert.equal(firstLogin.mfaEnrollmentRequired,true,'first login is restricted to enrollment until a factor is confirmed');
    const enrollment=await fullIdentity.startMfaEnrollment(firstLogin.sessionToken);
    const totp=codeAt(enrollment.secret,Math.floor(Date.now()/30000));
    const enrolled=await fullIdentity.confirmMfaEnrollment(firstLogin.sessionToken,totp);
    assert.equal(enrolled.recoveryCodes.length,10,'MFA enrollment issues one-time recovery codes');
    const liveCode=codeAt(enrollment.secret,Math.floor(Date.now()/30000)+1);
    const mfaLogin=await fullIdentity.authenticate(inputs[index].email,ownerPassword,firstCompany,liveCode);
    assert.equal(Boolean(mfaLogin.sessionToken),true,'real TOTP provider completes login');
    await assert.rejects(fullIdentity.authenticate(inputs[index].email,ownerPassword,firstCompany,liveCode),
      error=>['MFA_REQUIRED','RATE_LIMITED'].includes(error.code),'TOTP replay cannot establish a second session');
    const recoveryLogin=await fullIdentity.authenticate(inputs[index].email,ownerPassword,firstCompany,enrolled.recoveryCodes[0]);
    assert.equal(Boolean(recoveryLogin.sessionToken),true,'a recovery code is accepted once');
    await assert.rejects(fullIdentity.authenticate(inputs[index].email,ownerPassword,firstCompany,enrolled.recoveryCodes[0]),
      error=>['MFA_REQUIRED','RATE_LIMITED'].includes(error.code),'recovery code replay is rejected');
    assert.equal(await fullIdentity.revokeSession(recoveryLogin.sessionToken),true,'logout revokes the authenticated session');

    await fullIdentity.requestMfaRecovery({email:inputs[index].email,password:ownerPassword,companyId:firstCompany});
    const mfaChallenge=issued.at(-1);assert.equal(mfaChallenge.kind,'mfa_recovery');
    const request=await fullIdentity.confirmMfaRecoveryChallenge({token:mfaChallenge.token});
    const soleOwnerRecovery=createIdentityService({pool,secretProvider,
      authorizeMfaRecoveryOperator:async()=>({actorRef:'test:sole-owner-local-operator'})});
    const reset=await soleOwnerRecovery.approveSoleOwnerMfaRecoveryLocally(request.requestId);
    assert.deepEqual(reset,{completed:true,reenrollmentRequired:true});
    assert.equal(secretValues.size,0,'recovery removes the compromised MFA secret from the test keystore');
    const reenrollmentLogin=await fullIdentity.authenticate(inputs[index].email,ownerPassword,firstCompany);
    assert.equal(reenrollmentLogin.mfaEnrollmentRequired,true,'recovered owner must enroll a new factor before administration');
    const nextEnrollment=await fullIdentity.startMfaEnrollment(reenrollmentLogin.sessionToken);
    const nextCodes=await fullIdentity.confirmMfaEnrollment(reenrollmentLogin.sessionToken,
      codeAt(nextEnrollment.secret,Math.floor(Date.now()/30000)));
    assert.equal(nextCodes.recoveryCodes.length,10,'reenrollment issues a fresh recovery code set');
    assert.equal(activation.companyId,firstCompany);
    console.log('bootstrap disposable PostgreSQL: empty install, rollback, concurrent claim, interrupted delivery retry, invitation, Argon2id, verified email, native TOTP, replay defense, recovery codes, sole-owner recovery and reenrollment PASS');
  }finally{
    await migrationClient.query('DELETE FROM rotamoto.bootstrap_authorizations WHERE token_digest=ANY($1::bytea[])',[digests]).catch(()=>{});
    for(const secret of capabilities)secret.fill(0);for(const digest of digests)digest.fill(0);
    runtimeClient.release();migrationClient.release();await pool.end();await migrator.end();
  }
}
function createService(digest,emailProvider,pool){
  return createIdentityService({pool,emailProvider,requireBootstrapAuthorization:true,
    authorizeProvisioner:async()=>({actorRef:'test:bootstrap-concurrency',bootstrapCapabilityDigest:digest})});
}
main().catch(error=>{console.error(error);process.exitCode=1});
