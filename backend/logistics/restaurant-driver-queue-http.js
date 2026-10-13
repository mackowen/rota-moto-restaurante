'use strict';

const crypto=require('node:crypto');
const {COOKIE_NAME,createRateLimiter}=require('../identity/http');
const MAX_BODY_BYTES=4096;
function fail(code,message){throw Object.assign(new Error(message),{code});}
function sessionToken(req){const found=String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(`${COOKIE_NAME}=`));if(found.length!==1)return null;const value=found[0].slice(COOKIE_NAME.length+1);return /^[A-Za-z0-9_-]{43}$/u.test(value)?value:null}
function sameOrigin(req,allowed){if(!req.headers.origin)return;let origin;try{origin=new URL(req.headers.origin).origin}catch(_){fail('ORIGIN_INVALID','Origem inválida.')};const self=`${req.socket.encrypted?'https:':'http:'}//${String(req.headers.host||'').toLowerCase()}`;if(origin.toLowerCase()!==self&&!allowed.includes(origin))fail('ORIGIN_INVALID','Origem não permitida.')}
async function body(req){if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||''))fail('INVALID_INPUT','Content-Type application/json obrigatório.');const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY_BYTES)fail('PAYLOAD_TOO_LARGE','Payload excede o limite permitido.');chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch(_){fail('INVALID_INPUT','JSON inválido.')}}
function createRestaurantDriverQueueHttpHandler({identityService,service,rateLimiter=createRateLimiter(),logger=()=>{},allowedOrigin=[]}={}){
  if(!identityService||!service)throw new TypeError('Serviços de identidade e fila obrigatórios.');
  return async function restaurantDriverQueueHttp(req,res){
    const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/api/restaurant-driver-queue'))return false;
    const requestId=req.requestId||crypto.randomUUID();let status=500,errorCode;
    const respond=(code,data)=>{status=code;const text=JSON.stringify({...data,requestId});res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Request-ID':requestId,'Content-Length':Buffer.byteLength(text)});res.end(text)};
    try{
      const path=url.pathname,known=new Set(['/api/restaurant-driver-queue','/api/restaurant-driver-queue/check-in','/api/restaurant-driver-queue/check-out','/api/restaurant-driver-queue/confirm','/api/restaurant-driver-queue/settings','/api/restaurant-driver-queue/qr','/api/restaurant-driver-queue/qr-check-in']);
      if(!known.has(path))fail('NOT_FOUND','Recurso não encontrado.');
      const method=path==='/api/restaurant-driver-queue'?'GET':'POST';if(req.method!==method){res.writeHead(405,{Allow:method,'Cache-Control':'no-store'});res.end();status=405;return true}
      if(!rateLimiter.consume(`${req.clientIp||req.socket.remoteAddress||'unknown'}:${path}`).allowed)fail('RATE_LIMITED','Limite de solicitações excedido.');
      if(method==='POST')sameOrigin(req,Array.isArray(allowedOrigin)?allowedOrigin:[allowedOrigin]);
      const token=sessionToken(req);if(!token)fail('UNAUTHENTICATED','Sessão inválida ou expirada.');
      const read=path==='/api/restaurant-driver-queue';
      const result=await identityService.withAuthenticatedTenant(token,async(client,principal)=>{
        if(read)return {...await service.getQueue(client,principal),...await service.getSettings(client,principal)};
        if(!await identityService.verifyCsrf(client,principal.session_id,req.headers['x-csrf-token']))fail('CSRF_INVALID','Validação CSRF inválida.');
        const data=await body(req);
        if(path.endsWith('/check-in'))return service.checkIn(client,principal,data);
        if(path.endsWith('/qr-check-in'))return service.checkIn(client,principal,{qrToken:data.token,gpsAccuracyM:data.gpsAccuracyM});
        if(path.endsWith('/check-out'))return service.checkOut(client,principal);
        if(path.endsWith('/confirm'))return service.confirmPresence(client,principal,data.driverId);
        if(path.endsWith('/settings'))return service.setMode(client,principal,data.mode,data.expectedRevision);
        if(path.endsWith('/qr'))return service.issueRestaurantQr(client,principal);
        fail('NOT_FOUND','Recurso não encontrado.');
      },read?'sync.pull':'sync.push');
      respond(200,result);return true;
    }catch(error){
      errorCode=typeof error?.code==='string'?error.code:'INTERNAL_ERROR';const map={INVALID_INPUT:400,PAYLOAD_TOO_LARGE:413,UNAUTHENTICATED:401,FORBIDDEN:403,DRIVER_LINK_REQUIRED:403,DRIVER_INACTIVE:409,DRIVER_NOT_AVAILABLE:409,DRIVER_BUSY:409,CSRF_INVALID:403,ORIGIN_INVALID:403,NOT_FOUND:404,RATE_LIMITED:429,REVISION_CONFLICT:409,PRESENCE_QR_INVALID:400,PRESENCE_QR_REPLAY:409,PRESENCE_QR_TENANT_MISMATCH:403,PRESENCE_QR_UNAVAILABLE:503,PRESENCE_NOT_FOUND:404};
      status=map[errorCode]||500;const code=status>=500?'INTERNAL_ERROR':errorCode;req.apiErrorCode=code;respond(status,{error:{code,message:status>=500?'Falha interna ao processar a fila operacional.':error.message}});return true;
    }finally{try{logger({event:'restaurant_driver_queue.request',requestId,method:req.method,path:url.pathname,status,...(errorCode?{errorCode:req.apiErrorCode||errorCode}:{})})}catch(_){}}
  };
}
module.exports={createRestaurantDriverQueueHttpHandler,MAX_BODY_BYTES};
