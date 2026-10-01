'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
const start=source.indexOf('async function receiveMotoboyData('),end=source.indexOf('\nasync function stageMotoboyPacket',start);
assert(start>=0&&end>start,'packet receiver should be present');
const receiver=source.slice(start,end);

// Models transaction-scoped writes and rollback at the production transaction boundary.
// It does not emulate IndexedDB scheduling, schema upgrades, or browser implementation details.
function makeDatabase(seed={}){
 const data=new Map(Object.entries(seed).map(([name,rows])=>[name,new Map(rows.map(row=>[row.id??row.key,structuredClone(row)]))]));let shouldAbort=false,shouldError=false;
 return {data,abortNext(){shouldAbort=true},errorNext(){shouldError=true},transaction(names){
  const selected=Array.isArray(names)?names:[names],staged=new Map(selected.map(name=>[name,new Map(data.get(name)||[])])),reads=[];let aborted=false;
  const tx={error:null,objectStore(name){assert(selected.includes(name),`store ${name} outside transaction`);const store=staged.get(name);return {
   get(key){const request={result:undefined,error:null};reads.push(()=>{request.result=structuredClone(store.get(key));request.onsuccess?.()});return request},
   put(value){store.set(value.id??value.key,structuredClone(value))},delete(key){store.delete(key)},clear(){store.clear()}
  }},abort(){aborted=true;tx.error=new Error('simulated abort')}};
  setTimeout(()=>{try{reads.forEach(read=>read());if(shouldError){shouldError=false;tx.error=new Error('simulated request failure');tx.onerror?.();tx.abort()}if(shouldAbort){shouldAbort=false;tx.abort()}if(!aborted){for(const [name,rows] of staged)data.set(name,rows);tx.oncomplete?.()}else tx.onabort?.()}catch(error){tx.error=error;tx.onabort?.()}},0);
  return tx;
 }};
}
const db=makeDatabase({meta:[{key:'settings',value:{stable:true}},{key:'syncReceipts',value:[]}],deliveries:[],deliveryEvents:[]});
const contract={timestampMs:value=>value?Date.parse(value):null,normalizeDeliveryStatus:value=>value||'CREATED',isNewer:()=>true,assertTransition(){}};
const effects={successEvents:0,renders:0};
const context=vm.createContext({
 Error,Date,JSON,Promise,Array,Object,Number,Set,console,db,RotaMotoContract:contract,
 state:{deliveryEvents:[],deliveries:[],orders:[],settings:{global:{companyId:'company_local',sync:{status:'ready',revision:2}}}},
 getMeta:async key=>db.data.get('meta').get(key)?.value,
 validateMotoboyPacket:async packet=>({valid:true,errors:[],packetId:packet.packetId,companyId:'company_local'}),
 canonicalToRestaurantStatus:()=>null,recordOrderStatus(){},event(type){if(type==='success')effects.successEvents++},render(){effects.renders++},filterEvents(){},uid:()=> 'panel-fixed',
});
vm.runInContext(`${receiver}\nthis.receive=receiveMotoboyData;`,context);
const packet={packetId:'packet-1',deviceId:'rider-1',receivedAt:1790856000000,data:{deliveries:[{id:'delivery-1',companyId:'company_local',status:'OUT_FOR_DELIVERY',updatedAt:'2026-10-01T12:00:00.000Z',version:2}],deliveryEvents:[{id:'event-1',eventId:'event-1',deliveryId:'delivery-1',type:'started'}]}};
const snapshot=()=>JSON.stringify(Object.fromEntries([...db.data].map(([name,rows])=>[name,[...rows.values()]])));
async function run(){
 const memoryBefore=JSON.stringify({deliveries:context.state.deliveries,events:context.state.deliveryEvents,settings:context.state.settings});const persistedBefore=snapshot();
 db.errorNext();
 await assert.rejects(context.receive(packet),/simulated request failure/);
 assert.equal(snapshot(),persistedBefore,'request error must roll back domain, receipt, and settings writes');
 assert.equal(JSON.stringify({deliveries:context.state.deliveries,events:context.state.deliveryEvents,settings:context.state.settings}),memoryBefore,'request error must not advance memory');
 assert.equal(effects.successEvents,0);assert.equal(effects.renders,0);
 db.abortNext();
 await assert.rejects(context.receive(packet),/abort|cancel/i);
 assert.equal(snapshot(),persistedBefore,'aborted packet must not persist partial domain, receipt, or settings writes');
 assert.equal(JSON.stringify({deliveries:context.state.deliveries,events:context.state.deliveryEvents,settings:context.state.settings}),memoryBefore,'aborted packet must not advance memory');
 assert.equal(effects.successEvents,0,'aborted packet must not record success');assert.equal(effects.renders,0);

 const applied=await context.receive(packet);assert.equal(applied.duplicate,false);
 assert.equal(context.state.deliveries.length,1);assert.equal(context.state.deliveryEvents.length,1);
 assert(db.data.get('meta').get('syncReceipts').value.includes('packet-1'));
 assert.equal(db.data.get('meta').get('settings').value.global.sync.lastPacketId,'packet-1');
 assert.equal(db.data.get('deliveries').size,1);assert.equal(db.data.get('deliveryEvents').size,1);
 const committed=snapshot();const repeated=await context.receive(packet);
 assert.equal(repeated.duplicate,true);assert.equal(snapshot(),committed,'replayed packet must be idempotent');
 assert.equal(context.state.deliveries.length,1);assert.equal(context.state.deliveryEvents.length,1);
 console.log('sync persistence tests: OK');
}
run().catch(error=>{console.error(error);process.exitCode=1});
