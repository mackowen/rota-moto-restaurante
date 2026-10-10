((root,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RotaMotoSyncReconciliation=api})(globalThis,()=>{
 'use strict';
 const ENTITIES=new Set(['Order','Delivery','Route','Driver','Earning','DeliveryEvent','LocationPoint','DeliveryProof']);
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
 function canonicalEvent(raw,companyId){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!UUID.test(String(raw.eventId||''))||raw.protocolVersion!==1||!ENTITIES.has(raw.entity)||!UUID.test(String(raw.entityId||''))||!['CANONICAL_RECORD_UPSERTED','CANONICAL_RECORD_TOMBSTONED'].includes(raw.type))throw new Error('CANONICAL_EVENT_INVALID');
  const payload=raw.payload;if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('CANONICAL_PAYLOAD_INVALID');
  if(payload.companyId&&payload.companyId!==companyId)throw new Error('CANONICAL_TENANT_MISMATCH');
  const version=Number(payload.version);if(!Number.isSafeInteger(version)||version<1)throw new Error('CANONICAL_VERSION_INVALID');
  if(raw.type==='CANONICAL_RECORD_UPSERTED'&&String(payload.id)!==String(raw.entityId))throw new Error('CANONICAL_ID_MISMATCH');
  return {eventId:raw.eventId,type:raw.type,entity:raw.entity,entityId:raw.entityId,version,payload:{...payload},occurredAt:raw.occurredAt};
 }
 function decide({localVersion=0,localPending=false,priorStatus=null,incomingVersion,tombstone=false,confirmedCanonicalAck=false}){
  if(!Number.isSafeInteger(Number(incomingVersion))||Number(incomingVersion)<1)return 'invalid';
  if(localPending||['rejected','conflict'].includes(priorStatus))return 'conflict';
  if(Number(localVersion)===Number(incomingVersion)&&confirmedCanonicalAck)return tombstone?'tombstone':'apply';
  if(Number(localVersion)>=Number(incomingVersion))return 'stale';
  return tombstone?'tombstone':'apply';
 }
 function statusFromAck(status){return ['accepted','duplicate','rejected','conflict'].includes(status)?status:'invalid'}
 function retryAfterMilliseconds(value,now=Date.now()){
  if(typeof value!=='string'||!value.trim())return null;
  const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;
  const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-now):null;
 }
 const ACK_ARRAY_ENTITIES=Object.freeze({orders:'Order',drivers:'Driver',deliveries:'Delivery',routes:'Route',deliveryEvents:'DeliveryEvent',locationUpdates:'LocationPoint',proofs:'DeliveryProof',earnings:'Earning'});
 const ACK_TOMBSTONE_ENTITIES=Object.freeze({orders:'Order',drivers:'Driver',deliveries:'Delivery',routes:'Route',deliveryEvents:'DeliveryEvent',locations:'LocationPoint',locationUpdates:'LocationPoint',proofs:'DeliveryProof',earnings:'Earning'});
 function expectedAckOperations(packet){
  if(!packet||typeof packet!=='object'||Array.isArray(packet)||!packet.data||typeof packet.data!=='object'||Array.isArray(packet.data))throw new Error('SYNC_ACK_INVALID');
  const expected=new Map();
  const add=(operation,entity,row)=>{const localId=entity==='DeliveryEvent'?(row?.eventId||row?.id):row?.id;if(typeof localId!=='string'||!localId.trim())throw new Error('SYNC_ACK_INVALID');expected.set(operation,{entity,localId})};
  for(const [key,entity] of Object.entries(ACK_ARRAY_ENTITIES)){const rows=packet.data[key];if(rows===undefined)continue;if(!Array.isArray(rows))throw new Error('SYNC_ACK_INVALID');rows.forEach((row,index)=>add(`${key}:${index}`,entity,row))}
  if(packet.data.tombstones!==undefined){if(!Array.isArray(packet.data.tombstones))throw new Error('SYNC_ACK_INVALID');packet.data.tombstones.forEach((row,index)=>{const entity=ACK_TOMBSTONE_ENTITIES[row?.store];if(!entity)throw new Error('SYNC_ACK_INVALID');add(`tombstones:${index}`,entity,row)})}
  const events=packet.events!==undefined?packet.events:packet.data.events;if(events!==undefined){if(!Array.isArray(events))throw new Error('SYNC_ACK_INVALID');events.forEach((row,index)=>add(`events:${index}`,'DeliveryEvent',row))}
  return expected;
 }
 function validateOperationAck(packet,ack,{companyId=packet?.companyId,deviceId=packet?.deviceId}={}){
  if(!ack||typeof ack!=='object'||Array.isArray(ack)||ack.packetId!==packet?.packetId||!packet?.packetId||
   typeof companyId!=='string'||!companyId||packet.companyId!==companyId||ack.companyId!==companyId||
   typeof deviceId!=='string'||!deviceId||packet.deviceId!==deviceId||
   (ack.deviceId!==undefined&&ack.deviceId!==deviceId)||!Array.isArray(ack.operationResults))throw new Error('SYNC_ACK_INVALID');
  const expected=expectedAckOperations(packet),seen=new Set();
  for(const result of ack.operationResults){
   if(!result||typeof result!=='object'||Array.isArray(result)||typeof result.operation!=='string'||seen.has(result.operation))throw new Error('SYNC_ACK_INVALID');
   const operation=expected.get(result.operation),status=statusFromAck(result.status);
   if(!operation||result.entity!==operation.entity||result.localId!==operation.localId||status==='invalid')throw new Error('SYNC_ACK_INVALID');
   if(['accepted','duplicate'].includes(status)&&
    (typeof result.canonicalId!=='string'||!UUID.test(result.canonicalId)||!Number.isSafeInteger(result.canonicalVersion)||result.canonicalVersion<1))throw new Error('SYNC_ACK_INVALID');
   if(['rejected','conflict'].includes(status)&&(!result.error||typeof result.error.code!=='string'||!result.error.code.trim()))throw new Error('SYNC_ACK_INVALID');
   seen.add(result.operation);
  }
  if(seen.size!==expected.size)throw new Error('SYNC_ACK_INVALID');
  return true;
 }
 function sourceVersionMatches(record,snapshot){return !!record&&Number(record?.sync?.version||record?.version||1)===Number(snapshot)}
 function canonicalBaseVersion(record,operation){
  const currentId=String(record?.sync?.canonicalId||record?.id||''),operationId=String(operation?.canonicalId||'');
  const observed=Number(record?.sync?.canonicalVersion),acknowledged=Number(operation?.canonicalVersion);
  const valid=value=>Number.isSafeInteger(value)&&value>0;
  if(operationId&&currentId&&operationId!==currentId)return valid(observed)?observed:(valid(acknowledged)?acknowledged:null);
  const versions=[observed,acknowledged].filter(valid);return versions.length?Math.max(...versions):null;
 }
 function captureSourceVersions(packetData={},sourceData={}){
  const out={};
  for(const [key,entity,sourceKey] of [['orders','Order','orders'],['deliveries','Delivery','deliveries'],['drivers','Driver','bikes'],['routes','Route','routes'],['earnings','Earning','earnings']]){
   const sources=new Map((sourceData[sourceKey]||[]).filter(Boolean).map(row=>[row.id,row]));
   for(const row of packetData[key]||[]){const source=sources.get(row.id)||row;out[`${entity}:${row.id}`]=Number(source?.sync?.version||source?.version||1)}
  }
  const deliveries=new Map((sourceData.deliveries||[]).filter(Boolean).map(row=>[row.id,row]));
  for(const row of packetData.tombstones||[]){const source=deliveries.get(row.id)||row;out[`Delivery:${row.id}`]=Number(source?.sync?.version||source?.version||1)}
  return out;
 }
 function retryDelay({status,retryAfterMs}={},attempt=0,{baseMs=1000,maxMs=60000}={}){
  if(status!==408&&status!==429&&!(Number(status)>=500))return null;
  if(Number.isFinite(Number(retryAfterMs))&&Number(retryAfterMs)>0)return Math.min(300000,Math.max(1000,Number(retryAfterMs)));
  return Math.min(maxMs,baseMs*(2**Math.min(10,Math.max(0,Number(attempt)||0))));
 }
 function hasCurrentCanonicalAck(record,canonicalId,operation){return !!record&&!!operation&&['accepted','duplicate'].includes(operation.status)&&
  String(operation.canonicalId||'')===String(canonicalId||'')&&Number(operation.sourceVersion)===Number(record.sync?.version||record.version||1)}
 function shouldRetry(status,changed){return status==='pending'||(['accepted','duplicate'].includes(status)&&changed)||(['rejected','conflict'].includes(status)&&changed)}
 function findCanonicalFact(rows,canonicalId,syncMap,operationKey){return (rows||[]).find(row=>(row.eventId||row.id)===canonicalId||syncMap?.get(operationKey(row))?.canonicalId===canonicalId)||null}
 function compactInbox(rows,{keep=1500}={}){
  const resolved=(rows||[]).filter(row=>row.status==='reconciled').sort((a,b)=>Number(b.receivedAt||0)-Number(a.receivedAt||0));
  const remove=new Set(resolved.slice(keep).map(row=>row.id));return remove;
 }
 function projectMotoboyDelivery(remote,order={},current={}, {pendingExecution=false,tombstone=false}={}){
  const status=remote.status||'ASSIGNED', localStatus={CREATED:'open',ASSIGNED:'open',ACCEPTED:'open',PICKED_UP:'route',OUT_FOR_DELIVERY:'route',ARRIVED:'arrived',DELIVERED:'done',CANCELLED:'cancelled',FAILED:'issue',RETURNED:'issue',REDELIVERY:'open'}[status];
  if(!localStatus)throw new Error('CANONICAL_DELIVERY_STATUS_INVALID');
  const coords=Array.isArray(order.coords)?order.coords:null,lat=order.latitude??order.lat??coords?.[0]??current.lat,lng=order.longitude??order.lng??coords?.[1]??current.lng;
  const cancelled=tombstone||status==='CANCELLED';
  return {...current,...remote,id:current.id||remote.id,deliveryId:remote.id,orderId:remote.orderId||order.id||current.orderId||null,
   driverId:remote.driverId||current.driverId||null,companyId:remote.companyId||order.companyId||current.companyId,
   canonicalStatus:status,status:cancelled?'cancelled':pendingExecution?current.status:localStatus,
   acceptedAt:pendingExecution?current.acceptedAt:remote.acceptedAt||current.acceptedAt,
   startedAt:pendingExecution?current.startedAt:remote.pickedUpAt||current.startedAt,
   arrivedAt:pendingExecution?current.arrivedAt:remote.arrivedAt||current.arrivedAt,
   completedAt:pendingExecution?current.completedAt:remote.completedAt||current.completedAt,
   distanceKm:current.distanceKm??(Number.isFinite(Number(remote.estimatedDistanceM))?Number(remote.estimatedDistanceM)/1000:current.distanceKm),
   actualDistanceM:pendingExecution?current.actualDistanceM:remote.actualDistanceM??current.actualDistanceM,
   client:order.customer?.name||order.customer||current.client||'',phone:order.phone||order.customer?.phone||current.phone||'',
   address:order.address||current.address||'',lat:Number.isFinite(Number(lat))?Number(lat):null,lng:Number.isFinite(Number(lng))?Number(lng):null,
   orderNo:order.num||order.orderNo||current.orderNo||'',value:order.value??order.deliveryFee??current.value??0,
   deliveryFee:order.deliveryFee??order.value??current.deliveryFee??null,notes:order.obs||order.notes||current.notes||'',
   items:Array.isArray(order.items)?order.items:current.items||[],deleted:!!(tombstone||remote.deletedAt||remote.deleted),
   sync:{...(current.sync||{}),state:pendingExecution?'conflict':'synced',canonicalId:remote.id,canonicalVersion:Number(remote.version||1)}};
 }
 function projectRestaurantDelivery(remote,current={},{pendingPlanning=false,tombstone=false}={}){
  const admin=['driverId','priority','assignedAt','estimatedDistanceM'];const result={...current,...remote,id:current.id||remote.id,canonicalId:remote.id,
   status:tombstone?'CANCELLED':remote.status,deleted:!!(tombstone||remote.deletedAt||remote.deleted),
   sync:{...(current.sync||{}),state:pendingPlanning?'conflict':'synced',canonicalId:remote.id,canonicalVersion:Number(remote.version||1)}};
  if(pendingPlanning)for(const key of admin)if(Object.hasOwn(current,key))result[key]=current[key];
  if(pendingPlanning&&Object.hasOwn(current,'status'))result.status=current.status;
  return result;
 }
 function projectRestaurantOrderFromDelivery(order,delivery,{pendingOrder=false}={}){
  if(!order||!delivery||pendingOrder)return order;
  const status=({CREATED:'AGUARDANDO',ASSIGNED:'ATRIBUIDA',ACCEPTED:'ATRIBUIDA',PICKED_UP:'EM_ROTA',OUT_FOR_DELIVERY:'EM_ROTA',ARRIVED:'CHEGOU',DELIVERED:'FINALIZADA',CANCELLED:'CANCELADA',FAILED:'EM_ROTA',RETURNED:'EM_ROTA',REDELIVERY:'ATRIBUIDA'})[delivery.status];
  if(!status)return order;
  return {...order,status,canonicalStatus:delivery.status,deliveryStatus:delivery.status,
   updatedAt:delivery.updatedAt||order.updatedAt,
   ...(delivery.status==='DELIVERED'?{completedAt:delivery.completedAt||delivery.updatedAt||order.completedAt}:{})};
 }
 function isSupersededRestaurantDeliveryOperation(local,remote,operation){
  if(!local||!remote||operation?.status!=='conflict'||
   !['ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','DELIVERED','CANCELLED','FAILED','RETURNED'].includes(remote.status)||
   String(operation.canonicalId||'')!==String(remote.id||'')||
   Number(operation.sourceVersion)!==Number(local.sync?.version||local.version||1))return false;
  return ['orderId','driverId','priority','assignedAt','estimatedDistanceM']
   .every(field=>JSON.stringify(local[field])===JSON.stringify(remote[field]));
 }
 function createCoordinator({locks,lockName='rotamoto-sync'}={}){let active=null;return Object.freeze({run(task){if(typeof task!=='function')return Promise.reject(new TypeError('Tarefa de sync inválida.'));if(active)return active;const execute=()=>Promise.resolve().then(task);active=locks?.request?locks.request(lockName,{mode:'exclusive'},execute):execute();return active.finally(()=>{active=null})}})}
 return Object.freeze({canonicalEvent,decide,statusFromAck,expectedAckOperations,validateOperationAck,sourceVersionMatches,canonicalBaseVersion,captureSourceVersions,retryAfterMilliseconds,retryDelay,hasCurrentCanonicalAck,shouldRetry,findCanonicalFact,compactInbox,createCoordinator,projectMotoboyDelivery,projectRestaurantDelivery,projectRestaurantOrderFromDelivery,isSupersededRestaurantDeliveryOperation});
});
