'use strict';
const crypto=require('node:crypto');
const {COOKIE_NAME,createRateLimiter}=require('../identity/http');

function createFinanceHttpHandler({identityService,financeService,rateLimiter=createRateLimiter(),allowedOrigin,logger=()=>{}}){
  const maxBody=32*1024;
  return async function financeHttp(req,res){
    const url=new URL(req.url,'http://127.0.0.1'),known=url.pathname==='/api/finance/events';
    if(!known&&!url.pathname.startsWith('/api/finance/'))return false;
    const requestId=req.requestId||crypto.randomUUID();let status=500,errorCode;
    try{
      if(!known){status=404;throw Object.assign(new Error('NOT_FOUND'),{code:'NOT_FOUND'})}
      if(!['GET','POST'].includes(req.method)){status=405;res.writeHead(405,{Allow:'GET, POST','Cache-Control':'no-store','X-Request-ID':requestId});res.end();return true}
      if(req.method==='POST'&&req.headers.origin){let origin;try{origin=new URL(req.headers.origin).origin}catch(_){origin=''}
        const protocol=req.socket.encrypted?'https:':'http:';const allowed=[].concat(allowedOrigin||[]);
        if(origin!==`${protocol}//${String(req.headers.host||'').toLowerCase()}`&&!allowed.includes(origin))throw Object.assign(new Error('ORIGIN_INVALID'),{code:'ORIGIN_INVALID'});
      }
      const limiter=rateLimiter.consume(`${req.clientIp||req.socket.remoteAddress||'unknown'}:${url.pathname}`);
      if(!limiter.allowed){status=429;throw Object.assign(new Error('RATE_LIMITED'),{code:'RATE_LIMITED'})}
      const cookies=String(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(`${COOKIE_NAME}=`));
      const token=cookies.length===1?cookies[0].slice(COOKIE_NAME.length+1):null;
      if(!/^[A-Za-z0-9_-]{43}$/u.test(token||''))throw Object.assign(new Error('UNAUTHENTICATED'),{code:'UNAUTHENTICATED'});
      let result;
      if(req.method==='POST'){
        if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||''))throw Object.assign(new Error('INVALID_INPUT'),{code:'INVALID_INPUT'});
        const declared=Number(req.headers['content-length']||0);if(declared>maxBody){req.resume();throw Object.assign(new Error('PAYLOAD_TOO_LARGE'),{code:'PAYLOAD_TOO_LARGE'})}
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>maxBody){req.resume();throw Object.assign(new Error('PAYLOAD_TOO_LARGE'),{code:'PAYLOAD_TOO_LARGE'})}chunks.push(chunk)}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch(_){throw Object.assign(new Error('INVALID_INPUT'),{code:'INVALID_INPUT'})}
        result=await identityService.withAuthenticatedTenant(token,async(client,principal)=>{
          const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string'||!await identityService.verifyCsrf(client,principal.session_id,csrf))throw Object.assign(new Error('CSRF_INVALID'),{code:'CSRF_INVALID'});
          return financeService.record(client,principal,body);
        },'finance.manage');
      }else{
        const query=Object.fromEntries(url.searchParams);if(url.searchParams.size!==Object.keys(query).length)throw Object.assign(new Error('INVALID_INPUT'),{code:'INVALID_INPUT'});
        result=await identityService.withAuthenticatedTenant(token,(client,principal)=>financeService.list(client,principal,query),'finance.read');
      }
      status=req.method==='POST'?201:200;const body=JSON.stringify({...result,requestId});
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','X-Request-ID':requestId,'Content-Length':Buffer.byteLength(body)});res.end(body);return true;
    }catch(error){
      errorCode=error?.code||'INTERNAL_ERROR';const codes={INVALID_INPUT:400,UNAUTHENTICATED:401,FORBIDDEN:403,MFA_REQUIRED:403,CSRF_INVALID:403,ORIGIN_INVALID:403,
        NOT_FOUND:404,RATE_LIMITED:429,PAYLOAD_TOO_LARGE:413,IDEMPOTENCY_CONFLICT:409,DUPLICATE_FINANCIAL_REFERENCE:409,PAYMENT_EXCEEDS_ORDER:409,REFUND_EXCEEDS_PAYMENT:409,
        REFUND_SOURCE_INVALID:409,ADJUSTMENT_SOURCE_INVALID:409,ORDER_CANCELLED:409,CURRENCY_MISMATCH:409,ORDER_VALUE_UNPROVEN:409,PAYOUT_EXCEEDS_EARNING:409};
      status=status===405?405:codes[errorCode]||500;const code=status>=500?'INTERNAL_ERROR':errorCode;
      req.apiErrorCode=code;
      const message=status===400?error.message:({UNAUTHENTICATED:'Sessão inválida ou expirada.',FORBIDDEN:'Operação não autorizada.',MFA_REQUIRED:'Confirme MFA antes da operação financeira.',CSRF_INVALID:'Validação CSRF inválida.',
        NOT_FOUND:'Recurso não encontrado.',RATE_LIMITED:'Limite de solicitações excedido.',ORDER_CANCELLED:'Pedido cancelado não aceita novo recebimento.',
        PAYMENT_EXCEEDS_ORDER:'O recebimento excede o saldo do pedido.',REFUND_EXCEEDS_PAYMENT:'O estorno excede o pagamento disponível.',
        ORDER_VALUE_UNPROVEN:'O pedido não possui valor canônico completo.',CURRENCY_MISMATCH:'A moeda não corresponde à fonte canônica.',
        PAYOUT_EXCEEDS_EARNING:'A liquidação excede o repasse devido.',IDEMPOTENCY_CONFLICT:'A chave já foi usada com outro evento.',DUPLICATE_FINANCIAL_REFERENCE:'Já existe evento financeiro com esta referência para este vínculo.',
        REFUND_SOURCE_INVALID:'O pagamento original não corresponde ao estorno.',ADJUSTMENT_SOURCE_INVALID:'O ajuste não referencia um fato compatível.'})[code]||'Falha interna ao processar o evento financeiro.';
      const body=JSON.stringify({error:{code,message},requestId});res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Request-ID':requestId,'Content-Length':Buffer.byteLength(body)});res.end(body);return true;
    }finally{try{logger({requestId,method:req.method,path:url.pathname,status,errorCode})}catch(_) {}}
  };
}
module.exports={createFinanceHttpHandler};
