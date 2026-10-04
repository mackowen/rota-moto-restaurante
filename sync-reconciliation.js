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
 function decide({localVersion=0,localPending=false,priorStatus=null,incomingVersion,tombstone=false}){
  if(!Number.isSafeInteger(Number(incomingVersion))||Number(incomingVersion)<1)return 'invalid';
  if(localPending||['rejected','conflict'].includes(priorStatus))return 'conflict';
  if(Number(localVersion)>=Number(incomingVersion))return 'stale';
  return tombstone?'tombstone':'apply';
 }
 function statusFromAck(status){return ['accepted','duplicate','rejected','conflict'].includes(status)?status:'invalid'}
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
 function createCoordinator({locks,lockName='rotamoto-sync'}={}){let active=null;return Object.freeze({run(task){if(typeof task!=='function')return Promise.reject(new TypeError('Tarefa de sync inválida.'));if(active)return active;const execute=()=>Promise.resolve().then(task);active=locks?.request?locks.request(lockName,{mode:'exclusive'},execute):execute();return active.finally(()=>{active=null})}})}
 return Object.freeze({canonicalEvent,decide,statusFromAck,shouldRetry,findCanonicalFact,compactInbox,createCoordinator,projectMotoboyDelivery,projectRestaurantDelivery});
});
