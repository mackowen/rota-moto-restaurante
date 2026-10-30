'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createClient,createPool}=require('../backend/postgres/connection');
const {assertConnectedIdentity,resolveE2eTargets,storedLoopbackCredential}=require('./e2e-support/guards');
const {runFixtureLifecycle}=require('./e2e-support/fixture-lifecycle');
const {codeAt}=require('../backend/identity/totp');
const targets=resolveE2eTargets();
const connectionString=targets.migrator,database=targets.database||'rotamoto_e2e';
async function founderSnapshot(client){
 await client.query('BEGIN READ ONLY');
 try{const result=await client.query(`SELECT
  (SELECT count(*)::int FROM rotamoto.platform_administrators WHERE revoked_at IS NULL) AS active_grants,
  (SELECT founder_user_id FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true) AS founder_user_id,
  EXISTS(SELECT 1 FROM rotamoto.platform_administrators pa
   JOIN rotamoto.platform_admin_bootstrap_latch latch ON latch.singleton=true AND latch.founder_user_id=pa.user_id
   WHERE pa.revoked_at IS NULL) AS active_grant_matches_founder,
  (SELECT count(*)::int FROM rotamoto.platform_administrators) AS admin_history`);await client.query('COMMIT');return result.rows[0]}
 catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}
