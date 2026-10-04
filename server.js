/*
 * Rota Moto — iFood integration service skeleton
 *
 * Node 18+. This service is intentionally separate from the local-first browser app.
 * NEVER put IFOOD_CLIENT_SECRET or access/refresh tokens in app.js, HTML, IndexedDB,
 * source control, or browser storage.
 */
const http=require('node:http');
const crypto=require('node:crypto');
const {URL}=require('node:url');
const {Pool}=require('pg');
const {create99FoodService}=require('./99food-service');
const {createKeetaService}=require('./keeta-service');
const {createIdentityService}=require('./backend/identity/service');
const {createIdentityHttpHandler}=require('./backend/identity/http');
const {createSyncService}=require('./backend/domain/sync-service');
const {createSyncHttpHandler}=require('./backend/domain/sync-http');
const {createDomainQueryRepository}=require('./backend/domain/query-repository');
const {createDomainQueryService}=require('./backend/domain/query-service');
const {createDomainQueryHttpHandler}=require('./backend/domain/query-http');
const {createAdminRepository}=require('./backend/admin/repository');
const {createAdminService}=require('./backend/admin/service');
const {createAdminHttpHandler}=require('./backend/admin/http');

const PORT=Number(process.env.PORT||8787);
const HOST=process.env.HOST||'127.0.0.1';
const IFOOD_API='https://merchant-api.ifood.com.br';
const CLIENT_ID=process.env.IFOOD_CLIENT_ID||'';
const CLIENT_SECRET=process.env.IFOOD_CLIENT_SECRET||'';
const AUTHORIZATION_CODE_VERIFIER=process.env.IFOOD_AUTHORIZATION_CODE_VERIFIER||'';
const ACCESS_TOKEN=process.env.IFOOD_ACCESS_TOKEN||'';
const REFRESH_TOKEN=process.env.IFOOD_REFRESH_TOKEN||'';
const food99=create99FoodService();
const keeta=createKeetaService();
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||'http://localhost:8787';
const ALLOWED_ORIGINS=Object.freeze([...new Set([ALLOWED_ORIGIN,...String(process.env.ALLOWED_ORIGINS||'').split(',')].map(value=>{try{const parsed=new URL(value.trim());return ['http:','https:'].includes(parsed.protocol)&&parsed.origin===value.trim()?parsed.origin:null}catch(_){return null}}).filter(Boolean))]);
const KEETA_WEBHOOK_SECRET=process.env.KEETA_WEBHOOK_SECRET||'';
const seenWebhooks=new Map();
function runtimeDatabaseConnectionString(value=process.env.DATABASE_URL){
  const connectionString=value||'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto';
  let parsed;
  try{parsed=new URL(connectionString)}catch(_){throw new Error('DATABASE_URL de runtime inválida.')}
  if(!['postgres:','postgresql:'].includes(parsed.protocol)||decodeURIComponent(parsed.username)!=='rotamoto_app'||
    parsed.password||parsed.hostname!=='127.0.0.1'||(parsed.port||'5432')!=='5432'||parsed.pathname!=='/rotamoto')
    throw new Error('DATABASE_URL deve apontar sem senha para rotamoto_app em 127.0.0.1:5432/rotamoto.');
  return connectionString;
}
const identityPool=new Pool({connectionString:runtimeDatabaseConnectionString(),max:5,allowExitOnIdle:true,connectionTimeoutMillis:1500,application_name:'rotamoto-http-runtime'});
identityPool.on('error',error=>console.error(JSON.stringify({event:'postgres.pool.error',code:/^[A-Z0-9_]{2,10}$/u.test(error?.code||'')?error.code:'DATABASE_ERROR'})));
const identityService=createIdentityService({pool:identityPool});
const requestLogger=entry=>console.info(JSON.stringify(entry));
const identityHttp=createIdentityHttpHandler({identityService,logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});
const syncService=createSyncService();
const syncHttp=createSyncHttpHandler({identityService,syncService,logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});
const domainQueryService=createDomainQueryService({repository:createDomainQueryRepository()});
const domainQueryHttp=createDomainQueryHttpHandler({identityService,queryService:domainQueryService,logger:()=>{}});
const adminService=createAdminService({repository:createAdminRepository()});
const adminHttp=createAdminHttpHandler({identityService,adminService,logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});

