'use strict';
const assert=require('node:assert/strict');
const {create}=require('../platform-admin-request');
const {createLatestRequestState}=require('../identity-request-state');
function abortError(){return Object.assign(new Error('aborted'),{name:'AbortError'})}
async function main(){
  let timedOutSignal;
  const timed=create(async(_path,{signal})=>new Promise((_resolve,reject)=>{
    timedOutSignal=signal;
    signal.addEventListener('abort',()=>reject(abortError()),{once:true});
  }),{timeoutMs:15});
  await assert.rejects(timed('/users'),error=>error.code==='NETWORK_TIMEOUT');
  assert.equal(timedOutSignal.aborted,true,'timeout aborts the in-flight transport');

  const states=createLatestRequestState(),state=states.begin();let canceledSignal;
  const canceled=create(async(_path,{signal})=>new Promise((_resolve,reject)=>{
    canceledSignal=signal;
    signal.addEventListener('abort',()=>reject(abortError()),{once:true});
  }),{timeoutMs:500});
  const pending=canceled('/memberships',state,{signal:state.signal});
  await Promise.resolve();states.cancel();
  await assert.rejects(pending,error=>error.name==='AbortError'&&error.code===undefined,'navigation cancellation is preserved and is not reported as a timeout');
  assert.equal(canceledSignal.aborted,true);

  const successful=create(async path=>({items:[path]}),{timeoutMs:100});
  assert.deepEqual(await successful('/settings'),{items:['/settings']});
  process.stdout.write('platform admin request timeout, transport abort, cancellation and success: PASS\n');
}
main().catch(error=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1});