async function runDisposableHttpSuite(){
 return runFixtureLifecycle({allowedOrigins:['http://127.0.0.1:8083'],businessFixture:true,exercise:async fixture=>{
  const unauthenticated=await fixture.call('/api/platform-admin/settings');assert.equal(unauthenticated.status,401);
  const session=await fixture.call('/api/identity/session',{cookie:fixture.browserSessionCookie});assert.equal(session.status,200);assert.equal(session.body.mfaVerified,true);
  for(const path of ['/api/platform-admin/settings','/api/platform-admin/companies','/api/platform-admin/users','/api/platform-admin/memberships']){
   const result=await fixture.call(path,{cookie:fixture.browserSessionCookie});assert.equal(result.status,200,`${path} is authorized only for the authenticated founder`);
  }
  const companies=await fixture.call('/api/platform-admin/companies',{cookie:fixture.browserSessionCookie});
  assert(companies.body.items.some(item=>item.id===fixture.companyId),'bootstrap founder sees the provisioned company through the global endpoint');
  const globalSettings=await fixture.call('/api/platform-admin/settings',{cookie:fixture.browserSessionCookie});
  assert.equal(globalSettings.body.item.platform_admin_mfa_required,true);
  const roleCreate=await fixture.call('/api/admin/roles',{method:'POST',cookie:fixture.browserSessionCookie,csrf:session.body.csrfToken,
   body:{key:`lote1b_${crypto.randomBytes(5).toString('hex')}`,name:'Perfil E2E delegável',description:'Perfil sintético transacional',permissions:['orders.read']}});
  assert.equal(roleCreate.status,201,JSON.stringify(roleCreate.body));
  const roles=await fixture.call(`/api/platform-admin/companies/${fixture.companyId}/roles`,{cookie:fixture.browserSessionCookie});assert.equal(roles.status,200);
  const owner=roles.body.items.find(role=>role.role_key==='owner');assert(owner?.protected,'owner remains protected in the server catalog');
  const updated=await fixture.call(`/api/platform-admin/companies/${fixture.companyId}/roles/${roleCreate.body.id}/permissions`,{
   method:'PATCH',cookie:fixture.browserSessionCookie,csrf:session.body.csrfToken,body:{permissionKeys:['finance.read','finance.manage'],reason:'platform_policy'}});
  assert.equal(updated.status,200,JSON.stringify(updated.body));
  const rolesAfter=await fixture.call(`/api/platform-admin/companies/${fixture.companyId}/roles`,{cookie:fixture.browserSessionCookie});
  assert.deepEqual(rolesAfter.body.items.find(role=>role.id===roleCreate.body.id).permissions,['finance.manage','finance.read']);
  await fixture.runtime.query("SELECT set_config('app.tenant_id',$1,true)",[fixture.companyId]);
  const persisted=await fixture.runtime.query('SELECT permission_key FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2 ORDER BY permission_key',[fixture.companyId,roleCreate.body.id]);
  assert.deepEqual(persisted.rows.map(row=>row.permission_key),['finance.manage','finance.read'],'RBAC changes persist in PostgreSQL and are read back under tenant RLS');
  const ownerEdit=await fixture.call(`/api/platform-admin/companies/${fixture.companyId}/roles/${owner.id}/permissions`,{
   method:'PATCH',cookie:fixture.browserSessionCookie,csrf:session.body.csrfToken,body:{permissionKeys:['orders.read'],reason:'platform_policy'}});
  assert.equal(ownerEdit.status,403,'protected owner grants cannot be edited through HTTP');
  const blockedMfa=await fixture.call(`/api/platform-admin/companies/${fixture.companyId}/roles/${roleCreate.body.id}/permissions`,{
   method:'PATCH',cookie:fixture.browserSessionCookie,csrf:'invalid-csrf',body:{permissionKeys:['finance.read'],reason:'platform_policy'}});
  assert.equal(blockedMfa.status,403,'invalid CSRF cannot change grants');
  const companyBefore=await fixture.call('/api/admin/company',{cookie:fixture.browserSessionCookie});assert.equal(companyBefore.status,200);
  while(Math.floor(Date.now()/30000)<=Number(fixture.browserCredentials.mfaLastCounter||-1))await new Promise(resolve=>setTimeout(resolve,100));
  const secondLogin=await fixture.call('/api/identity/login',{method:'POST',body:{email:fixture.browserCredentials.email,password:fixture.browserCredentials.password,
   companyId:fixture.companyId,mfaCode:codeAt(fixture.browserCredentials.mfaSecret,Math.floor(Date.now()/30000))}});
  assert.equal(secondLogin.status,200,JSON.stringify(secondLogin.body));
  const secondCookie=secondLogin.headers.get('set-cookie').split(';',1)[0];const secondSession=await fixture.call('/api/identity/session',{cookie:secondCookie});
  assert.equal(secondSession.status,200);assert.equal(secondSession.body.mfaVerified,true,'second independent HTTP session also satisfies MFA');
  const revisions=[`Concorrência A ${crypto.randomUUID()}`,`Concorrência B ${crypto.randomUUID()}`];
  const concurrent=await Promise.all(revisions.map((name,index)=>fixture.call('/api/admin/company/profile',{method:'PUT',
   cookie:index===0?fixture.browserSessionCookie:secondCookie,csrf:index===0?session.body.csrfToken:secondSession.body.csrfToken,
   body:{expectedVersion:companyBefore.body.settingsVersion,name,supportPhone:companyBefore.body.supportPhone||null}})));
  assert.deepEqual(concurrent.map(response=>response.status).sort(),[200,409],`same-revision writes across two authenticated sessions must produce one ACK and one conflict; statuses=${concurrent.map(x=>x.status)}`);
  const winner=concurrent.find(response=>response.status===200).body.name;
  const otherRead=await fixture.call('/api/admin/company',{cookie:secondCookie});assert.equal(otherRead.status,200);assert.equal(otherRead.body.name,winner,
   'the second authenticated session reads the single accepted concurrent update');
  const delegated=await fixture.createSyntheticAdminSessions({ownerCookie:fixture.browserSessionCookie,ownerCsrf:session.body.csrfToken,
   labels:['plain'],permissions:['orders.read'],roleName:'Usuário E2E limitado'});
  const denied=await fixture.call('/api/platform-admin/settings',{cookie:delegated[0].cookie});assert.equal(denied.status,403,'company member without global grant cannot access the platform console');
  process.stdout.write('Lote 1B platform HTTP E2E: PASS — native bootstrap/MFA, global read, RBAC write/readback, protected owner, invalid CSRF, two-session revision conflict and limited-user denial; disposable transaction rolled back\\n');
 }}).then(result=>{assert.equal(result.authenticated,true);assert.equal(result.mfaVerified,true);return result});
}
async function main(){
 if(targets.disposableLote1b){await runDisposableHttpSuite();return}
 const pool=createPool({connectionString,password:storedLoopbackCredential('rotamoto_migrator',database),max:1,application_name:'campaign-0304b-platform-admin-test'}),client=await pool.connect();let begun=false;
 try{
 const target=await client.query('SELECT current_database() AS database,session_user AS session_user,current_user AS current_user');
  assert.deepEqual(target.rows[0],{database,session_user:'rotamoto_migrator',current_user:'rotamoto_migrator'});
  const existingGrants=await client.query('SELECT count(*)::int AS n FROM rotamoto.platform_administrators WHERE revoked_at IS NULL');
  if(existingGrants.rows[0].n>0){
   const before=await founderSnapshot(client);
   assert.equal(before.active_grants,1,'persistent E2E has one active global founder grant');
   assert.notEqual(before.founder_user_id,null,'active global founder grant has a claimed founder latch');
   assert.equal(before.active_grant_matches_founder,true,'the active global grant belongs to the latched founder');
   assert.equal(before.admin_history,1,'persistent E2E has no unexpected global-administrator history');
   const runtime=createClient({connectionString:targets.runtime,password:storedLoopbackCredential('rotamoto_app',database)});
   try{
    await runtime.connect();
    await assertConnectedIdentity(runtime,{database,role:'rotamoto_app'});
    await runtime.query('BEGIN');
    try{
     async function denied(sql,label){
      await runtime.query('SAVEPOINT unauthenticated_platform_read');
      try{await assert.rejects(runtime.query(sql),error=>error.code==='42501',label)}
      finally{await runtime.query('ROLLBACK TO SAVEPOINT unauthenticated_platform_read');await runtime.query('RELEASE SAVEPOINT unauthenticated_platform_read')}
     }
     await denied('SELECT rotamoto.platform_admin_list_companies()','global administration is denied without a session-established platform actor');
     await denied("SELECT rotamoto.platform_admin_read_company_financial_summary('00000000-0000-4000-8000-000000000001','2026-10-01','2026-10-02')",
      'global financial summaries remain denied without an authenticated platform context');
    }finally{await runtime.query('ROLLBACK').catch(()=>{})}
   }finally{await runtime.end()}
   const after=await founderSnapshot(client);
   assert.equal(after.founder_user_id===before.founder_user_id&&after.active_grants===before.active_grants&&
    after.active_grant_matches_founder===before.active_grant_matches_founder&&after.admin_history===before.admin_history,true,
    'negative checks preserve the existing founder and global grant');
   process.stdout.write('platform admin PostgreSQL E2E: PARTIAL — persistent-founder safety and unauthenticated global/financial denial PASS; positive MFA-authenticated administration NOT EXECUTED (no legitimate session available)\n');
   return;
  }
  await client.query('BEGIN');begun=true;
  async function rejected(sql,values,code){await client.query('SAVEPOINT expected_rejection');try{await assert.rejects(client.query(sql,values),error=>error.code===code)}finally{await client.query('ROLLBACK TO SAVEPOINT expected_rejection');await client.query('RELEASE SAVEPOINT expected_rejection')}}
  await rejected('SELECT rotamoto.platform_admin_list_companies()',[], '42501');
  const id='02550000-0000-4000-8000-000000000001',email='campaign0255-founder-fixture@example.invalid';
  const company='02550000-0000-4000-8000-000000000010',role='02550000-0000-4000-8000-000000000011',membership='02550000-0000-4000-8000-000000000012';
  const delegatedRole='02550000-0000-4000-8000-000000000013';
  const request=Buffer.alloc(32,0x25);
  await client.query("UPDATE rotamoto.installation_bootstrap SET completed_at=now(),request_digest=$1 WHERE singleton=true",[request]);
  await client.query("SELECT set_config('app.tenant_id',$1,true)",[company]);
  await client.query("INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Synthetic founder company','active')",[company]);
  await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'owner','Proprietário')",[role,company]);
  await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'finance_reader','Leitura financeira')",[delegatedRole,company]);
  await client.query("INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version) VALUES($1,$2,'orders.read',1)",[company,delegatedRole]);
  await client.query("INSERT INTO rotamoto.users(id,email,email_verified_at) VALUES($1,$2,now())",[id,email]);
  await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at) VALUES($1,$2,$3,$4,'active',now())",[membership,company,id,role]);
  await client.query("INSERT INTO rotamoto.provisioning_requests(idempotency_key_digest,request_digest,company_id,user_id,delivery_status) VALUES($1,$2,$3,$4,'sent')",[request,Buffer.alloc(32,0x26),company,id]);
  let grant=await client.query('SELECT rotamoto.platform_admin_bootstrap_founder($1)::text AS id',[email]);assert.equal(grant.rows[0].id,id);
  grant=await client.query('SELECT rotamoto.platform_admin_bootstrap_founder($1)::text AS id',[email]);assert.equal(grant.rows[0].id,id,'same founder bootstrap is idempotent');
  await client.query("INSERT INTO rotamoto.users(id,email,email_verified_at) VALUES('02550000-0000-4000-8000-000000000002','campaign0255-second-founder@example.invalid',now())");
  await rejected("SELECT rotamoto.platform_admin_bootstrap_founder('campaign0255-second-founder@example.invalid')",[], '42501');
  await client.query("SELECT set_config('app.platform_admin_user_id',$1,true)",[id]);
  const settings=await client.query('SELECT rotamoto.platform_admin_get_safe_settings() AS item');
  assert.equal(settings.rows[0].item.platform_admin_mfa_required,true,'platform configuration reports the MFA policy without exposing deployment secrets');
  assert.equal(settings.rows[0].item.tenant_isolation,'company_scoped');
  const roleList=await client.query('SELECT rotamoto.platform_admin_list_company_roles($1) AS items',[company]);
  assert.equal(roleList.rows[0].items.length,2);
  assert.equal(roleList.rows[0].items.find(item=>item.role_key==='owner').protected,true,'owner role is marked as protected');
  await rejected('SELECT rotamoto.platform_admin_set_company_role_permissions($1,$2,$3,$4)',
    [company,role,['orders.read'],'platform_policy'],'42501');
  const assigned=await client.query('SELECT rotamoto.platform_admin_set_company_role_permissions($1,$2,$3,$4) AS item',
    [company,delegatedRole,['finance.read','finance.manage'],'platform_policy']);
  assert.deepEqual(assigned.rows[0].item.permissions,['finance.read','finance.manage'],'global admin can delegate finance grants only to an explicitly selected non-owner role');
  await rejected('SELECT rotamoto.platform_admin_set_company_role_permissions($1,$2,$3,$4)',
    [company,delegatedRole,['finance.manage'],'platform_policy'],'22023');
  await rejected('SELECT rotamoto.platform_admin_set_company_role_permissions($1,$2,$3,$4)',
    [company,delegatedRole,['finance.read'],null],'22023');
  const financial=await client.query("SELECT rotamoto.platform_admin_read_company_financial_summary($1,'2026-10-01T00:00:00Z','2026-10-29T00:00:00Z') AS item",[company]);
  assert.equal(financial.rows[0].item.scope,'aggregate_only');assert.equal(financial.rows[0].item.bank_settlement_verified,false);
  await rejected("SELECT rotamoto.platform_admin_read_company_financial_summary($1,'2026-10-01T00:00:00Z','2027-10-03T00:00:00Z')",[company],'22023');
  const disabled=await client.query("SELECT rotamoto.platform_admin_set_user_disabled('02550000-0000-4000-8000-000000000002',true,'security_review') AS item");
  assert.equal(disabled.rows[0].item.disabled,true,'an authenticated global actor can disable a different user through the audited function');
  await rejected("SELECT rotamoto.platform_admin_set_user_disabled($1,true,'security_review')",[id],'42501');
  const enabled=await client.query("SELECT rotamoto.platform_admin_set_user_disabled('02550000-0000-4000-8000-000000000002',false,'owner_request') AS item");
  assert.equal(enabled.rows[0].item.disabled,false,'an authenticated global actor can re-enable a different user through the audited function');
  const [companies,users,memberships,audit]=await Promise.all([
   client.query('SELECT jsonb_array_length(rotamoto.platform_admin_list_companies())::int AS n'),
   client.query("SELECT bool_or((item->>'platform_admin')::boolean) AS found FROM jsonb_array_elements(rotamoto.platform_admin_list_users()) item WHERE item->>'id'=$1",[id]),
   client.query('SELECT jsonb_array_length(rotamoto.platform_admin_list_memberships())::int AS n'),
   client.query("SELECT count(*)::int AS n FROM rotamoto.platform_admin_audit_log WHERE actor_kind='local_operator' AND resource_id=$1",[id])
  ]);
  assert.ok(companies.rows[0].n>=0);assert.equal(users.rows[0].found,true);assert.ok(memberships.rows[0].n>=0);assert.equal(audit.rows[0].n,1);
  const execute=await client.query("SELECT has_function_privilege('rotamoto_app','rotamoto.platform_admin_bootstrap_founder(text)','EXECUTE') AS allowed");assert.equal(execute.rows[0].allowed,false);
  await client.query('ROLLBACK');begun=false;
  process.stdout.write('platform admin PostgreSQL E2E: synthetic bootstrap/latch, audited read/disable/enable, self-disable denial and runtime grant boundary PASS (transaction rolled back)\n');
 }finally{if(begun)await client.query('ROLLBACK').catch(()=>{});client.release();await pool.end()}
}
main().catch(error=>{process.stderr.write(`platform admin PostgreSQL E2E FAIL: ${error.stack||error.code||error.message}\n`);process.exitCode=1});
