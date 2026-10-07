'use strict';

const crypto=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function send(res,status,payload){const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Length':Buffer.byteLength(body)});res.end(body);}
async function readBody(req){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>8192){req.resume();throw Object.assign(new Error('Body too large.'),{code:'PAYLOAD_TOO_LARGE'});}chunks.push(chunk);}
  try{const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||Array.isArray(data)||typeof data!=='object')throw new Error();return data;}catch(_){throw Object.assign(new Error('Invalid input.'),{code:'INVALID_INPUT'});}}

function createMarketplaceAdminHandler({identityService,accountService,adminService,logger=()=>{},allowedOrigin}={}){
  if(!identityService||!accountService||!adminService)throw new TypeError('Marketplace admin handler configuration is incomplete.');
  const allow=Array.isArray(allowedOrigin)?allowedOrigin:[allowedOrigin];
  return async function marketplaceAdmin(req,res){
    const url=new URL(req.url,'http://127.0.0.1');
    const match=/^\/api\/admin\/integrations\/(ifood|keeta|99food)(?:\/authorize|\/complete|\/accounts\/([0-9a-f-]{36})\/disable)$/iu.exec(url.pathname);
    if(!match)return false;
    const provider=match[1].toLowerCase(),operation=url.pathname.endsWith('/authorize')?'authorize':url.pathname.endsWith('/complete')?'complete':'disable';
    const requestId=req.requestId||crypto.randomUUID();
    try{
      if(req.method!=='POST')throw Object.assign(new Error('Method not allowed.'),{code:'METHOD_NOT_ALLOWED'});
      if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||''))throw Object.assign(new Error('JSON required.'),{code:'UNSUPPORTED_MEDIA_TYPE'});
      if(req.headers.origin&&!allow.includes(req.headers.origin)&&req.headers.origin.toLowerCase()!==`${req.socket.encrypted?'https':'http'}://${String(req.headers.host||'').toLowerCase()}`)
        throw Object.assign(new Error('Origin rejected.'),{code:'ORIGIN_INVALID'});
      const body=await readBody(req);
      const tokenParts=String(req.headers.cookie||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith('__Host-rotamoto_session='));
      const token=tokenParts.length===1?tokenParts[0].slice('__Host-rotamoto_session='.length):null;
      if(!token||!/^[A-Za-z0-9_-]{43}$/u.test(token))throw Object.assign(new Error('Session invalid.'),{code:'UNAUTHENTICATED'});
      const principal=await identityService.withAuthenticatedTenant(token,async(client,authenticated)=>{
        const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string'||!await identityService.verifyCsrf(client,authenticated.session_id,csrf))throw Object.assign(new Error('CSRF invalid.'),{code:'CSRF_INVALID'});
        return authenticated;
      },'integrations.manage');
      let result;
      if(operation==='authorize'){
        if(Object.keys(body).length)throw Object.assign(new Error('Invalid input.'),{code:'INVALID_INPUT'});
        result=await accountService.begin(principal.company_id,provider);
      }else if(operation==='complete'){
        if(provider==='ifood'){
          if(Object.keys(body).sort().join(',')!=='authorizationCode,state'||typeof body.state!=='string'||typeof body.authorizationCode!=='string')throw Object.assign(new Error('Invalid input.'),{code:'INVALID_INPUT'});
          result=await accountService.finishIfood(principal.company_id,body);
        }else if(provider==='keeta'){
          if(Object.keys(body).sort().join(',')!=='authId,state'||typeof body.state!=='string'||typeof body.authId!=='string')throw Object.assign(new Error('Invalid input.'),{code:'INVALID_INPUT'});
          result=await accountService.finishKeeta(principal.company_id,body);
        }else throw Object.assign(new Error('Provider contract unavailable.'),{code:'PROVIDER_BLOCKED_EXTERNAL',status:409});
      }else{
        if(Object.keys(body).length||!UUID.test(match[2]||''))throw Object.assign(new Error('Invalid input.'),{code:'INVALID_INPUT'});
        result=await identityService.withAuthenticatedTenant(token,(client,authenticated)=>adminService.disableIntegrationAccount(client,authenticated,provider,match[2]),'integrations.manage');
      }
      send(res,200,{...result,requestId});return true;
    }catch(error){
      const code=/^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code||'')?error.code:'MARKETPLACE_ADMIN_FAILED';
      const status=error?.code==='UNAUTHENTICATED'?401:error?.code==='FORBIDDEN'||error?.code==='CSRF_INVALID'||error?.code==='ORIGIN_INVALID'?403:
        error?.code==='NOT_FOUND'?404:error?.code==='METHOD_NOT_ALLOWED'?405:error?.code==='PAYLOAD_TOO_LARGE'?413:error?.code==='UNSUPPORTED_MEDIA_TYPE'?415:
          Number.isInteger(error?.status)?error.status:400;
      try{logger({event:'marketplace.account_action_failed',requestId,provider,operation,errorCode:code});}catch(_){}
      send(res,status,{error:{code,message:status>=500?'A plataforma ou o serviço de credenciais está indisponível.':'Não foi possível concluir a ação da integração.'},requestId});return true;
    }
  };
}

module.exports={createMarketplaceAdminHandler};
