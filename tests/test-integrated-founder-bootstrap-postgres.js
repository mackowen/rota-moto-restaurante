'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createPool}=require('../backend/postgres/connection');
const {resolveE2eTargets,assertConnectedIdentity}=require('./e2e-support/guards');

async function main(){
  assert.equal(process.env.NODE_ENV,'test');
  const targets=resolveE2eTargets(process.env);
  const pool=createPool({connectionString:targets.runtime,max:1,connectionTimeoutMillis:3000});
  const verifierPool=createPool({connectionString:targets.migrator,max:1,connectionTimeoutMillis:3000});
  const client=await pool.connect(),verifier=await verifierPool.connect();
  try{
    await assertConnectedIdentity(client,{database:'rotamoto_e2e',role:'rotamoto_app',env:process.env});
    await assertConnectedIdentity(verifier,{database:'rotamoto_e2e',role:'rotamoto_migrator',env:process.env});
    await verifier.query('BEGIN READ ONLY');
    const prior=await verifier.query(`SELECT
      (SELECT count(*)::int FROM rotamoto.platform_administrators WHERE revoked_at IS NULL) AS active_grants,
      (SELECT founder_user_id FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true) AS founder_user_id,
      EXISTS(SELECT 1 FROM rotamoto.platform_administrators pa
        JOIN rotamoto.platform_admin_bootstrap_latch latch ON latch.singleton=true AND latch.founder_user_id=pa.user_id
        WHERE pa.revoked_at IS NULL) AS active_grant_matches_founder,
      (SELECT completed_at IS NOT NULL FROM rotamoto.installation_bootstrap WHERE singleton=true) AS installation_complete`);
    await verifier.query('COMMIT');
    if(prior.rows[0].founder_user_id!==null){
      assert.equal(prior.rows[0].active_grants,1,'the existing founder remains the sole active global administrator');
      assert.equal(prior.rows[0].active_grant_matches_founder,true,'the active global grant belongs to the latched founder');
      assert.equal(prior.rows[0].installation_complete,true,'the persistent founder bootstrap remains complete');
      process.stdout.write('integrated founder bootstrap PostgreSQL E2E: NOT EXECUTED — first-claim/idempotency branch requires an actually empty installation; persistent-founder safety preflight PASS and no state reset attempted\n');
      return;
    }
    if(prior.rows[0].active_grants!==0||prior.rows[0].installation_complete){
      process.stdout.write('integrated founder bootstrap PostgreSQL E2E: BLOCKED — inconsistent or legacy installation state preserved; no latch reset attempted\n');
      return;
    }
    await client.query('BEGIN');
    const company=crypto.randomUUID(),role=crypto.randomUUID(),user=crypto.randomUUID(),member=crypto.randomUUID();
    const request=crypto.randomBytes(32),capability=crypto.randomBytes(32),otherRequest=crypto.randomBytes(32);
    const email=`q-bootstrap-${crypto.randomUUID()}@example.invalid`;
    const latchSet=await client.query("UPDATE rotamoto.installation_bootstrap SET completed_at=now(),request_digest=$1 WHERE singleton=true RETURNING encode(request_digest,'hex') AS digest",[request]);assert.equal(latchSet.rows[0]?.digest,request.toString('hex'),'test sets the synthetic installation latch inside its rollback transaction');
    await client.query("INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at,consumed_at) VALUES($1,'rotamoto',now()+interval '10 minutes',now())",[capability]);
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[company]);
    await client.query("INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Q synthetic founder','provisioning')",[company]);
    await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'owner','Proprietário')",[role,company]);
    await client.query("INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version) VALUES($1,$2,'company.manage',1)",[company,role]);
    await client.query("INSERT INTO rotamoto.users(id,email) VALUES($1,$2)",[user,email]);
    await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status) VALUES($1,$2,$3,$4,'invited')",[member,company,user,role]);
    await client.query("INSERT INTO rotamoto.provisioning_requests(idempotency_key_digest,request_digest,company_id,user_id,delivery_status) VALUES($1,$2,$3,$4,'pending')",[request,crypto.randomBytes(32),company,user]);
    const inputCheck=await client.query("SELECT encode(request_digest,'hex') AS stored,encode($1::bytea,'hex') AS supplied FROM rotamoto.installation_bootstrap WHERE singleton=true",[request]);assert.equal(inputCheck.rows[0]?.stored,inputCheck.rows[0]?.supplied);
    const initial=await client.query('SELECT rotamoto.platform_admin_complete_initial_bootstrap($1,$2,$3,$4)::text AS user_id',[user,company,request,capability]);
    assert.equal(initial.rows[0].user_id,user,'only the owner in the authorized first provisioning request receives the global grant');
    const replay=await client.query('SELECT rotamoto.platform_admin_complete_initial_bootstrap($1,$2,$3,$4)::text AS user_id',[user,company,request,capability]);
    assert.equal(replay.rows[0].user_id,user,'retry is idempotent');
    const active=await client.query('SELECT count(*)::int AS n FROM rotamoto.platform_administrators WHERE revoked_at IS NULL AND grant_kind=\'founder_bootstrap\'');
    assert.equal(active.rows[0].n,1,'replay does not create a second global administrator');
    const secondCompany=crypto.randomUUID(),secondRole=crypto.randomUUID(),secondUser=crypto.randomUUID(),secondMembership=crypto.randomUUID();
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[secondCompany]);
    await client.query("INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Q second owner','provisioning')",[secondCompany]);
    await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'owner','Proprietário')",[secondRole,secondCompany]);
    await client.query("INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version) VALUES($1,$2,'company.manage',1)",[secondCompany,secondRole]);
    await client.query("INSERT INTO rotamoto.users(id,email) VALUES($1,$2)",[secondUser,`q-second-${crypto.randomUUID()}@example.invalid`]);
    await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status) VALUES($1,$2,$3,$4,'invited')",[secondMembership,secondCompany,secondUser,secondRole]);
    await client.query("INSERT INTO rotamoto.provisioning_requests(idempotency_key_digest,request_digest,company_id,user_id,delivery_status) VALUES($1,$2,$3,$4,'pending')",[otherRequest,crypto.randomBytes(32),secondCompany,secondUser]);
    await client.query('SAVEPOINT second_owner_claim');
    await assert.rejects(client.query('SELECT rotamoto.platform_admin_complete_initial_bootstrap($1,$2,$3,$4)',[secondUser,secondCompany,otherRequest,capability]),error=>error.code==='55000',
      'a second eligible tenant owner cannot claim global administration');
    await client.query('ROLLBACK TO SAVEPOINT second_owner_claim');await client.query('RELEASE SAVEPOINT second_owner_claim');
    const current=await client.query('SELECT count(*)::int AS n FROM rotamoto.platform_administrators WHERE revoked_at IS NULL');
    assert.equal(current.rows[0].n,1,'failed second claim leaves the original grant unchanged');
    await client.query('ROLLBACK');
    process.stdout.write('integrated founder bootstrap PostgreSQL E2E: tenant owner, consumed authorization, atomic grant, idempotent replay, second-owner denial and RLS-scoped writes PASS (transaction rolled back)\n');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
  finally{client.release();verifier.release();await pool.end();await verifierPool.end()}
}
main().catch(error=>{process.stderr.write(`integrated founder bootstrap E2E FAIL: ${error.code||'ERROR'} ${error.message} ${error.detail||''}\n`);process.exitCode=1});
