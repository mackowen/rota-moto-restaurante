/*
 * RotaMoto local API: identity, domain sync and administrative read surfaces.
 *
 * Node 24.7+. This service is intentionally separate from the local-first browser app.
 */
const http=require('node:http');
const crypto=require('node:crypto');
const {URL}=require('node:url');
const {Pool}=require('pg');
const fs=require('node:fs');
const {createIdentityService}=require('./backend/identity/service');
const {createNativeMfaProvider}=require('./backend/identity/native-mfa-provider');
const {createSmtpMailProvider}=require('./backend/identity/smtp-mail-provider');
const {createIdentityHttpHandler}=require('./backend/identity/http');
const {createSyncService}=require('./backend/domain/sync-service');
const {createMediaStorage}=require('./backend/domain/media-storage');
const {createFilesystemObjectStore}=require('./backend/domain/filesystem-object-store');
const {createProofMediaHttpHandler}=require('./backend/domain/proof-media-http');
const {createSyncHttpHandler}=require('./backend/domain/sync-http');
const {createDomainQueryRepository}=require('./backend/domain/query-repository');
const {createDomainQueryService}=require('./backend/domain/query-service');
const {createDomainQueryHttpHandler}=require('./backend/domain/query-http');
const {createDeliveryQrService}=require('./backend/domain/delivery-qr');
const {createDeliveryQrHttpHandler}=require('./backend/domain/delivery-qr-http');
const {createLogisticsService}=require('./backend/logistics/service');
const {createLogisticsHttpHandler}=require('./backend/logistics/http');
const {createTerritorialAnalyticsService}=require('./backend/analytics/territorial-service');
const {createTerritorialAnalyticsHttpHandler}=require('./backend/analytics/territorial-http');
const {createAdminRepository}=require('./backend/admin/repository');
const {createAdminService}=require('./backend/admin/service');
const {createAdminHttpHandler}=require('./backend/admin/http');
const {PROVIDERS}=require('./backend/integrations/registry');
const {loadRuntimeConfig,hostAllowed,resolveClientAddress}=require('./backend/runtime/config');
const {loadSecretProvider,loadLocalSecretProvider}=require('./backend/runtime/secret-provider');
const {gracefulShutdown}=require('./backend/runtime/lifecycle');

function bootstrapFailure(error){
  if(require.main===module){process.stderr.write(`${JSON.stringify({event:'http.bootstrap_failed',code:/^ROTAMOTO_CONFIG_/u.test(error?.code||'')?error.code:'STARTUP_CONFIGURATION_INVALID'})}\n`);process.exit(1)}
  throw error;
}
let CONFIG;
try{CONFIG=loadRuntimeConfig()}catch(error){bootstrapFailure(error)}
const PORT=CONFIG.port;
const HOST=CONFIG.host;
const ALLOWED_ORIGINS=CONFIG.allowedOrigins;
const databaseUrl=new URL(CONFIG.databaseUrl);
let secretProvider=null,databaseTlsCa=null;
try{if(CONFIG.production){secretProvider=CONFIG.secretProviderModule?loadSecretProvider(CONFIG.secretProviderModule):loadLocalSecretProvider({directory:CONFIG.secretStoreDirectory,masterKeyFile:CONFIG.secretMasterKeyFile});databaseTlsCa=fs.readFileSync(CONFIG.databaseTlsCaFile,'utf8')}}catch(error){bootstrapFailure(error)}
function runtimeDatabaseConnectionString(value=CONFIG.databaseUrl){
  const parsed=new URL(value);
  if(!['postgres:','postgresql:'].includes(parsed.protocol)||decodeURIComponent(parsed.username)!=='rotamoto_app'||parsed.password||parsed.pathname!=='/rotamoto')
    throw new Error('DATABASE_URL deve apontar sem senha para rotamoto_app no banco rotamoto.');
  return value;
}
const identityPool=new Pool({connectionString:runtimeDatabaseConnectionString(),...(secretProvider?{password:async()=>{const provider=await secretProvider;return provider.getDatabasePassword({host:databaseUrl.hostname,port:Number(databaseUrl.port||5432),database:'rotamoto',user:'rotamoto_app'})}}:{}),...(databaseTlsCa?{ssl:{ca:databaseTlsCa,rejectUnauthorized:true}}:{}),max:5,allowExitOnIdle:true,connectionTimeoutMillis:1500,application_name:'rotamoto-http-runtime',statement_timeout:5000,idleTimeoutMillis:10000});
identityPool.on('error',error=>console.error(JSON.stringify({event:'postgres.pool.error',code:/^[A-Z0-9_]{2,10}$/u.test(error?.code||'')?error.code:'DATABASE_ERROR'})));
let smtpProviderPromise=null;
const emailProvider=CONFIG.smtp?.host?{async send(message){if(!smtpProviderPromise)smtpProviderPromise=(async()=>{const secrets=await secretProvider;if(!secrets)throw new Error('Secret provider indisponível.');const password=await secrets.get(CONFIG.smtp.passwordRef,{name:'smtp/password',scope:'installation'});return createSmtpMailProvider({...CONFIG.smtp,password})})();return (await smtpProviderPromise).send(message)}}:null;
let nativeMfaPromise=null;
const mfaProvider=secretProvider?{async verify(input){if(!nativeMfaPromise)nativeMfaPromise=(async()=>createNativeMfaProvider({secretProvider:await secretProvider}))();return (await nativeMfaPromise).verify(input)}}:null;
const identityService=createIdentityService({pool:identityPool,emailProvider,mfaProvider,secretProvider});
const requestLogger=entry=>console.info(JSON.stringify(entry));
const identityHttp=createIdentityHttpHandler({identityService,logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});
let mediaProviderPromise=null;
async function getMediaStorage(){if(!CONFIG.mediaDirectory)return createMediaStorage();if(!mediaProviderPromise)mediaProviderPromise=createFilesystemObjectStore({directory:CONFIG.mediaDirectory}).then(objectStore=>createMediaStorage({objectStore}));return mediaProviderPromise}
const mediaStorage=Object.freeze({configured:()=>Boolean(CONFIG.mediaDirectory),status:()=>CONFIG.mediaDirectory?{configured:true,provider:'filesystem-v1'}:{configured:false,provider:null},
  async storeProof(value){return(await getMediaStorage()).storeProof(value)},async validateReference(ref,metadata){return(await getMediaStorage()).validateReference(ref,metadata)},
  async read(ref,metadata){return(await getMediaStorage()).read(ref,metadata)},async remove(ref){return(await getMediaStorage()).remove(ref)}});
