'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
process.env.FOOD99_WEBHOOK_SECRET='test-99-secret';
process.env.KEETA_WEBHOOK_SECRET='test-keeta-secret';
process.env.ALLOWED_ORIGIN='http://localhost:8787';
const http=require('node:http');
const {route,rememberWebhook,assertLoopbackHost,runtimeDatabaseConnectionString}=require('../server');
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
  assert.throws(()=>runtimeDatabaseConnectionString('postgresql://rotamoto_app@192.0.2.1:5432/rotamoto'),
    /DATABASE_URL deve apontar sem senha para rotamoto_app/);
  const exposedBoot=spawnSync(process.execPath,['server.js'],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,HOST:'0.0.0.0'},encoding:'utf8'});
  assert.notEqual(exposedBoot.status,0,'server refuses to start on a public interface without user authentication');
  assert.match(exposedBoot.stderr,/mantenha HOST em loopback/);
  const server=http.createServer(route);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const request=(path,options={})=>fetch(base+path,options);
    const live=await request('/health/live');
    assert.equal(live.status,200);
    assert.equal((await live.json()).status,'live');
    assert.match(live.headers.get('x-request-id'),/^[0-9a-f-]{36}$/iu);
    const ready=await request('/health/ready');
    assert.equal(ready.status,200,'readiness confirms the runtime PostgreSQL connection and schema');
    assert.equal((await ready.json()).dependencies.postgres,'ready');
    const preflight=await request('/api/sync/push',{method:'OPTIONS',headers:{Origin:'http://localhost:8787',
      'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type,x-csrf-token'}});
    assert.equal(preflight.status,204,'CORS preflight is handled before route-specific method checks');
    assert.equal(preflight.headers.get('access-control-allow-credentials'),'true');
    assert(preflight.headers.get('access-control-allow-headers').includes('X-CSRF-Token'));
  const signed=(secret,body)=>crypto.createHmac('sha256',secret).update(body).digest('hex');
  const keetaSig=(url,payload,secret='test-keeta-secret')=>{const params=Object.keys(payload).filter(k=>k!=='sig').sort().map(k=>`${k}=${payload[k]===null?'null':typeof payload[k]==='object'?JSON.stringify(payload[k]):String(payload[k])}`).join('&');return crypto.createHash('sha256').update(`${url}?${params}${secret}`,'utf8').digest('hex')};
  try{
    assert.equal((await request('/api/99food/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{"id":"a"}'})).status,401,'unsigned 99Food webhook is rejected');
    const body99='{"id":"evt-99","order":{"id":"order-1"}}';
    const headers99={'content-type':'application/json','x-99food-signature':signed('test-99-secret',body99)};
    assert.equal((await request('/api/99food/webhook',{method:'POST',headers:headers99,body:body99})).status,202,'signed event accepted');
    const duplicate99=await request('/api/99food/webhook',{method:'POST',headers:headers99,body:body99});
    assert.equal(duplicate99.status,200);assert.equal((await duplicate99.json()).duplicate,true,'replay deduplicated');
    const keetaUrl=base+'/api/keeta/webhook';
    const payloadKeeta={eventId:1001,appId:123456,messageId:'evt-k',shopId:77,message:'{}',timestamp:1700000000};
    const bodyKeeta=JSON.stringify({...payloadKeeta,sig:keetaSig(keetaUrl,payloadKeeta)});
    const headersKeeta={'content-type':'application/json'};
    assert.equal((await request('/api/keeta/webhook',{method:'POST',headers:headersKeeta,body:bodyKeeta})).status,200,'sig field and numeric eventId accepted per Keeta contract');
    const heartbeat=await request('/api/keeta/webhook',{method:'POST',headers:headersKeeta,body:''});
    assert.equal(heartbeat.status,200,'empty heartbeat accepted');assert.equal((await heartbeat.json()).code,0);
    const badKeeta={...payloadKeeta,sig:'0'.repeat(64)};
    assert.equal((await request('/api/keeta/webhook',{method:'POST',headers:headersKeeta,body:JSON.stringify(badKeeta)})).status,401,'invalid Keeta payload signature rejected');
    assert.equal((await request('/api/keeta/webhook',{method:'POST',headers:headersKeeta,body:'{' })).status,400,'invalid JSON rejected');
    const malformedKeeta={messageId:'no-event-id',sig:'0'.repeat(64)};
    assert.equal((await request('/api/keeta/webhook',{method:'POST',headers:headersKeeta,body:JSON.stringify(malformedKeeta)})).status,400,'structurally invalid payload rejected');
    assert.equal((await request('/api/99food/webhook',{method:'POST',headers:{...headers99,'x-99food-signature':'bad'},body:body99})).status,401,'malformed signature is rejected safely');
    assert.equal((await request('/api/keeta/webhook',{method:'POST',headers:{...headersKeeta,'content-type':'text/plain'},body:bodyKeeta})).status,415,'unsupported webhook media type rejected');
    const oversized=await request('/api/keeta/webhook',{method:'POST',headers:headersKeeta,body:JSON.stringify({payload:'x'.repeat(1024*1024)})});
    assert.equal(oversized.status,413,'oversized payload receives an HTTP 413 response');
    const forbidden=await request('/api/ifood/status',{headers:{origin:'https://attacker.example'}});
    assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('access-control-allow-origin'),null,'untrusted origins receive no CORS access');
    const sameOrigin=await request('/api/ifood/status',{headers:{origin:'http://localhost:8787'}});
    assert.equal(sameOrigin.status,200,'configured same-origin panel requests continue to work');assert.equal(sameOrigin.headers.get('access-control-allow-origin'),'http://localhost:8787');
    for(let i=0;i<10001;i++)rememberWebhook('fifo-test',`id-${i}`);
    assert.equal(rememberWebhook('fifo-test','id-0'),true,'oldest id is evicted when the 10,000-entry FIFO limit is exceeded');
    assert.equal((await request('/health',{method:'DELETE'})).status,405,'unsupported method rejected');
    const internal=await request('/api/ifood/auth/refresh',{method:'POST'});
    assert.equal(internal.status,500);assert.equal((await internal.json()).message,'Falha interna ao processar a integração.','internal details are hidden');
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
  const savedSecret=process.env.KEETA_WEBHOOK_SECRET;
  delete process.env.KEETA_WEBHOOK_SECRET;
  delete require.cache[require.resolve('../server')];
  const unconfiguredRoute=require('../server').route;
  const unconfigured=http.createServer(unconfiguredRoute);
  await new Promise(resolve=>unconfigured.listen(0,'127.0.0.1',resolve));
  try{const response=await fetch(`http://127.0.0.1:${unconfigured.address().port}/api/keeta/webhook`,{method:'POST',headers:{'content-type':'application/json'},body:'{"eventId":1001,"messageId":"x","sig":"x"}'});assert.equal(response.status,503,'missing Keeta secret is reported as unconfigured')}finally{await new Promise((resolve,reject)=>unconfigured.close(e=>e?reject(e):resolve()));if(savedSecret!==undefined)process.env.KEETA_WEBHOOK_SECRET=savedSecret;delete require.cache[require.resolve('../server')];}
  console.log('server security tests: OK');
}
main().catch(e=>{console.error(e);process.exitCode=1});
