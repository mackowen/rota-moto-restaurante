'use strict';

const crypto=require('node:crypto');
const {COOKIE_NAME,createRateLimiter}=require('../identity/http');

function createQueueMetricsHttpHandler({identityService,metrics,rateLimiter=createRateLimiter(),logger=()=>{}}={}){
  if(!identityService||!metrics||typeof metrics.snapshotForTenant!=='function')throw new TypeError('Queue metrics handler requires identity and metrics services.');
  return async function queueMetricsHttp(req,res){
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname!=='/api/ops/queues')return false;
    const requestId=req.requestId||crypto.randomUUID();let status=500,errorCode;
    const respond=(code,payload)=>{status=code;const text=JSON.stringify({...payload,requestId});res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Request-ID':requestId,'Content-Length':Buffer.byteLength(text)});res.end(text)};
    try{
      if(req.method!=='GET'){respond(405,{error:{code:'METHOD_NOT_ALLOWED',message:'Método não permitido.'}});return true;}
      const cookie=String(req.headers.cookie||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(`${COOKIE_NAME}=`));
      if(cookie.length!==1||!new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43}$`,'u').test(cookie[0])){
        respond(401,{error:{code:'UNAUTHENTICATED',message:'Sessão inválida ou expirada.'}});return true;
      }
      const rate=rateLimiter.consume(`${req.clientIp||'local'}:/api/ops/queues`);
      if(!rate.allowed){respond(429,{error:{code:'RATE_LIMITED',message:'Limite de solicitações excedido.'}});return true;}
      const token=cookie[0].slice(COOKIE_NAME.length+1);
      const snapshot=await identityService.withAuthenticatedTenant(token,(client,principal)=>metrics.snapshotForTenant(client,principal.company_id),'company.manage');
      respond(200,{status:'ok',metrics:snapshot});return true;
    }catch(error){
      errorCode=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code)?error.code:'INTERNAL_ERROR';
      const denied=['UNAUTHENTICATED','FORBIDDEN','PERMISSION_DENIED','COMPANY_ACCESS_DENIED'].includes(errorCode);
      respond(denied?403:503,{error:{code:denied?errorCode:'QUEUE_METRICS_UNAVAILABLE',message:denied?'Acesso não autorizado.':'Métricas de filas temporariamente indisponíveis.'}});
    }finally{try{logger({event:'queue_metrics.request',requestId,method:req.method,path:'/api/ops/queues',status,...(errorCode?{errorCode}:{})})}catch(_) {}}
    return true;
  };
}

module.exports={createQueueMetricsHttpHandler};
