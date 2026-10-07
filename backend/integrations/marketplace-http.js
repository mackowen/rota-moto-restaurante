'use strict';

const crypto=require('node:crypto');
const {MAX_WEBHOOK_BYTES,createMarketplaceRuntime}=require('./marketplace-runtime');

function json(res,status,payload){const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Length':Buffer.byteLength(body)});res.end(body);}
function statusFor(error){return Number.isInteger(error?.status)&&error.status>=400&&error.status<=599?error.status:503;}

function createMarketplaceHttpHandler({pool,adapters,accountResolver,logger=()=>{}}={}){
  if(!pool||!adapters||!accountResolver)throw new TypeError('Marketplace webhook runtime is unavailable.');
  const runtime=createMarketplaceRuntime({pool,adapters,accountResolver,logger});
  return async function marketplaceHttp(req,res){
    const url=new URL(req.url,'http://127.0.0.1');
    if(!url.pathname.startsWith('/api/marketplace/'))return false;
    const requestId=req.requestId||crypto.randomUUID();
    try{
      const match=/^\/api\/marketplace\/(ifood|keeta)\/webhooks(?:\/([0-9a-f-]{36}))?$/iu.exec(url.pathname);
      if(req.method!=='POST'||!match)throw Object.assign(new Error('Invalid route.'),{code:'NOT_FOUND',status:404});
      if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||''))throw Object.assign(new Error('JSON required.'),{code:'UNSUPPORTED_MEDIA_TYPE',status:415});
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>MAX_WEBHOOK_BYTES){req.resume();throw Object.assign(new Error('Webhook too large.'),{code:'PAYLOAD_TOO_LARGE',status:413});}chunks.push(chunk);}
      const rawBody=Buffer.concat(chunks);
      const provider=match[1].toLowerCase();
      const result=await runtime.ingest({provider,accountId:match[2]||null,rawBody,
        signature:provider==='ifood'?req.headers['x-ifood-signature']:req.headers['x-app-signature'],headers:req.headers,deferProcessing:true});
      if(provider==='keeta') { res.writeHead(204,{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Request-ID':requestId});res.end();return true; }
      json(res,202,{accepted:true,queued:result.queued,duplicate:result.duplicate,requestId});return true;
    }catch(error){
      const status=statusFor(error),code=/^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code||'')?error.code:'MARKETPLACE_WEBHOOK_FAILED';
      try{logger({event:'marketplace.webhook_rejected',requestId,status,errorCode:code});}catch(_){}
      json(res,status,{error:{code,status:status===503?'Evento ainda não foi processado.':'Webhook inválido.'},requestId});return true;
    }
  };
}

module.exports={createMarketplaceHttpHandler};
