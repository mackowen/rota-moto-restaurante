'use strict';
const assert=require('node:assert/strict');
const {createPlatformAdminHttpHandler}=require('../backend/admin/platform-http');
const {resolveTarget}=require('../scripts/bootstrap-platform-founder');
function response(){return{status:null,body:null,writeHead(status){this.status=status},end(text){this.body=JSON.parse(text)}}}
async function invoke(handler,{method='GET',url='/api/platform-admin/companies',body,token='S'.repeat(43),csrf='csrf-e2e',origin='https://app.example.test'}={}){
 const req={method,url,requestId:'campaign-0255-test',headers:{cookie:`__Host-rotamoto_session=${token}`,host:'app.example.test',origin,'content-type':'application/json','x-csrf-token':csrf},socket:{encrypted:true},async *[Symbol.asyncIterator](){if(body!==undefined)yield Buffer.from(JSON.stringify(body))}};
 const res=response();assert.equal(await handler(req,res),true);return res
}
async function main(){
 assert.equal(resolveTarget({NODE_ENV:'test',ROTAMOTO_E2E_CAMPAIGN:'0255',E2E_MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e'}).database,'rotamoto_e2e');
 for(const env of [
  {NODE_ENV:'test',ROTAMOTO_E2E_CAMPAIGN:'0255',E2E_MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto'},
  {NODE_ENV:'test',ROTAMOTO_E2E_CAMPAIGN:'0243',E2E_MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e'},
  {NODE_ENV:'production',MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto'},
  {NODE_ENV:'production',ROTAMOTO_PLATFORM_FOUNDER_BOOTSTRAP:'0255',ROTAMOTO_PLATFORM_CONFIRM_DATABASE:'rotamoto',MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator:secret@127.0.0.1:5432/rotamoto'}
 ])assert.throws(()=>resolveTarget(env));
 assert.equal(resolveTarget({NODE_ENV:'production',ROTAMOTO_PLATFORM_FOUNDER_BOOTSTRAP:'0255',ROTAMOTO_PLATFORM_CONFIRM_DATABASE:'rotamoto',MIGRATOR_DATABASE_URL:'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto'}).database,'rotamoto','production target can only be selected by explicit operator flags; this test does not execute it');
 let admin=true,mfa=true,csrfValid=true;const calls=[];
 const identityService={async withAuthenticatedTenant(_token,operation){const client={async query(sql,values){calls.push({sql,values});if(sql.includes('EXISTS(SELECT 1 FROM rotamoto.platform_administrators'))return{rows:[{active:admin}]};if(sql.includes('verify'))return{rows:[{valid:csrfValid}]};if(sql.includes('set_config'))return{rows:[{}]};if(sql.includes('platform_admin_list_companies'))return{rows:[{items:[{id:'company-synthetic',name:'Fixture',status:'active',memberCount:1}]}]};if(sql.includes('platform_admin_set_company_status'))return{rows:[{item:{id:values[0],status:values[1],changed:true}}]};return{rows:[{items:[]}]}}};return operation(client,{user_id:'synthetic-user',session_id:'synthetic-session',mfa_verified_at:mfa?new Date():null})},async verifyCsrf(){return csrfValid}};
 const handler=createPlatformAdminHttpHandler({identityService,allowedOrigin:['https://app.example.test']});
 let result=await invoke(handler,{token:''});assert.equal(result.status,401);assert.equal(result.body.error.code,'UNAUTHENTICATED');
 result=await invoke(handler);assert.equal(result.status,200);assert.equal(result.body.items[0].name,'Fixture');
 assert.ok(calls.some(call=>call.sql.includes('platform_admin_list_companies')));
 admin=false;result=await invoke(handler);assert.equal(result.status,403);assert.equal(result.body.error.code,'FORBIDDEN');admin=true;
 mfa=false;result=await invoke(handler);assert.equal(result.status,403);assert.equal(result.body.error.code,'MFA_REQUIRED');mfa=true;
 csrfValid=false;result=await invoke(handler,{method:'PATCH',url:'/api/platform-admin/companies/00000000-0000-4000-8000-000000000001',body:{status:'suspended',reason:'owner_request'}});assert.equal(result.status,403);assert.equal(result.body.error.code,'CSRF_INVALID');csrfValid=true;
 result=await invoke(handler,{method:'PATCH',url:'/api/platform-admin/companies/00000000-0000-4000-8000-000000000001',body:{status:'suspended',reason:'owner_request',expectedRevision:1}});assert.equal(result.status,400);assert.equal(result.body.error.code,'INVALID_INPUT','unsupported revision fields fail closed instead of pretending to provide conflict control');
 result=await invoke(handler,{method:'PATCH',url:'/api/platform-admin/companies/00000000-0000-4000-8000-000000000001',body:{status:'suspended',reason:'owner_request'},origin:'https://attacker.example'});assert.equal(result.status,403);assert.equal(result.body.error.code,'ORIGIN_INVALID');
 result=await invoke(handler,{method:'PATCH',url:'/api/platform-admin/companies/00000000-0000-4000-8000-000000000001',body:{status:'suspended',reason:'owner_request'}});assert.equal(result.status,200);assert.equal(result.body.item.status,'suspended');
 assert.ok(calls.some(call=>call.sql.includes("set_config('app.platform_admin_user_id'")));
 assert.ok(calls.some(call=>call.sql.includes('platform_admin_set_company_status')));
 result=await invoke(handler,{url:'/api/platform-admin/grants'});assert.equal(result.status,404);assert.equal(result.body.error.code,'NOT_FOUND','grant management is not exposed as an administrative operation');
 const limited=createPlatformAdminHttpHandler({identityService,rateLimiter:{consume:()=>({allowed:false})}});result=await invoke(limited);assert.equal(result.status,429);assert.equal(result.body.error.code,'RATE_LIMITED');
 process.stdout.write('platform admin HTTP: synthetic admin, MFA, tenant-role independence, CSRF and audited command routing PASS\n');
}
main().catch(error=>{process.stderr.write(`platform admin HTTP FAIL: ${error.stack||error}\n`);process.exitCode=1});
