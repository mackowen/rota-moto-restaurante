'use strict';
const assert=require('node:assert/strict');
const R=require('../sync-reconciliation.js');
const uuid='00000000-0000-4000-8000-000000000001';
const event={eventId:uuid,type:'CANONICAL_RECORD_UPSERTED',entity:'Delivery',entityId:uuid,occurredAt:'2026-10-04T10:00:00.000Z',protocolVersion:1,payload:{id:uuid,companyId:'tenant-a',version:3,status:'ASSIGNED',driverId:'driver-a',priority:'HIGH',assignedAt:'2026-10-04T09:00:00.000Z',estimatedDistanceM:2400,orderId:'00000000-0000-4000-8000-000000000002'}};
assert.equal(R.canonicalEvent(event,'tenant-a').version,3);
assert.throws(()=>R.canonicalEvent(event,'tenant-b'),/TENANT_MISMATCH/);
assert.equal(R.decide({localVersion:2,incomingVersion:3}),'apply');
assert.equal(R.decide({localVersion:2,incomingVersion:3,localPending:true}),'conflict');
assert.equal(R.decide({localVersion:3,incomingVersion:2}),'stale');
assert.equal(R.decide({localVersion:1,incomingVersion:2,tombstone:true}),'tombstone');
for(const status of ['accepted','duplicate','rejected','conflict'])assert.equal(R.statusFromAck(status),status);
assert.equal(R.shouldRetry('rejected',false),false);assert.equal(R.shouldRetry('conflict',false),false);assert.equal(R.shouldRetry('conflict',true),true);
const opMap=new Map([['operation:event-local',{canonicalId:'00000000-0000-4000-8000-000000000099'}]]);assert.equal(R.findCanonicalFact([{id:'event-local'}],'00000000-0000-4000-8000-000000000099',opMap,row=>`operation:${row.id}`).id,'event-local');
const race=R.projectMotoboyDelivery(event.payload,{id:event.payload.orderId,customer:{name:'Jo'},address:'Rua A',coords:[-23,-46],items:[{name:'X'}]},{status:'route',startedAt:'2026-10-04T09:30:00Z'},{pendingExecution:true});
assert.equal(race.status,'route');assert.equal(race.driverId,'driver-a');assert.equal(race.client,'Jo');assert.equal(race.lat,-23);assert.equal(race.sync.canonicalVersion,3);
const cancelled=R.projectMotoboyDelivery({...event.payload,status:'CANCELLED',version:4},{},{status:'route'},{pendingExecution:true});assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.sync.state,'conflict');
const restaurant=R.projectRestaurantDelivery({...event.payload,status:'OUT_FOR_DELIVERY',version:4},{id:'local-del',driverId:'local-driver',priority:'NORMAL',assignedAt:'local-time',estimatedDistanceM:10,status:'ASSIGNED'},{pendingPlanning:true});
assert.equal(restaurant.id,'local-del');assert.equal(restaurant.driverId,'local-driver');assert.equal(restaurant.status,'ASSIGNED');assert.equal(restaurant.sync.state,'conflict');
const oldOrder={id:'local-order',status:'ATRIBUIDA',deliveryStatus:'ASSIGNED',canonicalStatus:'ASSIGNED',updatedAt:'old-time',completedAt:null,
  version:3,sync:{state:'synced',version:3,canonicalId:'canonical-order',canonicalVersion:3},money:{amountMinor:4200},customer:{name:'Cliente'}};
const deliveredProjection=R.projectRestaurantOrderFromDelivery(oldOrder,{id:event.payload.orderId,status:'DELIVERED',version:7,
  updatedAt:'2026-10-04T10:07:00.000Z',completedAt:'2026-10-04T10:07:00.000Z'});
