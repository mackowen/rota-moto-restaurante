'use strict';

const fs=require('node:fs');
const readline=require('node:readline/promises');
const {stdin,stdout}=require('node:process');
const {loadRuntimeConfig}=require('../backend/runtime/config');
const {createPool}=require('../backend/postgres/connection');
const {createIdentityService}=require('../backend/identity/service');
const {createFileSecretProvider}=require('../backend/runtime/file-secret-provider');
const {loadSecretProvider,loadLocalSecretProvider}=require('../backend/runtime/secret-provider');
const {appendOperatorAudit}=require('../backend/runtime/operator-audit');

async function main(){
  if(stdin.isTTY!==true||stdout.isTTY!==true||!process.argv.includes('--confirm-database=rotamoto'))
    throw new Error('Recuperação exige terminal interativo e confirmação --confirm-database=rotamoto.');
  const config=loadRuntimeConfig();
  if(config.nodeEnv==='test')throw new Error('O comando local não executa em modo de teste.');
  const actorRef=process.env.ROTAMOTO_OPERATOR_ACTOR_REF;
  if(!actorRef||!/^[A-Za-z0-9_.:@/-]{1,128}$/u.test(actorRef))throw new Error('Identidade de operador local ausente.');
  const terminal=readline.createInterface({input:stdin,output:stdout});
  let requestId;
  try{
    requestId=(await terminal.question('ID da solicitação de recuperação confirmada por email: ')).trim();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId))throw new Error('Identificador inválido.');
    if((await terminal.question('Digite RECUPERAR MFA DO PROPRIETARIO para continuar: '))!=='RECUPERAR MFA DO PROPRIETARIO')
      throw new Error('Confirmação local não reconhecida.');
  }finally{terminal.close()}
  const database=new URL(config.databaseUrl);
  if(database.pathname!=='/rotamoto'||decodeURIComponent(database.username)!=='rotamoto_app'||database.password)
    throw new Error('O procedimento local aceita somente rotamoto_app no banco rotamoto.');
  let secrets=null;
  if(config.production)secrets=config.secretProviderModule?loadSecretProvider(config.secretProviderModule):
    await loadLocalSecretProvider({directory:config.secretStoreDirectory,masterKeyFile:config.secretMasterKeyFile});
  else if(process.env.ROTAMOTO_SECRET_STORE_DIRECTORY&&process.env.ROTAMOTO_SECRET_MASTER_KEY_FILE)
    secrets=await createFileSecretProvider({directory:process.env.ROTAMOTO_SECRET_STORE_DIRECTORY,masterKeyFile:process.env.ROTAMOTO_SECRET_MASTER_KEY_FILE});
  if(!secrets)throw new Error('Keystore protegido obrigatório para recuperação de MFA.');
  const pool=createPool({connectionString:config.databaseUrl,max:2,connectionTimeoutMillis:3000,options:'-c lock_timeout=3s -c statement_timeout=30s',
    ...(config.production?{password:()=>secrets.getDatabasePassword({host:database.hostname,port:Number(database.port||5432),database:'rotamoto',user:'rotamoto_app'})}:{}),
    ...(config.databaseTlsCaFile?{ssl:{ca:fs.readFileSync(config.databaseTlsCaFile,'utf8'),rejectUnauthorized:true}}:{})});
  try{
    await appendOperatorAudit('identity.mfa.recovery.started',{database:'rotamoto'});
    const check=await pool.query('SELECT current_database() AS database,current_user AS role');
    if(check.rows[0]?.database!=='rotamoto'||check.rows[0]?.role!=='rotamoto_app')throw new Error('Conexão não corresponde ao alvo de recuperação.');
    const service=createIdentityService({pool,secretProvider:secrets,authorizeMfaRecoveryOperator:async()=>({actorRef})});
    const result=await service.approveSoleOwnerMfaRecoveryLocally(requestId);
    await appendOperatorAudit('identity.mfa.recovery.completed',{reenrollmentRequired:result.reenrollmentRequired});
    stdout.write(`${JSON.stringify({event:'identity.mfa.recovery.completed',reenrollmentRequired:true,next:'O proprietário deve entrar com a senha, concluir novo enrollment MFA e guardar os códigos de recuperação.'})}\n`);
  }finally{await pool.end()}
}
main().catch(error=>{process.stderr.write(`${JSON.stringify({event:'identity.mfa.recovery.failed',code:/^[A-Z0-9_]{2,48}$/u.test(error.code||'')?error.code:'MFA_RECOVERY_FAILED'})}\n`);process.exitCode=1});
