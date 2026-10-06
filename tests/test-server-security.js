'use strict';
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
process.env.ALLOWED_ORIGIN='http://localhost:8787';
const http=require('node:http');
const {route,assertLoopbackHost,runtimeDatabaseConnectionString,databaseReadiness,CONFIG}=require('../server');
const {hostAllowed}=require('../backend/runtime/config');
const {createSyncHttpHandler}=require('../backend/domain/sync-http');
const {createIdentityHttpHandler}=require('../backend/identity/http');

async function main(){
  assert.equal(assertLoopbackHost('127.0.0.1'),true);
  assert.equal(assertLoopbackHost('::1'),true);
  assert.equal(assertLoopbackHost('localhost'),true);
  assert.throws(()=>assertLoopbackHost('0.0.0.0'),/não possui autenticação de usuário/);
  assert.throws(()=>assertLoopbackHost('192.168.1.20'),/mantenha HOST em loopback/);
  assert.equal(runtimeDatabaseConnectionString('postgresql://rotamoto_app@127.0.0.1:5432/rotamoto'),
    'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto');
  assert.throws(()=>runtimeDatabaseConnectionString('postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto'),
    /DATABASE_URL deve apontar sem senha para rotamoto_app/);
  assert.equal(runtimeDatabaseConnectionString('postgresql://rotamoto_app@db.internal:5432/rotamoto'),
    'postgresql://rotamoto_app@db.internal:5432/rotamoto');
  assert.equal(CONFIG.trustProxy,false,'forwarded headers are not trusted');
  const readinessResult=values=>({async connect(){return{async query(sql){if(sql==='BEGIN'||sql==='COMMIT'||sql.startsWith('SET LOCAL'))return{rows:[]};return{rows:[values]};},release(){}};}});
  const readySchema={role:'rotamoto_app',domain_ready:true,sync_installations_ready:true,mfa_schema_ready:true,
    membership_driver_ready:true,logistics_schema_ready:true,territorial_analytics_schema_ready:true};
  assert.equal(await databaseReadiness(readinessResult({...readySchema,territorial_analytics_schema_ready:false})),false,
    'readiness stays fail-closed if any required schema capability is absent');
  assert.equal(await databaseReadiness(readinessResult(readySchema)),true,'readiness accepts the full required schema');
  assert.equal(hostAllowed('attacker.example',CONFIG.allowedHosts,false),false,'unlisted Host is rejected before routing');
  const exposedBoot=spawnSync(process.execPath,['server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,NODE_ENV:'development',HOST:'0.0.0.0'},encoding:'utf8'});
  assert.notEqual(exposedBoot.status,0,'server refuses to start on a public interface without user authentication');
  assert.match(exposedBoot.stderr,/http\.bootstrap_failed/u);
  const productionBoot=spawnSync(process.execPath,['server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{NODE_ENV:'production'},encoding:'utf8'});
  assert.notEqual(productionBoot.status,0,'production server refuses to start without explicit configuration');
  assert.match(productionBoot.stderr,/http\.bootstrap_failed/u);
  assert.doesNotMatch(productionBoot.stderr,/server\.js:\d+|Error:/u,'bootstrap logs do not expose paths or stack traces');
  const server=http.createServer(route);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const request=(path,options={})=>fetch(base+path,options);
    const invalidHost=await new Promise((resolve,reject)=>{const outgoing=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/health/live',headers:{Host:'attacker.example'}},response=>{response.resume();resolve(response.statusCode)});outgoing.on('error',reject);outgoing.end()});
    assert.equal(invalidHost,421,'server rejects requests with an unlisted Host header');
    const live=await request('/health/live');
    assert.equal(live.status,200);
    assert.equal((await live.json()).status,'live');
    assert.match(live.headers.get('x-request-id'),/^[0-9a-f-]{36}$/iu);
    assert.equal(live.headers.get('x-content-type-options'),'nosniff');
    assert.equal(live.headers.get('x-frame-options'),'DENY');
    assert.equal(live.headers.get('content-security-policy'),"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    assert.equal(live.headers.get('strict-transport-security'),null,'development does not assert TLS');
    const ready=await request('/health/ready');
    assert([200,503].includes(ready.status),'readiness reports either current schema state without assuming an old deployment');
    const readyBody=await ready.json();
    assert.equal(readyBody.status,ready.status===200?'ready':'not_ready');
    assert.equal(readyBody.dependencies.postgres,ready.status===200?'ready':'unavailable');
    const preflight=await request('/api/sync/push',{method:'OPTIONS',headers:{Origin:'http://localhost:8787',
      'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-csrf-token'}});
    assert.equal(preflight.status,204,'CORS preflight is handled before route-specific method checks');
    assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
    assert(preflight.headers.get('access-control-allow-headers').includes('X-CSRF-Token'));
  try{
    const forbidden=await request('/api/ifood/status',{headers:{origin:'https://attacker.example'}});
    assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('access-control-allow-origin'),null,'untrusted origins receive no CORS access');
    const sameOrigin=await request('/api/ifood/status',{headers:{origin:'http://localhost:8787'}});
    assert.equal(sameOrigin.status,503,'same-origin requests cannot call an unverified provider adapter');
    assert.equal((await sameOrigin.json()).error.code,'PROVIDER_BLOCKED_EXTERNAL');
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'),'http://localhost:8787');
    for (const [path,method] of [['/api/99food/orders','GET'],['/api/99food/webhook','POST'],['/api/keeta/events/poll','GET'],['/api/keeta/webhook','POST'],['/api/ifood/auth/exchange','POST']]) {
      const response=await request(path,{method,headers:{Origin:'http://localhost:8787','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
      assert.equal(response.status,503,`${path} stays fail-closed until provider protocol is verified`);
      assert.equal((await response.json()).error.code,'PROVIDER_BLOCKED_EXTERNAL');
    }
    assert.equal((await request('/health',{method:'DELETE'})).status,405,'unsupported method rejected');
    const internal=await request('/api/ifood/auth/refresh',{method:'POST'});
    assert.equal(internal.status,503);assert.equal((await internal.json()).error.message,'A integração externa ainda não foi validada e habilitada.');
  } finally {await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  const fakeSession=http.createServer(createSyncHttpHandler({allowedOrigin:'http://app.example',
    identityService:{async withAuthenticatedTenant(_token,operation){return operation({}, {session_id:'session'});},async verifyCsrf(){return true;}},
    syncService:{async push(){return {accepted:1};}}}));
  await new Promise(resolve=>fakeSession.listen(0,'127.0.0.1',resolve));
  try{
    const target=`http://127.0.0.1:${fakeSession.address().port}/api/sync/push`;
    const allowed=await fetch(target,{method:'POST',headers:{Origin:'http://app.example',Host:`127.0.0.1:${fakeSession.address().port}`,
      Cookie:'__Host-rotamoto_session='+'a'.repeat(43),'X-CSRF-Token':'synthetic-csrf','Content-Type':'application/json'},body:'{}'});
    assert.equal(allowed.status,200,'configured frontend origin passes sync origin and CSRF checks');
    const blocked=await fetch(target,{method:'POST',headers:{Origin:'http://attacker.example',Host:`127.0.0.1:${fakeSession.address().port}`,
      Cookie:'__Host-rotamoto_session='+'a'.repeat(43),'X-CSRF-Token':'synthetic-csrf','Content-Type':'application/json'},body:'{}'});
    assert.equal(blocked.status,403,'unconfigured frontend origin is still rejected');
  }finally{await new Promise((resolve,reject)=>fakeSession.close(e=>e?reject(e):resolve()));}
  const fakeIdentity=http.createServer(createIdentityHttpHandler({allowedOrigin:'http://app.example',identityService:{
    async authenticate(){return {userId:'user-id',companyId:'company-id',csrfToken:'synthetic-csrf',sessionToken:'s'.repeat(43),maxAgeSeconds:1800};}
  }}));
  await new Promise(resolve=>fakeIdentity.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${fakeIdentity.address().port}/api/identity/login`,{method:'POST',
      headers:{Origin:'http://app.example',Host:`127.0.0.1:${fakeIdentity.address().port}`,'Content-Type':'application/json'},
      body:JSON.stringify({email:'person@example.invalid',password:'synthetic-password',companyId:'company-id'})});
    assert.equal(response.status,200,'identity POST accepts exactly the configured frontend origin');
    assert.match(response.headers.get('set-cookie'),/HttpOnly/u);
    const blocked=await fetch(`http://127.0.0.1:${fakeIdentity.address().port}/api/identity/login`,{method:'POST',
      headers:{Origin:'http://attacker.example','Content-Type':'application/json'},
      body:JSON.stringify({email:'person@example.invalid',password:'synthetic-password',companyId:'company-id'})});
    assert.equal(blocked.status,403,'identity POST rejects an origin outside the configured allowlist');
  }finally{await new Promise((resolve,reject)=>fakeIdentity.close(e=>e?reject(e):resolve()));}
  console.log('server security tests: OK');
}
main().catch(e=>{console.error(e);process.exitCode=1});
