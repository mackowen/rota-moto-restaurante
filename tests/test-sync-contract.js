'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const contractSource=fs.readFileSync(path.join(root,'contract.js'),'utf8');
const appSource=fs.readFileSync(path.join(root,'app.js'),'utf8');
const ctx={crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},globalThis:null};ctx.globalThis=ctx;vm.runInNewContext(contractSource,ctx);
const C=ctx.RotaMotoContract;
assert.equal(C.PROTOCOL_VERSION,1);assert.equal(C.SCHEMA_VERSION,1);
assert(C.canTransition('CREATED','ASSIGNED'));assert(C.canTransition('ARRIVED','DELIVERED'));assert(!C.canTransition('DELIVERED','ARRIVED'));
assert.equal(C.normalizeDeliveryStatus('EM_ROTA','restaurante'),'OUT_FOR_DELIVERY');
assert.equal(C.normalizeDeliveryStatus('route','motoboy'),'OUT_FOR_DELIVERY');
assert.equal(C.WRITE_AUTHORITY.Order,'restaurante');assert.equal(C.WRITE_AUTHORITY.Earning,'restaurante');
assert.equal(C.WRITE_AUTHORITY.Delivery,'shared');assert.equal(C.WRITE_AUTHORITY.DeliveryEvent,'shared');
assert.deepEqual({...C.SYNC_ACK},{ACCEPTED:'accepted',DUPLICATE:'duplicate',REJECTED:'rejected',CONFLICT:'conflict'});
const d=C.deliveryFromOrder({id:'ord_1',deliveryId:'del_1',companyId:'c1',status:'ATRIBUIDA',bikeId:'drv_1',createdAt:'2026-09-24T20:00:00.000Z',updatedAt:'2026-09-24T20:01:00.000Z'},'c1');
assert.deepEqual({id:d.id,orderId:d.orderId,driverId:d.driverId,status:d.status},{id:'del_1',orderId:'ord_1',driverId:'drv_1',status:'ASSIGNED'});
const packet=C.packet({companyId:'c1',deviceId:'dev_rest',app:'RotaMoto Restaurante',deliveries:[d]});
assert.equal(packet.protocol,'rotamoto-sync');assert.equal(packet.companyId,'c1');assert.equal(packet.data.deliveries.length,1);assert(packet.packetId);
assert.match(appSource,/loginToServer:loginToSyncServer/);assert.match(appSource,/syncWithServer/);
assert.match(appSource,/sync-packet:/);assert.match(appSource,/operationResults/);
assert.match(appSource,/canonical:\$\{event\.entity\}:\$\{event\.entityId\}/);
assert.match(appSource,/multiStoreTransaction\(\[\.\.\.localStores,'inbox','syncState'\]/);
assert.match(appSource,/function multiStoreTransaction\(storeNames,mode,work\)/,'multi-store persistence helper used by sync is defined');
assert.match(appSource,/X-CSRF-Token/);
if(appSource.includes("function recordDeliveryEvent(type,r,payload={}")){
  const builder=appSource.slice(appSource.indexOf('async function buildSyncPacket'),appSource.indexOf('function downloadSyncPacket'));
  assert.match(builder,/deliveries:\[\]/,'Motoboy must not write canonical Delivery directly');
  assert.match(builder,/earnings:\[\]/,'Motoboy must not publish authoritative Earning');
  assert(!builder.includes('packet.data.races=')&&!builder.includes('packet.data.settings='),'local projections are excluded from canonical sync');
}else{
  assert.match(appSource,/canonicalEarningFromOrder\(order,companyId\)/,'Restaurant calculates canonical Earning from its existing rule');
  const builder=appSource.slice(appSource.indexOf('async function buildRestaurantSyncPacket'),appSource.indexOf('function downloadSyncPacket'));
  assert(!builder.includes('packet.data.settings='),'local settings are excluded from canonical sync');
  assert.match(builder,/filter\(driver=>driver\.sync\?\.state==='local'\|\|!driver\.sync\?\.canonicalId\)/,
    'unchanged canonical Drivers pulled from the server are not re-created by another installation');
  assert.match(appSource,/function isLocallyDirtyForSync\(record\)\{return record\?\.sync\?\.state==='local'\|\|!record\?\.sync\?\.canonicalId\}/,
    'only locally changed or not-yet-canonical records can be uploaded');
  assert.match(builder,/if\(orderChangedHere\)orders\.push/,
    'unchanged canonical Orders pulled from another installation are not uploaded again');
  assert.match(builder,/if\(!order\.deliveryId&&orderChangedHere\)\{order\.deliveryId=deliveryId;await put\('orders',order\)\}/,
    'derived Delivery links on imported canonical Orders do not mark the Order dirty');
  assert.match(builder,/deliveryFromOrder\(order\.deliveryId\?order:\{\.\.\.order,deliveryId\}/,
    'packet construction can project a Delivery without mutating an imported Order');
  assert.match(builder,/if\(\(orderChangedHere\|\|deliveryChangedHere\)/,
    'Delivery uploads require an Order or Delivery changed in this installation');
  assert.match(builder,/filter\(isLocallyDirtyForSync\)/,
    'unchanged canonical Routes are not re-created by another installation');
  assert.match(builder,/\(state\.earnings\|\|\[\]\)\.filter\(earning=>!earning\.deleted&&!earning\.deletedAt&&isLocallyDirtyForSync\(earning\)\)/,
    'only explicit locally created completion Earnings are published');
  assert.doesNotMatch(builder,/map\(order=>canonicalEarningFromOrder\(order,companyId\)\)/,
    'an Order edit or assignment cannot create an Earning before Delivery completion');
}
const syncTransport=appSource.slice(appSource.indexOf('async function syncWithServer'),appSource.indexOf('async function persistSyncAck'));
assert(syncTransport.indexOf('const ack=await send')<syncTransport.indexOf('persistSyncAck(queued.packet,ack.operationResults'),
  'local ACK state is written only after a successful HTTP response');
assert(syncTransport.includes('sync-packet:')&&syncTransport.includes('status:\'pending\''),
  'packet retry is retained in IndexedDB outbox until a response is received');
console.log('sync contract and client transport tests: OK');
