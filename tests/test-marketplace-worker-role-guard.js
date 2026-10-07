'use strict';

const assert=require('node:assert/strict');
const {roleUrl,assertRole}=require('./test-marketplace-worker-postgres');
const key='E2E_PROVIDER_WORKER_DATABASE_URL';
const prior=process.env[key];
try{
  process.env[key]='postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e';
  assert.throws(()=>roleUrl('rotamoto_provider_worker',key),/must use rotamoto_provider_worker/u);
  process.env[key]='postgresql://rotamoto_provider_worker:secret@127.0.0.1:5432/rotamoto_e2e';
  assert.throws(()=>roleUrl('rotamoto_provider_worker',key),/without a URL password/u);
  process.env[key]='postgresql://rotamoto_provider_worker@127.0.0.1:5432/rotamoto_e2e';
  assert.equal(roleUrl('rotamoto_provider_worker',key),process.env[key]);
}finally{if(prior===undefined)delete process.env[key];else process.env[key]=prior;}
(async()=>{
  await assert.rejects(()=>assertRole({query:async()=>({rows:[{role:'rotamoto_migrator',session_role:'rotamoto_migrator'}]})},'rotamoto_provider_worker'),/never rotamoto_migrator/u);
  await assertRole({query:async()=>({rows:[{role:'rotamoto_provider_worker',session_role:'rotamoto_provider_worker'}]})},'rotamoto_provider_worker');
  process.stdout.write('Marketplace dedicated-role guard: migrator and URL-password substitutions rejected PASS\n');
})().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
