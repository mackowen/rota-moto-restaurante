'use strict';

const crypto=require('node:crypto');
const {createRateLimiter}=require('../identity/http');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COOKIE='__Host-rotamoto_session=';
function send(res,status,body){const payload=JSON.stringify(body);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Request-ID':res.req?.requestId,'Content-Length':Buffer.byteLength(payload)});res.end(payload)}
function createPlatformAdminHttpHandler({identityService,allowedOrigin=[],logger=()=>{},rateLimiter=createRateLimiter()}={}){
 if(!identityService)throw new TypeError('Identity service is required.');
 const origins=Array.isArray(allowedOrigin)?allowedOrigin:[allowedOrigin];
 return async function platformAdminHttp(req,res){
  const url=new URL(req.url,'http://127.0.0.1');if(!url.pathname.startsWith('/api/platform-admin/'))return false;
  const requestId=req.requestId||crypto.randomUUID();req.requestId=requestId;res.req=req;let status=500,code='PLATFORM_ADMIN_FAILED';
  try{
   const companyList=url.pathname==='/api/platform-admin/companies'&&req.method==='GET';
   const userList=url.pathname==='/api/platform-admin/users'&&req.method==='GET';
   const membershipList=url.pathname==='/api/platform-admin/memberships'&&req.method==='GET';
   const companyChange=/^\/api\/platform-admin\/companies\/([0-9a-f-]{36})$/iu.exec(url.pathname);
   const userChange=/^\/api\/platform-admin\/users\/([0-9a-f-]{36})$/iu.exec(url.pathname);
   if(!companyList&&!userList&&!membershipList&&!companyChange&&!userChange){status=404;code='NOT_FOUND';throw Object.assign(new Error(),{code});}
   const method=(companyList||userList||membershipList)?'GET':'PATCH';if(req.method!==method){status=405;code='METHOD_NOT_ALLOWED';throw Object.assign(new Error(),{code});}
   const rate=rateLimiter.consume(`${req.clientIp||req.socket.remoteAddress||'unknown'}:${url.pathname}`);if(!rate.allowed){status=429;code='RATE_LIMITED';throw Object.assign(new Error(),{code})}
   const parts=String(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(COOKIE));const token=parts.length===1?parts[0].slice(COOKIE.length):'';
   if(!/^[A-Za-z0-9_-]{43}$/u.test(token)){status=401;code='UNAUTHENTICATED';throw Object.assign(new Error(),{code});}
   let body={};
   if(method==='PATCH'){
    const origin=req.headers.origin,expected=`${req.socket.encrypted?'https':'http'}://${String(req.headers.host||'').toLowerCase()}`;
    if(origin&&origin.toLowerCase()!==expected&&!origins.some(v=>String(v).toLowerCase()===origin.toLowerCase())){status=403;code='ORIGIN_INVALID';throw Object.assign(new Error(),{code});}
    if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']||'')){status=415;code='UNSUPPORTED_MEDIA_TYPE';throw Object.assign(new Error(),{code});}
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096){req.resume();status=413;code='PAYLOAD_TOO_LARGE';throw Object.assign(new Error(),{code});}chunks.push(chunk)}
    try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch(_){status=400;code='INVALID_INPUT';throw Object.assign(new Error(),{code})}
    if(!body||Array.isArray(body)||typeof body!=='object'){status=400;code='INVALID_INPUT';throw Object.assign(new Error(),{code})}
   }
   const result=await identityService.withAuthenticatedTenant(token,async(client,principal)=>{
    if(!principal.mfa_verified_at){status=403;code='MFA_REQUIRED';throw Object.assign(new Error(),{code})}
    const active=await client.query('SELECT EXISTS(SELECT 1 FROM rotamoto.platform_administrators WHERE user_id=$1 AND revoked_at IS NULL) AS active',[principal.user_id]);
    if(!active.rows[0]?.active){status=403;code='FORBIDDEN';throw Object.assign(new Error(),{code})}
    if(method==='PATCH'){
     const csrf=req.headers['x-csrf-token'];if(typeof csrf!=='string'||!await identityService.verifyCsrf(client,principal.session_id,csrf)){status=403;code='CSRF_INVALID';throw Object.assign(new Error(),{code})}
    }
    await client.query("SELECT set_config('app.platform_admin_user_id',$1,true)",[principal.user_id]);
    if(companyList)return (await client.query('SELECT rotamoto.platform_admin_list_companies() AS items')).rows[0].items;
    if(userList)return (await client.query('SELECT rotamoto.platform_admin_list_users() AS items')).rows[0].items;
    if(membershipList)return (await client.query('SELECT rotamoto.platform_admin_list_memberships() AS items')).rows[0].items;
    if(companyChange){if(!UUID.test(companyChange[1])||Object.keys(body).sort().join(',')!=='reason,status'||!['active','suspended'].includes(body.status)||!['business_review','security_review','owner_request'].includes(body.reason)){status=400;code='INVALID_INPUT';throw Object.assign(new Error(),{code})}return (await client.query('SELECT rotamoto.platform_admin_set_company_status($1,$2,$3) AS item',[companyChange[1],body.status,body.reason])).rows[0].item}
    if(!UUID.test(userChange[1])||Object.keys(body).sort().join(',')!=='disabled,reason'||typeof body.disabled!=='boolean'||!['security_review','owner_request'].includes(body.reason)){status=400;code='INVALID_INPUT';throw Object.assign(new Error(),{code})}
    return (await client.query('SELECT rotamoto.platform_admin_set_user_disabled($1,$2,$3) AS item',[userChange[1],body.disabled,body.reason])).rows[0].item;
   });
   status=200;code='OK';send(res,status,{items:Array.isArray(result)?result:undefined,item:Array.isArray(result)?undefined:result,requestId});return true;
  }catch(error){code=error?.code||code;if(!status||status===500){status=code==='UNAUTHENTICATED'?401:code==='FORBIDDEN'||code==='MFA_REQUIRED'||code==='CSRF_INVALID'?403:code==='NOT_FOUND'?404:code==='METHOD_NOT_ALLOWED'?405:code==='INVALID_INPUT'?400:500}try{logger({event:'platform_admin_request',requestId,method:req.method,path:url.pathname,status,errorCode:code})}catch(_){}send(res,status,{error:{code,message:status>=500?'Serviço administrativo indisponível.':'A solicitação não foi autorizada ou não pôde ser concluída.'},requestId});return true}
 }
}
module.exports={createPlatformAdminHttpHandler};
