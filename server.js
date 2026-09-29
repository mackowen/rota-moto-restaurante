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
const {create99FoodService}=require('./99food-service');
const {createKeetaService}=require('./keeta-service');

const PORT=Number(process.env.PORT||8787);
const IFOOD_API='https://merchant-api.ifood.com.br';
const CLIENT_ID=process.env.IFOOD_CLIENT_ID||'';
const CLIENT_SECRET=process.env.IFOOD_CLIENT_SECRET||'';
const AUTHORIZATION_CODE_VERIFIER=process.env.IFOOD_AUTHORIZATION_CODE_VERIFIER||'';
const ACCESS_TOKEN=process.env.IFOOD_ACCESS_TOKEN||'';
const REFRESH_TOKEN=process.env.IFOOD_REFRESH_TOKEN||'';
const food99=create99FoodService();
const keeta=createKeetaService();
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||'http://localhost:8787';

const state={
  integration:{provider:'ifood',status:CLIENT_ID&&CLIENT_SECRET?'configured':'not_configured',lastPollAt:null,lastSuccessAt:null,lastError:null},
  token:{accessToken:ACCESS_TOKEN,refreshToken:REFRESH_TOKEN,expiresAt:Number(process.env.IFOOD_ACCESS_TOKEN_EXPIRES_AT||0)},
  merchants:[],
  events:new Map(),
  orders:new Map()
};

function json(res,status,payload){const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':ALLOWED_ORIGIN});res.end(body)}
function readRawBody(req){return new Promise((resolve,reject)=>{let raw='';req.on('data',c=>{raw+=c;if(raw.length>1024*1024){req.destroy(new Error('Payload too large'));return}});req.on('end',()=>resolve(raw));req.on('error',reject)})}
async function readBody(req){const raw=await readRawBody(req);if(!raw)return {};try{return JSON.parse(raw)}catch(e){const err=new Error('JSON inválido.');err.status=400;throw err}}
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
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':ALLOWED_ORIGIN,'Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});return res.end()}
    if(req.method==='GET'&&u.pathname==='/health')return json(res,200,{ok:true,service:'rota-moto-ifood',time:new Date().toISOString()});
    if(req.method==='GET'&&u.pathname==='/api/ifood/status')return json(res,200,{provider:'ifood',status:state.integration.status,clientConfigured:Boolean(CLIENT_ID&&CLIENT_SECRET),authenticated:Boolean(state.token.accessToken),expiresAt:state.token.expiresAt||null,lastPollAt:state.integration.lastPollAt,lastSuccessAt:state.integration.lastSuccessAt,lastError:state.integration.lastError,pendingEvents:state.events.size});
    if(req.method==='GET'&&u.pathname==='/api/99food/status')return json(res,200,food99.diagnostics());
    if(req.method==='GET'&&u.pathname==='/api/99food/orders')return json(res,200,await food99.orders());
    if(req.method==='GET'&&u.pathname.startsWith('/api/99food/orders/'))return json(res,200,await food99.order(decodeURIComponent(u.pathname.split('/').pop())));
    if(req.method==='POST'&&u.pathname==='/api/99food/webhook'){const raw=await readRawBody(req);const valid=food99.verifyWebhook(raw,req.headers['x-99food-signature']||req.headers['x-signature']);if(valid.configured&&!valid.valid)return json(res,401,{error:'INVALID_SIGNATURE',message:'Assinatura 99Food inválida.'});const payload=raw?JSON.parse(raw):{};return json(res,202,{accepted:true,eventId:payload.id||payload.eventId||null});}
    if(req.method==='GET'&&u.pathname==='/api/keeta/status')return json(res,200,keeta.diagnostics());
    if(req.method==='GET'&&u.pathname==='/api/keeta/merchant')return json(res,200,await keeta.merchant());
    if(req.method==='GET'&&u.pathname==='/api/keeta/events/poll')return json(res,200,await keeta.poll());
    if(req.method==='POST'&&u.pathname==='/api/keeta/events/ack'){const b=await readBody(req);return json(res,200,await keeta.acknowledge(b.eventIds));}
    if(req.method==='POST'&&u.pathname==='/api/keeta/webhook'){const b=await readBody(req);if(!b||(!b.eventId&&!b.messageId))return json(res,400,{code:1,message:'Webhook Keeta sem identificador.'});return json(res,200,{code:0,message:'success',data:{eventId:b.eventId,messageId:b.messageId}});}
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
  }catch(err){state.integration.lastError={message:err.message,status:err.status||500,at:new Date().toISOString()};if(err.status===401){state.token.accessToken='';state.integration.status='configured'}return json(res,err.status===401?401:500,{error:'IFOOD_INTEGRATION_ERROR',message:err.message})}
}

setInterval(()=>{if(state.token.accessToken&&(!state.token.expiresAt||Date.now()<state.token.expiresAt-60000))poll().catch(()=>{});},30000);
http.createServer(route).listen(PORT,()=>console.log(`Rota Moto iFood service listening on http://localhost:${PORT}`));
