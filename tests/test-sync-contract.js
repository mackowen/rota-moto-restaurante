'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require('path').join(__dirname,'..','contract.js'),'utf8');
const ctx={crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},globalThis:null};ctx.globalThis=ctx;vm.runInNewContext(source,ctx);
const C=ctx.RotaMotoContract;
assert.equal(C.PROTOCOL_VERSION,1); assert.equal(C.SCHEMA_VERSION,1);
assert(C.canTransition('CREATED','ASSIGNED')); assert(C.canTransition('ARRIVED','DELIVERED')); assert(!C.canTransition('DELIVERED','ARRIVED'));
assert.equal(C.normalizeDeliveryStatus('EM_ROTA','restaurante'),'OUT_FOR_DELIVERY');
assert.equal(C.normalizeDeliveryStatus('route','motoboy'),'OUT_FOR_DELIVERY');
const d=C.deliveryFromOrder({id:'ord_1',deliveryId:'del_1',companyId:'c1',status:'ATRIBUIDA',bikeId:'drv_1',createdAt:'2026-09-24T20:00:00.000Z',updatedAt:'2026-09-24T20:01:00.000Z'},'c1');
assert.deepEqual({id:d.id,orderId:d.orderId,driverId:d.driverId,status:d.status},{id:'del_1',orderId:'ord_1',driverId:'drv_1',status:'ASSIGNED'});
const packet=C.packet({companyId:'c1',deviceId:'dev_rest',app:'RotaMoto Restaurante',deliveries:[d]});
assert.equal(packet.protocol,'rotamoto-sync'); assert.equal(packet.companyId,'c1'); assert.equal(packet.data.deliveries.length,1); assert(packet.packetId);
// Simulate Motoboy import + export + Restaurante merge, including duplicate packet and stale update.
const moto={}; moto.deliveries=new Map(); let inbox=new Set();
function importRestaurant(p){if(inbox.has(p.packetId))return {duplicate:true}; for(const raw of p.data.deliveries){const cur=moto.deliveries.get(raw.id); if(cur && new Date(cur.updatedAt)>new Date(raw.updatedAt)) continue; moto.deliveries.set(raw.id,{...raw});} inbox.add(p.packetId); return {duplicate:false};}
assert.equal(importRestaurant(packet).duplicate,false); assert.equal(importRestaurant(packet).duplicate,true); assert.equal(moto.deliveries.get('del_1').status,'ASSIGNED');
const executed={...moto.deliveries.get('del_1'),status:'DELIVERED',updatedAt:'2026-09-24T21:00:00.000Z',version:2};
const event=C.event('DELIVERY_COMPLETED','delivery','del_1',{completedAt:executed.updatedAt},{type:'driver',id:'drv_1'});
const back=C.packet({companyId:'c1',deviceId:'dev_boy',app:'RotaMoto',deliveries:[executed],deliveryEvents:[event]});
const restaurant=new Map([['del_1',d]]); const events=new Set();
for(const raw of back.data.deliveries){const cur=restaurant.get(raw.id); if(!cur||new Date(raw.updatedAt)>=new Date(cur.updatedAt)) restaurant.set(raw.id,{...cur,...raw});}
for(const ev of back.data.deliveryEvents)events.add(ev.eventId);
for(const ev of back.data.deliveryEvents)events.add(ev.eventId);
assert.equal(restaurant.get('del_1').status,'DELIVERED'); assert.equal(events.size,1);
const stale={...executed,status:'ARRIVED',updatedAt:'2026-09-24T20:30:00.000Z',version:1};
if(new Date(stale.updatedAt)>=new Date(restaurant.get('del_1').updatedAt)) restaurant.set(stale.id,stale);
assert.equal(restaurant.get('del_1').status,'DELIVERED');
console.log('sync contract integration tests: OK');