const state={
  integration:{provider:'ifood',status:CLIENT_ID&&CLIENT_SECRET?'configured':'not_configured',lastPollAt:null,lastSuccessAt:null,lastError:null},
  token:{accessToken:ACCESS_TOKEN,refreshToken:REFRESH_TOKEN,expiresAt:Number(process.env.IFOOD_ACCESS_TOKEN_EXPIRES_AT||0)},
  merchants:[],
  events:new Map(),
  orders:new Map()
};

function json(res,status,payload){const body=JSON.stringify(payload),origin=res.req?.headers.origin;const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin',...(res.req?.requestId?{'X-Request-ID':res.req.requestId}:{})};if(ALLOWED_ORIGINS.includes(origin)){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Credentials']='true'}res.writeHead(status,headers);res.end(body)}
function assertLoopbackHost(host=HOST){const value=String(host).toLowerCase().replace(/^\[|\]$/g,'');if(!['127.0.0.1','::1','localhost'].includes(value))throw new Error('O servidor de integrações não possui autenticação de usuário; mantenha HOST em loopback e exponha acesso remoto somente por um proxy autenticado que encaminhe para loopback.');return true}
function readRawBody(req){return new Promise((resolve,reject)=>{let chunks=[],size=0,settled=false;req.on('data',c=>{if(settled)return;size+=c.length;if(size>1024*1024){settled=true;const err=new Error('Payload too large');err.status=413;reject(err);req.resume();return}chunks.push(c)});req.on('end',()=>{if(settled)return;settled=true;resolve(Buffer.concat(chunks).toString('utf8'))});req.on('error',err=>{if(!settled){settled=true;reject(err)}})})}
async function readBody(req){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){const err=new Error('Content-Type application/json obrigatório.');err.status=415;throw err}const raw=await readRawBody(req);if(!raw){const err=new Error('JSON obrigatório.');err.status=400;throw err}try{const body=JSON.parse(raw);if(!body||typeof body!=='object'||Array.isArray(body)){const err=new Error('Objeto JSON obrigatório.');err.status=400;throw err}return body}catch(e){if(e.status)throw e;const err=new Error('JSON inválido.');err.status=400;throw err}}
function verifyHmac(secret,raw,signature,encoding='hex'){if(!secret||typeof signature!=='string')return false;const expected=crypto.createHmac('sha256',secret).update(raw).digest(encoding);if(encoding==='hex'&&!/^[a-f0-9]{64}$/i.test(signature))return false;const a=Buffer.from(expected,encoding),b=Buffer.from(signature,encoding);return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function verifyKeetaSignature(secret,url,payload){if(!secret||typeof payload?.sig!=='string'||! /^[a-f0-9]{64}$/i.test(payload.sig))return false;const params=Object.keys(payload).filter(k=>k!=='sig').sort().map(k=>{const v=payload[k];const value=v===null?'null':typeof v==='object'?JSON.stringify(v):String(v);return `${k}=${value}`}).join('&');const expected=crypto.createHash('sha256').update(`${url}?${params}${secret}`,'utf8').digest('hex');const a=Buffer.from(expected,'hex'),b=Buffer.from(payload.sig,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function rememberWebhook(provider,id){const key=`${provider}:${id}`;if(seenWebhooks.has(key))return false;seenWebhooks.set(key,Date.now());if(seenWebhooks.size>10000)seenWebhooks.delete(seenWebhooks.keys().next().value);return true}
async function databaseReadiness(){
  const client=await identityPool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='1500ms'");
    const result=await client.query("SELECT current_user AS role,to_regclass('rotamoto.domain_records') IS NOT NULL AS domain_ready");
    await client.query('COMMIT');
    return result.rows[0]?.role==='rotamoto_app'&&result.rows[0]?.domain_ready===true;
  }catch(error){try{await client.query('ROLLBACK')}catch(_){}throw error}
  finally{client.release()}
}
function bearer(){return state.token.accessToken||''}
async function ifood(path,{method='GET',body,headers={}}={}){
  const response=await fetch(IFOOD_API+path,{method,headers:{Authorization:`Bearer ${bearer()}`,Accept:'application/json','Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text(); let data={}; try{data=text?JSON.parse(text):{}}catch(_){data={raw:text}};
  if(!response.ok){const err=new Error(data.message||data.error||`iFood HTTP ${response.status}`);err.status=response.status;err.data=data;throw err}
  return data;
}
async function exchangeAuthorizationCode(code,verifier){
  if(!CLIENT_ID||!CLIENT_SECRET)throw new Error('Credenciais iFood não configuradas no servidor.');
  if(!code)throw new Error('authorizationCode não informado.');
  const usedVerifier=verifier||AUTHORIZATION_CODE_VERIFIER;
  if(!usedVerifier)throw new Error('authorizationCodeVerifier não informado.');
  const body=new URLSearchParams({grantType:'authorization_code',clientId:CLIENT_ID,clientSecret:CLIENT_SECRET,authorizationCode:code,authorizationCodeVerifier:usedVerifier});
  const response=await fetch(`${IFOOD_API}/authentication/v1.0/oauth/token`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body});
  const data=await response.json();
  if(!response.ok)throw new Error(data?.error?.message||data?.message||`Falha de autenticação iFood (${response.status})`);
  state.token.accessToken=data.accessToken||'';
  state.token.refreshToken=data.refreshToken||state.token.refreshToken||'';
  state.token.expiresAt=Date.now()+Number(data.expiresIn||0)*1000;
  state.integration.status='authenticated';
  return {authenticated:true,expiresIn:Number(data.expiresIn||0),hasRefreshToken:Boolean(state.token.refreshToken)};
}
async function refresh(){
  if(!CLIENT_ID||!CLIENT_SECRET||!state.token.refreshToken)throw new Error('Refresh token ou credenciais iFood ausentes.');
  const body=new URLSearchParams({grantType:'refresh_token',clientId:CLIENT_ID,clientSecret:CLIENT_SECRET,refreshToken:state.token.refreshToken});
  const response=await fetch(`${IFOOD_API}/authentication/v1.0/oauth/token`,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body});
  const data=await response.json();
  if(!response.ok)throw new Error(data?.error?.message||data?.message||`Falha ao renovar token (${response.status})`);
  state.token.accessToken=data.accessToken||'';
  state.token.refreshToken=data.refreshToken||state.token.refreshToken;
  state.token.expiresAt=Date.now()+Number(data.expiresIn||0)*1000;
  return {authenticated:true,expiresIn:Number(data.expiresIn||0)};
}
async function ensureToken(){
  if(!state.token.accessToken)throw new Error('Painel iFood ainda não autenticado.');
  if(state.token.expiresAt&&Date.now()>state.token.expiresAt-60000)return refresh();
}
async function poll(){
  await ensureToken();
  const data=await ifood('/order/v1.0/orders:polling?limit=100');
  const events=Array.isArray(data.events)?data.events:[];
  for(const evt of events){if(evt?.id)state.events.set(evt.id,{...evt,receivedAt:new Date().toISOString()})}
  state.integration.lastPollAt=new Date().toISOString();
  state.integration.lastSuccessAt=state.integration.lastPollAt;
  state.integration.lastError=null;
  return {events,stored:events.filter(e=>e?.id).length};
}
async function ack(eventIds){
  await ensureToken();
  const ids=[...new Set((eventIds||[]).filter(Boolean))];
  if(!ids.length)return {acknowledged:0};
  const data=await ifood('/order/v1.0/orders:acknowledgment',{method:'POST',body:{acknowledgedEventIds:ids}});
  ids.forEach(id=>state.events.delete(id));
  return {acknowledged:ids.length,result:data};
}
async function orderAction(id,action){
  await ensureToken();
  const routes={confirm:`/order/v1.0/orders/${encodeURIComponent(id)}/confirm`,startPreparation:`/order/v1.0/orders/${encodeURIComponent(id)}/startPreparation`,readyToPickup:`/order/v1.0/orders/${encodeURIComponent(id)}/readyToPickup`,dispatch:`/order/v1.0/orders/${encodeURIComponent(id)}/dispatch`,cancel:`/order/v1.0/orders/${encodeURIComponent(id)}/requestCancellation`};
  if(!routes[action])throw new Error('Ação iFood não suportada.');
  return ifood(routes[action],{method:'POST',body:action==='cancel'?{cancellationReason:'OTHER'}:undefined});
}
async function route(req,res){
  const startedAt=Date.now();
  req.requestId=crypto.randomUUID();
  res.req=req;
  if(ALLOWED_ORIGINS.includes(req.headers.origin)){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin')}
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='OPTIONS'){
      if(!ALLOWED_ORIGINS.includes(req.headers.origin))return json(res,403,{error:{code:'ORIGIN_INVALID',message:'Origem não permitida.'},requestId:req.requestId});
      res.writeHead(204,{'Access-Control-Allow-Origin':req.headers.origin,'Access-Control-Allow-Credentials':'true',
        'Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token, X-99Food-Signature, X-Signature, X-Keeta-Signature',
        'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS','Access-Control-Max-Age':'600','Vary':'Origin','X-Request-ID':req.requestId});
      return res.end();
    }
    if(await identityHttp(req,res))return;
    if(await adminHttp(req,res))return;
    if(await domainQueryHttp(req,res))return;
    if(await syncHttp(req,res))return;
    if(!['GET','POST'].includes(req.method))return json(res,405,{error:'METHOD_NOT_ALLOWED',message:'Método não permitido.'});
    if(req.headers.origin&&!ALLOWED_ORIGINS.includes(req.headers.origin))return json(res,403,{error:'FORBIDDEN',message:'Origem não permitida.'});
    if(req.method==='GET'&&['/health','/health/live'].includes(u.pathname))return json(res,200,{ok:true,status:'live',service:'rotamoto-api',time:new Date().toISOString(),requestId:req.requestId});
    if(req.method==='GET'&&u.pathname==='/health/ready'){
      try{const ready=await databaseReadiness();return json(res,ready?200:503,{status:ready?'ready':'not_ready',service:'rotamoto-api',dependencies:{postgres:ready?'ready':'unavailable'},time:new Date().toISOString(),requestId:req.requestId})}
      catch(_){return json(res,503,{status:'not_ready',service:'rotamoto-api',dependencies:{postgres:'unavailable'},time:new Date().toISOString(),requestId:req.requestId})}
    }
    if(req.method==='GET'&&u.pathname==='/api/ifood/status')return json(res,200,{provider:'ifood',status:state.integration.status,clientConfigured:Boolean(CLIENT_ID&&CLIENT_SECRET),authenticated:Boolean(state.token.accessToken),expiresAt:state.token.expiresAt||null,lastPollAt:state.integration.lastPollAt,lastSuccessAt:state.integration.lastSuccessAt,lastError:state.integration.lastError,pendingEvents:state.events.size});
    if(req.method==='GET'&&u.pathname==='/api/99food/status')return json(res,200,food99.diagnostics());
    if(req.method==='GET'&&u.pathname==='/api/99food/orders')return json(res,200,await food99.orders());
    if(req.method==='GET'&&u.pathname.startsWith('/api/99food/orders/'))return json(res,200,await food99.order(decodeURIComponent(u.pathname.split('/').pop())));
    if(req.method==='POST'&&u.pathname==='/api/99food/webhook'){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'UNSUPPORTED_MEDIA_TYPE',message:'Content-Type application/json obrigatório.'});const raw=await readRawBody(req);const valid=food99.verifyWebhook(raw,req.headers['x-99food-signature']||req.headers['x-signature']);if(!valid.configured)return json(res,503,{error:'WEBHOOK_NOT_CONFIGURED',message:'Webhook 99Food não configurado.'});if(!valid.valid)return json(res,401,{error:'INVALID_SIGNATURE',message:'Assinatura 99Food inválida.'});let payload;try{payload=JSON.parse(raw)}catch(_){return json(res,400,{error:'INVALID_PAYLOAD',message:'Payload JSON inválido.'})}if(!payload||typeof payload!=='object'||Array.isArray(payload))return json(res,400,{error:'INVALID_PAYLOAD',message:'Payload deve ser um objeto.'});const eventId=payload.id||payload.eventId;if(typeof eventId!=='string'||!eventId.trim()||eventId.length>256)return json(res,400,{error:'INVALID_PAYLOAD',message:'Identificador de evento inválido.'});const accepted=rememberWebhook('99food',eventId);return json(res,accepted?202:200,{accepted,eventId,duplicate:!accepted});}
    if(req.method==='GET'&&u.pathname==='/api/keeta/status')return json(res,200,keeta.diagnostics());
    if(req.method==='GET'&&u.pathname==='/api/keeta/merchant')return json(res,200,await keeta.merchant());
    if(req.method==='GET'&&u.pathname==='/api/keeta/events/poll')return json(res,200,await keeta.poll());
    if(req.method==='POST'&&u.pathname==='/api/keeta/events/ack'){const b=await readBody(req);return json(res,200,await keeta.acknowledge(b.eventIds));}
    if(req.method==='POST'&&u.pathname==='/api/keeta/webhook'){if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return json(res,415,{code:1,message:'Content-Type application/json obrigatório.'});const raw=await readRawBody(req);if(!raw.trim())return json(res,200,{code:0,message:'success',data:{}});let b;try{b=JSON.parse(raw)}catch(_){return json(res,400,{code:1,message:'Payload JSON inválido.'})}if(!b||typeof b!=='object'||Array.isArray(b)||!Number.isInteger(b.eventId)||typeof b.messageId!=='string'||!b.messageId.trim()||typeof b.sig!=='string')return json(res,400,{code:1,message:'Payload Keeta estruturalmente inválido.'});if(!KEETA_WEBHOOK_SECRET)return json(res,503,{code:1,message:'Webhook Keeta não configurado.'});const forwardedProto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();const protocol=forwardedProto==='https'||forwardedProto==='http'?forwardedProto:req.socket.encrypted?'https':'http';const webhookUrl=`${protocol}://${req.headers.host}${req.url}`;if(!verifyKeetaSignature(KEETA_WEBHOOK_SECRET,webhookUrl,b))return json(res,401,{code:1,message:'Assinatura Keeta inválida.'});const accepted=rememberWebhook('keeta',b.messageId);return json(res,200,{code:0,message:'success',data:{eventId:b.eventId,messageId:b.messageId,duplicate:!accepted}});}
    if(req.method==='GET'&&u.pathname.startsWith('/api/keeta/orders/'))return json(res,200,await keeta.order(decodeURIComponent(u.pathname.split('/').pop())));
    if(req.method==='POST'&&u.pathname==='/api/ifood/auth/exchange'){const b=await readBody(req);return json(res,200,await exchangeAuthorizationCode(b.authorizationCode,b.authorizationCodeVerifier))}
    if(req.method==='POST'&&u.pathname==='/api/ifood/auth/refresh')return json(res,200,await refresh());
    if(req.method==='GET'&&u.pathname==='/api/ifood/merchants'){await ensureToken();const data=await ifood('/merchant/v1.0/merchants');state.merchants=Array.isArray(data)?data:(data.merchants||[]);return json(res,200,{merchants:state.merchants})}
    if(req.method==='GET'&&u.pathname==='/api/ifood/events/poll')return json(res,200,await poll());
    if(req.method==='POST'&&u.pathname==='/api/ifood/events/ack'){const b=await readBody(req);return json(res,200,await ack(b.eventIds))}
    const orderMatch=u.pathname.match(/^\/api\/ifood\/orders\/([^/]+)$/); if(req.method==='GET'&&orderMatch){await ensureToken();const data=await ifood(`/order/v1.0/orders/${encodeURIComponent(orderMatch[1])}`);state.orders.set(orderMatch[1],data);return json(res,200,data)}
    const actionMatch=u.pathname.match(/^\/api\/ifood\/orders\/([^/]+)\/(confirm|start-preparation|ready-to-pickup|dispatch|cancel)$/); if(req.method==='POST'&&actionMatch)return json(res,202,await orderAction(actionMatch[1],actionMatch[2]));
    const kAction=u.pathname.match(/^\/api\/keeta\/orders\/([^/]+)\/(confirm|readyForPickup|dispatch|delivered|cancel)$/); if(req.method==='POST'&&kAction){const map={confirm:'confirm',readyForPickup:'readyForPickup',dispatch:'dispatch',delivered:'delivered',cancel:'cancel'};return json(res,202,await keeta.action(map[kAction[2]],kAction[1],kAction[2]==='cancel'?{reason:'MERCHANT'}:undefined));}
    const fAction=u.pathname.match(/^\/api\/99food\/orders\/([^/]+)\/(confirm|ready|dispatch|cancel)$/); if(req.method==='POST'&&fAction)return json(res,202,await food99.action(fAction[2],fAction[1],fAction[2]==='cancel'?{reason:'MERCHANT'}:undefined));
    return json(res,404,{error:'NOT_FOUND',message:'Rota não encontrada.'});
  }catch(err){const status=Number.isInteger(err.status)&&err.status>=400&&err.status<=599?err.status:500;const code=typeof err.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/u.test(err.code)?err.code:'INTEGRATION_ERROR';state.integration.lastError={code:status<500?code:'PROVIDER_REQUEST_FAILED',status,at:new Date().toISOString()};if(status===401){state.token.accessToken='';state.integration.status='configured'}req.apiErrorCode=code;return json(res,status,{error:status<500?'INVALID_REQUEST':'INTEGRATION_ERROR',message:status<500?'Solicitação inválida.':'Falha interna ao processar a integração.',requestId:req.requestId})}
  finally{try{requestLogger({requestId:req.requestId,method:req.method,path:u.pathname,status:res.statusCode||500,durationMs:Date.now()-startedAt,...(req.apiErrorCode?{errorCode:req.apiErrorCode}:{})})}catch(_) {}}
}

const pollTimer=setInterval(()=>{if(state.token.accessToken&&(!state.token.expiresAt||Date.now()<state.token.expiresAt-60000))poll().catch(()=>{});},30000);pollTimer.unref();
if(require.main===module){assertLoopbackHost();identityPool.query('SELECT current_user AS role').then(result=>{if(result.rows[0]?.role!=='rotamoto_app')throw new Error('A conexão runtime não autenticou como rotamoto_app.');http.createServer(route).listen(PORT,HOST,()=>console.log(`Rota Moto integration service listening on http://${HOST}:${PORT}`));}).catch(error=>{console.error(error.code?`PostgreSQL runtime indisponível (${error.code})`:error.message);process.exitCode=1;});}
module.exports={route,verifyHmac,verifyKeetaSignature,rememberWebhook,assertLoopbackHost,runtimeDatabaseConnectionString};
