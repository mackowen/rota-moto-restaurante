'use strict';

const readline=require('node:readline/promises');
const {stdin,stdout}=require('node:process');
const {Pool}=require('pg');

function resolveTarget(env=process.env){
 let value,database;
 if(env.NODE_ENV==='test'&&env.ROTAMOTO_E2E_CAMPAIGN==='0255'){
  value=env.E2E_MIGRATOR_DATABASE_URL;database='rotamoto_e2e';
 }else if(env.NODE_ENV==='production'&&env.ROTAMOTO_PLATFORM_FOUNDER_BOOTSTRAP==='0255'&&env.ROTAMOTO_PLATFORM_CONFIRM_DATABASE==='rotamoto'){
  value=env.MIGRATOR_DATABASE_URL;database='rotamoto';
 }else throw new Error('Bootstrap fundador exige contexto explícito de E2E ou autorização operacional de produção.');
 let parsed;try{parsed=new URL(value)}catch(_){throw new Error('URL local do operador inválida.')}
 if(!['postgres:','postgresql:'].includes(parsed.protocol)||decodeURIComponent(parsed.username)!=='rotamoto_migrator'||parsed.password||parsed.hostname!=='127.0.0.1'||(parsed.port||'5432')!=='5432'||parsed.pathname!==`/${database}`||parsed.search||parsed.hash)throw new Error('Conexão do bootstrap deve usar rotamoto_migrator via loopback e o banco explicitamente selecionado.');
 return {value,database};
}
async function main(){
 if(!stdin.isTTY||!stdout.isTTY)throw new Error('Bootstrap fundador exige terminal interativo.');
 const target=resolveTarget(),rl=readline.createInterface({input:stdin,output:stdout});let pool;
 try{
  const email=(await rl.question('Email verificado da identidade fundadora: ')).trim().toLowerCase();
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email))throw new Error('Email inválido.');
  const confirm=(await rl.question(`Confirme digitando PROMOVER ADMIN GLOBAL ${email}: `)).trim();
  if(confirm!==`PROMOVER ADMIN GLOBAL ${email}`)throw new Error('Confirmação não corresponde; nenhuma alteração aplicada.');
  pool=new Pool({connectionString:target.value,max:1,application_name:'rotamoto-founder-bootstrap',connectionTimeoutMillis:3000});
  const check=await pool.query('SELECT current_database() AS database,session_user AS session_user,current_user AS current_user');
  if(check.rows[0]?.database!==target.database||check.rows[0]?.session_user!=='rotamoto_migrator'||check.rows[0]?.current_user!=='rotamoto_migrator')throw new Error('Identidade ou banco conectado não corresponde ao alvo autorizado.');
  const result=await pool.query('SELECT rotamoto.platform_admin_bootstrap_founder($1)::text AS user_id',[email]);
  stdout.write(`Bootstrap fundador concluído no banco ${target.database}; identidade verificada.\n`);
  return result.rows[0].user_id;
 }finally{if(pool)await pool.end();rl.close()}
}
if(require.main===module)main().catch(error=>{process.stderr.write(`Bootstrap fundador não executado: ${error.message}\n`);process.exitCode=1});
module.exports={resolveTarget};