const proofMediaHttp=createProofMediaHttpHandler({identityService,mediaStorage,allowedOrigin:ALLOWED_ORIGINS});
const syncService=createSyncService({mediaStorage});
const syncHttp=createSyncHttpHandler({identityService,syncService,logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});
const domainQueryService=createDomainQueryService({repository:createDomainQueryRepository()});
const domainQueryHttp=createDomainQueryHttpHandler({identityService,queryService:domainQueryService,logger:()=>{}});
const deliveryQrService=CONFIG.deliveryQrKeyRef&&secretProvider?createDeliveryQrService({
  secretProvider:{get:(ref,context)=>Promise.resolve(secretProvider).then(provider=>provider.get(ref,context))},
  keyRef:CONFIG.deliveryQrKeyRef,kid:CONFIG.deliveryQrKeyId
}):null;
const deliveryQrHttp=createDeliveryQrHttpHandler({identityService,queryService:domainQueryService,qrService:deliveryQrService,logger:()=>{}});
const logisticsService=createLogisticsService();
const logisticsHttp=createLogisticsHttpHandler({identityService,logisticsService,logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});
const territorialAnalyticsHttp=createTerritorialAnalyticsHttpHandler({identityService,service:createTerritorialAnalyticsService(),logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});
const adminService=createAdminService({repository:createAdminRepository()});
const adminHttp=createAdminHttpHandler({identityService,adminService,logger:()=>{},allowedOrigin:ALLOWED_ORIGINS});


