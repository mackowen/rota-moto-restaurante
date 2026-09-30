'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','contract.js'),'utf8');
const ctx={crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},globalThis:null};ctx.globalThis=ctx;vm.runInNewContext(source,ctx);
const C=ctx.RotaMotoContract;

// a) Restaurant order -> delivery packet -> Moto route record, retaining route fields.
const order={id:'ord-1',deliveryId:'del-1',companyId:'c1',status:'ATRIBUIDA',num:17,customer:'Ana',phone:'11999990000',address:'Rua A, 10',coords:[-23.5,-46.6],value:42,items:[{name:'Prato'}],obs:'Portaria'};
const delivery=C.deliveryFromOrder(order,'c1');
const incoming=C.raceFromDelivery(delivery,order);
assert.equal(incoming.orderId,'ord-1');assert.equal(incoming.client,'Ana');assert.equal(incoming.address,'Rua A, 10');assert.equal(incoming.lat,-23.5);assert.equal(incoming.lng,-46.6);assert.equal(incoming.orderNo,17);assert.equal(incoming.items.length,1);

// b/g) Operational revisions use ISO timestamps, monotonically advance, and round trip.
const started=C.revise({...incoming,status:'route',canonicalStatus:'OUT_FOR_DELIVERY'},'2026-09-30T12:00:00.000Z');
assert.match(started.updatedAt,/^\d{4}-\d\d-\d\dT/);assert(started.version>incoming.version);assert(C.compareRevision(started,incoming)>0);
const exported=C.deliveryFromRace(started,'c1','driver-1');assert.equal(exported.status,'OUT_FOR_DELIVERY');assert.equal(exported.updatedAt,started.updatedAt);
assert.equal(C.timestampMs('2026-09-30T12:00:00.000Z'),Date.parse('2026-09-30T12:00:00.000Z'));

// c) Explicit cancellation is a status update and leaves Moto race outside active route.
const cancelled=C.raceFromDelivery({...delivery,status:'CANCELLED',updatedAt:'2026-09-30T12:01:00.000Z',version:3},order,incoming);
assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.canonicalStatus,'CANCELLED');

// d/e) Deletion is represented as a delivery tombstone; packet retains it after local history cleanup.
const tomb=C.tombstone(started,'deliveries','2026-09-30T12:02:00.000Z');
const packet=C.packet({companyId:'c1',app:'RotaMoto',deliveries:[],tombstones:[tomb]});
assert.equal(packet.data.tombstones[0].id,'del-1');assert.equal(packet.data.tombstones[0].deleted,true);
const appSource=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
assert(appSource.includes('RotaMotoContract.timestampMs(raw.updatedAt)'));
assert(appSource.includes('RotaMotoContract.assertTransition(previous,status)'));
assert(appSource.includes("store:'deliveries'"));
assert(appSource.includes('tombstones=(state.tombstones||[])'));

// f) Impossible transitions are rejected, never persisted as a newer revision.
assert.throws(()=>C.assertTransition('DELIVERED','OUT_FOR_DELIVERY'));
assert.throws(()=>C.assertTransition('ASSIGNED','DELIVERED'));
console.log('sync flow tests: OK');
