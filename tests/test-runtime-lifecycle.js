'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
const {gracefulShutdown}=require('../backend/runtime/lifecycle');
const {startServer,CONFIG}=require('../server');

async function main(){
  const server=http.createServer((_req,res)=>res.end('ok'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let poolClosed=false;
  await gracefulShutdown({server,pool:{async end(){poolClosed=true}},timeoutMs:1000});
  assert.equal(poolClosed,true,'pool closes after the listener drains');
  const forced=[];
  await gracefulShutdown({server:{close(){},closeIdleConnections(){},closeAllConnections(){forced.push('connections')}},
    pool:{async end(){forced.push('pool')}},timeoutMs:5,onTimeout(){forced.push('timeout')}});
  assert.deepEqual(forced,['timeout','connections','pool']);
  const events=[];
  const pool={async connect(){return{async query(sql){
    if(sql.includes('to_regclass'))return{rows:[{role:'rotamoto_app',domain_ready:true,sync_installations_ready:true,mfa_schema_ready:true,membership_driver_ready:true,logistics_schema_ready:true,territorial_analytics_schema_ready:true}]};
    if(sql.includes('current_user'))return{rows:[{role:'rotamoto_app'}]};return{rows:[]};
  },release(){}}},async end(){events.push('pool_closed')}};
  const started=await startServer({pool,config:{...CONFIG,port:0},logger:event=>events.push(event.event)});
  assert(started.server.listening);
  await started.shutdown('test');started.removeSignalHandlers();
  assert.deepEqual(events,['http.started','http.shutdown_started','pool_closed','http.stopped']);
  console.log('runtime graceful shutdown tests: OK');
}
main().catch(error=>{console.error(error);process.exitCode=1});