assert.equal(deliveredProjection.status,'FINALIZADA');assert.equal(deliveredProjection.deliveryStatus,'DELIVERED');
assert.equal(deliveredProjection.canonicalStatus,'DELIVERED');assert.equal(deliveredProjection.updatedAt,'2026-10-04T10:07:00.000Z');
assert.equal(deliveredProjection.completedAt,'2026-10-04T10:07:00.000Z');
assert.equal(deliveredProjection.sync.canonicalVersion,3,'Delivery projection does not forge an Order revision');
assert.equal(deliveredProjection.version,3);assert.deepEqual(deliveredProjection.money,{amountMinor:4200});
assert.deepEqual(deliveredProjection.customer,{name:'Cliente'});assert.equal(oldOrder.status,'ATRIBUIDA','projection is immutable');
assert.equal(R.projectRestaurantOrderFromDelivery(oldOrder,{status:'DELIVERED'},{pendingOrder:true}),oldOrder,
  'a pending local Order edit is preserved until its own conflict is resolved');
for(const [deliveryStatus,orderStatus] of [['ASSIGNED','ATRIBUIDA'],['ACCEPTED','ATRIBUIDA'],['PICKED_UP','EM_ROTA'],
  ['OUT_FOR_DELIVERY','EM_ROTA'],['ARRIVED','CHEGOU'],['CANCELLED','CANCELADA'],['FAILED','EM_ROTA'],['RETURNED','EM_ROTA'],['REDELIVERY','ATRIBUIDA']])
  assert.equal(R.projectRestaurantOrderFromDelivery(oldOrder,{status:deliveryStatus}).status,orderStatus,`Order reflects ${deliveryStatus}`);
assert.equal(R.projectRestaurantOrderFromDelivery(oldOrder,{status:'DELIVERED'}).money,oldOrder.money,
  'canonical delivery state cannot alter Order financial fields');
const assignmentProjection={id:'local-delivery',orderId:'canonical-order',driverId:'driver-a',priority:'HIGH',
  assignedAt:'2026-10-04T09:00:00.000Z',estimatedDistanceM:2400,version:2,
  sync:{state:'conflict',version:3,canonicalId:uuid,canonicalVersion:2}};
const advancedDelivery={id:uuid,orderId:'canonical-order',driverId:'driver-a',priority:'HIGH',
  assignedAt:'2026-10-04T09:00:00.000Z',estimatedDistanceM:2400,status:'DELIVERED',version:7};
const staleOperation={id:'operation:Delivery:local-delivery',localId:'local-delivery',canonicalId:uuid,
  sourceVersion:3,canonicalVersion:2,status:'conflict'};
assert(R.isSupersededRestaurantDeliveryOperation(assignmentProjection,advancedDelivery,staleOperation),
  'a pull conflict clears only when the current canonical Delivery advances the exact acknowledged assignment');
assert(!R.isSupersededRestaurantDeliveryOperation(assignmentProjection,{...advancedDelivery,driverId:'driver-b'},staleOperation),
  'a changed canonical assignment remains a conflict');
assert(!R.isSupersededRestaurantDeliveryOperation(assignmentProjection,advancedDelivery,{...staleOperation,sourceVersion:2}),
  'a conflict from a different local revision remains unresolved');
assert(!R.isSupersededRestaurantDeliveryOperation(assignmentProjection,{...advancedDelivery,status:'ASSIGNED'},staleOperation),
  'an assignment that has not been superseded remains unresolved');
const keep=R.compactInbox([{id:'old',status:'reconciled',receivedAt:1},{id:'conflict',status:'conflict',receivedAt:1},...Array.from({length:3},(_,i)=>({id:`r${i}`,status:'reconciled',receivedAt:i+2}))],{keep:2});assert.deepEqual([...keep].sort(),['old','r0']);
async function testCoordinator(){let active=0,max=0,lockRequests=0;const locks={request:async(_name,_options,run)=>{lockRequests++;return run()}};const coordinator=R.createCoordinator({locks,lockName:'test'});const task=async()=>{active++;max=Math.max(max,active);await new Promise(resolve=>setTimeout(resolve,10));active--;return 'ok'};const values=await Promise.all([coordinator.run(task),coordinator.run(task)]);assert.deepEqual(values,['ok','ok']);assert.equal(max,1);assert.equal(lockRequests,1)}
testCoordinator().then(()=>console.log('sync reconciliation policy tests: OK')).catch(error=>{console.error(error);process.exitCode=1});
