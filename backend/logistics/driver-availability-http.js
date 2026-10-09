'use strict';

const crypto=require('node:crypto');
const { COOKIE_NAME, createRateLimiter }=require('../identity/http');
const { LEASE_SECONDS }=require('./driver-availability');

const MAX_BODY_BYTES=4096;
function error(code,message){throw Object.assign(new Error(message),{code});}
function tokenFrom(req){const values=String(req.headers.cookie||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(`${COOKIE_NAME}=`));if(values.length!==1)return null;const token=values[0].slice(COOKIE_NAME.length+1);return /^[A-Za-z0-9_-]{43}$/u.test(token)?token:null}
function assertSameOrigin(req,allowedOrigin){const origin=req.headers.origin;if(!origin)return;let parsed;try{parsed=new URL(origin)}catch(_){error('ORIGIN_INVALID','Origem inválida.')};const protocol=req.socket.encrypted?'https:':'http:',allowed=Array.isArray(allowedOrigin)?allowedOrigin:[allowedOrigin];if(parsed.origin.toLowerCase()!==`${protocol}//${String(req.headers.host||'').toLowerCase()}`&&!allowed.includes(parsed.origin))error('ORIGIN_INVALID','Origem não permitida.')}
async function jsonBody(req){if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||''))error('INVALID_INPUT','Content-Type application/json obrigatório.');if(Number(req.headers['content-length']||0)>MAX_BODY_BYTES){req.resume();error('PAYLOAD_TOO_LARGE','Payload excede o limite permitido.')}const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY_BYTES){req.resume();error('PAYLOAD_TOO_LARGE','Payload excede o limite permitido.')}chunks.push(chunk)}if(!size)error('INVALID_INPUT','JSON obrigatório.');try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch(_){error('INVALID_INPUT','JSON inválido.')}}

function createDriverAvailabilityHttpHandler({identityService,service,rateLimiter=createRateLimiter(),logger=()=>{},allowedOrigin=[]}={}){
  if(!identityService||!service)throw new TypeError('Serviços de identidade e disponibilidade obrigatórios.');
  return async function driverAvailabilityHttp(req,res){
    const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/api/driver-availability'))return false;
    const requestId=req.requestId||crypto.randomUUID(),startedAt=Date.now();let status=500,errorCode;
    const respond=(code,body,extra={})=>{status=code;const text=JSON.stringify({...body,requestId});res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Request-ID':requestId,'Content-Length':Buffer.byteLength(text),...extra});res.end(text)};
    try{
      const path=url.pathname,route=path==='/api/driver-availability'?'read':path==='/api/driver-availability/commands'?'command':path==='/api/driver-availability/heartbeat'?'heartbeat':null;
      if(!route)error('NOT_FOUND','Recurso não encontrado.');
      const method=route==='read'?'GET':'POST';if(req.method!==method){respond(405,{error:{code:'METHOD_NOT_ALLOWED',message:'Método não permitido.'}},{Allow:method});return true}
      if(!rateLimiter.consume(`${req.clientIp||req.socket.remoteAddress||'unknown'}:${path}`).allowed)error('RATE_LIMITED','Limite de solicitações excedido.');
      if(method==='POST')assertSameOrigin(req,allowedOrigin);
      const token=tokenFrom(req);if(!token)error('UNAUTHENTICATED','Sessão inválida ou expirada.');
      const result=await identityService.withAuthenticatedTenant(token,async(client,principal)=>{
        if(route==='read')return service.get(client,principal);
        const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string'||!await identityService.verifyCsrf(client,principal.session_id,csrf))error('CSRF_INVALID','Validação CSRF inválida.');
        const body=await jsonBody(req);return route==='command'?service.set(client,principal,body):service.heartbeat(client,principal,body);
      },route==='read'?'sync.pull':'sync.push');
      respond(200,{...result,leaseSeconds:LEASE_SECONDS});return true;
    }catch(err){
      errorCode=typeof err?.code==='string'?err.code:'INTERNAL_ERROR';const map={INVALID_INPUT:400,PAYLOAD_TOO_LARGE:413,UNAUTHENTICATED:401,FORBIDDEN:403,
        FORBIDDEN_FIELD:403,DRIVER_LINK_REQUIRED:403,CSRF_INVALID:403,ORIGIN_INVALID:403,NOT_FOUND:404,RATE_LIMITED:429,
        REVISION_CONFLICT:409,IDEMPOTENCY_CONFLICT:409,DRIVER_NOT_AVAILABLE:409,DRIVER_INACTIVE:409};
      status=map[errorCode]||500;const code=status>=500?'INTERNAL_ERROR':errorCode;req.apiErrorCode=code;
      const message=status>=500?'Falha interna ao atualizar a disponibilidade.':(err.message||'Solicitação inválida.');
      respond(status,{error:{code,message}},status===429?{'Retry-After':'30'}:{});return true;
    }finally{try{logger({requestId,method:req.method,path:url.pathname,status,durationMs:Date.now()-startedAt,...(errorCode?{errorCode:req.apiErrorCode||errorCode}:{})})}catch(_){}}
  };
}

module.exports={MAX_BODY_BYTES,createDriverAvailabilityHttpHandler};
