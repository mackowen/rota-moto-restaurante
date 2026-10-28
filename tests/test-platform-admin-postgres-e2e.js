'use strict';
const assert=require('node:assert/strict');
const {Pool}=require('pg');
const connectionString=process.env.E2E_MIGRATOR_DATABASE_URL;
if(process.env.NODE_ENV!=='test'||!connectionString||new URL(connectionString).pathname!=='/rotamoto_e2e'||new URL(connectionString).username!=='rotamoto_migrator'||new URL(connectionString).hostname!=='127.0.0.1')throw new Error('Requires explicit loopback E2E migrator connection.');
async function main(){
 const pool=new Pool({connectionString,max:1,application_name:'campaign-0255-platform-admin-test'}),client=await pool.connect();let begun=false;
 try{
  const target=await client.query('SELECT current_database() AS database,session_user AS session_user,current_user AS current_user');
  assert.deepEqual(target.rows[0],{database:'rotamoto_e2e',session_user:'rotamoto_migrator',current_user:'rotamoto_migrator'});
  const existingGrants=await client.query('SELECT count(*)::int AS n FROM rotamoto.platform_administrators WHERE revoked_at IS NULL');
  assert.equal(existingGrants.rows[0].n,0,'the E2E target has no pre-existing persistent global administrator');
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