function json(res,status,payload){const body=JSON.stringify(payload),origin=res.req?.headers.origin;const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",'Vary':'Origin',...(CONFIG.production?{'Strict-Transport-Security':'max-age=31536000; includeSubDomains'}:{}),...(res.req?.requestId?{'X-Request-ID':res.req.requestId}:{})};if(ALLOWED_ORIGINS.includes(origin)){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Credentials']='true'}res.writeHead(status,headers);res.end(body)}
function assertLoopbackHost(host=HOST){const value=String(host).toLowerCase().replace(/^\[|\]$/g,'');if(!['127.0.0.1','::1','localhost'].includes(value))throw new Error('O servidor de integrações não possui autenticação de usuário; mantenha HOST em loopback e exponha acesso remoto somente por um proxy autenticado que encaminhe para loopback.');return true}
let shuttingDown=false;
async function databaseReadiness(pool=identityPool){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='1500ms'");
    const result=await client.query(`SELECT current_user AS role,
      to_regclass('rotamoto.domain_records') IS NOT NULL AS domain_ready,
      to_regclass('rotamoto.sync_installations') IS NOT NULL AS sync_installations_ready,
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('rotamoto.sessions') AND attname='mfa_verified_at' AND NOT attisdropped) AS mfa_schema_ready,
      EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('rotamoto.memberships') AND attname='driver_id' AND NOT attisdropped) AS membership_driver_ready,
      to_regclass('rotamoto.logistics_providers') IS NOT NULL AND to_regclass('rotamoto.delivery_fulfillments') IS NOT NULL
        AND to_regclass('rotamoto.dispatch_attempts') IS NOT NULL AS logistics_schema_ready,
      to_regclass('rotamoto.delivery_geo_snapshots') IS NOT NULL AS territorial_analytics_schema_ready`);
    await client.query('COMMIT');
    return result.rows[0]?.role==='rotamoto_app'&&result.rows[0]?.domain_ready===true&&result.rows[0]?.sync_installations_ready===true&&result.rows[0]?.mfa_schema_ready===true&&result.rows[0]?.membership_driver_ready===true&&result.rows[0]?.logistics_schema_ready===true&&result.rows[0]?.territorial_analytics_schema_ready===true;
  }catch(error){try{await client.query('ROLLBACK')}catch(_){}throw error}
  finally{client.release()}
}
async function route(req,res){
  const startedAt=Date.now();
  req.requestId=crypto.randomUUID();
  res.req=req;
  req.clientIp=resolveClientAddress(req,CONFIG);
  if(!hostAllowed(req.headers.host,CONFIG.allowedHosts,CONFIG.production)){requestLogger({event:'http.rejected_host',requestId:req.requestId});return json(res,421,{error:{code:'HOST_INVALID',message:'Host não permitido.'},requestId:req.requestId});}
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  if(CONFIG.production)res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
  if(ALLOWED_ORIGINS.includes(req.headers.origin)){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Vary','Origin')}
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='OPTIONS'){
      if(!ALLOWED_ORIGINS.includes(req.headers.origin))return json(res,403,{error:{code:'ORIGIN_INVALID',message:'Origem não permitida.'},requestId:req.requestId});
      res.writeHead(204,{'Access-Control-Allow-Origin':req.headers.origin,'Access-Control-Allow-Credentials':'true',
        'Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token',
        'Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,OPTIONS','Access-Control-Max-Age':'600','Vary':'Origin','X-Request-ID':req.requestId});
      return res.end();
    }
    if(shuttingDown&&u.pathname!=='/health/live')return json(res,503,{status:'shutting_down',requestId:req.requestId});
    if(await identityHttp(req,res))return;
    if(await adminHttp(req,res))return;
    if(await proofMediaHttp(req,res))return;
    if(await domainQueryHttp(req,res))return;
    if(await deliveryQrHttp(req,res))return;
  if(await territorialAnalyticsHttp(req,res))return;
  if(await logisticsHttp(req,res))return;
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

async function startServer({pool=identityPool,config=CONFIG,logger=entry=>console.info(JSON.stringify(entry))}={}){
  assertLoopbackHost(config.host);
  if(config.mediaDirectory)await getMediaStorage();
  if(!await databaseReadiness(pool))throw new Error('Schema PostgreSQL incompatível com a versão do servidor.');
  const server=http.createServer({maxHeaderSize:16*1024},route);
  server.requestTimeout=config.requestTimeoutMs;server.headersTimeout=config.headersTimeoutMs;server.keepAliveTimeout=config.keepAliveTimeoutMs;server.maxHeadersCount=100;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve)});
  logger({event:'http.started',host:config.host,port:config.port,environment:config.nodeEnv});
  let closing;
  const shutdown=signal=>{
    if(closing)return closing;
    shuttingDown=true;logger({event:'http.shutdown_started',signal});
    closing=gracefulShutdown({server,pool,timeoutMs:config.shutdownTimeoutMs,onTimeout:()=>logger({event:'http.shutdown_timeout'})})
      .then(()=>logger({event:'http.stopped'}),error=>{logger({event:'http.shutdown_error',code:/^[A-Z0-9_]{2,10}$/u.test(error?.code||'')?error.code:'SHUTDOWN_ERROR'});process.exitCode=1})
      .finally(()=>{process.removeListener('SIGTERM',onSigterm);process.removeListener('SIGINT',onSigint)});
    return closing;
  };
  const onSigterm=()=>{void shutdown('SIGTERM')};const onSigint=()=>{void shutdown('SIGINT')};
  process.once('SIGTERM',onSigterm);process.once('SIGINT',onSigint);
  return{server,shutdown,removeSignalHandlers(){process.removeListener('SIGTERM',onSigterm);process.removeListener('SIGINT',onSigint)}};
}

if(require.main===module){startServer().catch(error=>{console.error(JSON.stringify({event:'http.start_failed',code:/^[A-Z0-9_]{2,10}$/u.test(error?.code||'')?error.code:'STARTUP_CONFIGURATION_OR_DATABASE'}));process.exitCode=1;identityPool.end().catch(()=>{});});}
module.exports={route,assertLoopbackHost,runtimeDatabaseConnectionString,databaseReadiness,startServer,PROVIDERS,CONFIG};
