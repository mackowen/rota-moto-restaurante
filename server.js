/*
 * RotaMoto local API: identity, domain sync and administrative read surfaces.
 *
 * Node 18+. This service is intentionally separate from the local-first browser app.
 */
const http=require('node:http');
const crypto=require('node:crypto');
const {URL}=require('node:url');
const {Pool}=require('pg');
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
const {PROVIDERS}=require('./backend/integrations/registry');

const PORT=Number(process.env.PORT||8787);
const HOST=process.env.HOST||'127.0.0.1';
const ALLOWED_ORIGIN=process.env.ALLOWED_ORIGIN||'http://localhost:8787';
const ALLOWED_ORIGINS=Object.freeze([...new Set([ALLOWED_ORIGIN,...String(process.env.ALLOWED_ORIGINS||'').split(',')].map(value=>{try{const parsed=new URL(value.trim());return ['http:','https:'].includes(parsed.protocol)&&parsed.origin===value.trim()?parsed.origin:null}catch(_){return null}}).filter(Boolean))]);
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


function json(res,status,payload){const body=JSON.stringify(payload),origin=res.req?.headers.origin;const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin',...(res.req?.requestId?{'X-Request-ID':res.req.requestId}:{})};if(ALLOWED_ORIGINS.includes(origin)){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Credentials']='true'}res.writeHead(status,headers);res.end(body)}
function assertLoopbackHost(host=HOST){const value=String(host).toLowerCase().replace(/^\[|\]$/g,'');if(!['127.0.0.1','::1','localhost'].includes(value))throw new Error('O servidor de integrações não possui autenticação de usuário; mantenha HOST em loopback e exponha acesso remoto somente por um proxy autenticado que encaminhe para loopback.');return true}
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
        'Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token',
        'Access-Control-Allow-Methods':'GET,POST,PATCH,OPTIONS','Access-Control-Max-Age':'600','Vary':'Origin','X-Request-ID':req.requestId});
      return res.end();
    }
    if(await identityHttp(req,res))return;
    if(await adminHttp(req,res))return;
    if(await domainQueryHttp(req,res))return;
    if(await syncHttp(req,res))return;
    if(req.headers.origin&&!ALLOWED_ORIGINS.includes(req.headers.origin))return json(res,403,{error:'FORBIDDEN',message:'Origem não permitida.'});
    if(/^\/api\/(?:ifood|99food|keeta)(?:\/|$)/iu.test(u.pathname))return json(res,503,{error:{code:'PROVIDER_BLOCKED_EXTERNAL',message:'A integração externa ainda não foi validada e habilitada.'},requestId:req.requestId});
    if(!['GET','POST'].includes(req.method))return json(res,405,{error:'METHOD_NOT_ALLOWED',message:'Método não permitido.'});
    if(req.method==='GET'&&['/health','/health/live'].includes(u.pathname))return json(res,200,{ok:true,status:'live',service:'rotamoto-api',time:new Date().toISOString(),requestId:req.requestId});
    if(req.method==='GET'&&u.pathname==='/health/ready'){
      try{const ready=await databaseReadiness();return json(res,ready?200:503,{status:ready?'ready':'not_ready',service:'rotamoto-api',dependencies:{postgres:ready?'ready':'unavailable'},time:new Date().toISOString(),requestId:req.requestId})}
      catch(_){return json(res,503,{status:'not_ready',service:'rotamoto-api',dependencies:{postgres:'unavailable'},time:new Date().toISOString(),requestId:req.requestId})}
    }
    return json(res,404,{error:'NOT_FOUND',message:'Rota não encontrada.'});
  }catch(err){const status=Number.isInteger(err.status)&&err.status>=400&&err.status<=599?err.status:500;const code=typeof err.code==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/u.test(err.code)?err.code:'INTERNAL_ERROR';req.apiErrorCode=code;return json(res,status,{error:{code:status>=500?'INTERNAL_ERROR':code,message:status>=500?'Falha interna ao processar a solicitação.':'Solicitação inválida.'},requestId:req.requestId})}
  finally{try{requestLogger({requestId:req.requestId,method:req.method,path:u.pathname,status:res.statusCode||500,durationMs:Date.now()-startedAt,...(req.apiErrorCode?{errorCode:req.apiErrorCode}:{})})}catch(_) {}}
}

if(require.main===module){assertLoopbackHost();identityPool.query('SELECT current_user AS role').then(result=>{if(result.rows[0]?.role!=='rotamoto_app')throw new Error('A conexão runtime não autenticou como rotamoto_app.');http.createServer(route).listen(PORT,HOST,()=>console.log(`Rota Moto integration service listening on http://${HOST}:${PORT}`));}).catch(error=>{console.error(error.code?`PostgreSQL runtime indisponível (${error.code})`:error.message);process.exitCode=1;});}
module.exports={route,assertLoopbackHost,runtimeDatabaseConnectionString,PROVIDERS};
