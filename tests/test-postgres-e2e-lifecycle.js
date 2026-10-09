'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { runFixtureLifecycle } = require('./e2e-support/fixture-lifecycle');

runFixtureLifecycle({ exercise: async fixture => {
  assert.equal(fixture.authenticated, undefined);
  const session = await fixture.call('/api/identity/session');
  assert.notEqual(session.status, 200, 'fixture callback must not receive an unauthenticated session');
  const initialOrders = await fixture.authenticatedCall('/api/domain/orders?limit=100');
  const initialDeliveries = await fixture.authenticatedCall('/api/domain/deliveries?limit=100');
  assert.equal(initialOrders.status, 200);
  assert.equal(initialDeliveries.status, 200);
  const order = initialOrders.body.records.find(row => row.id === fixture.orderId);
  const delivery = initialDeliveries.body.records.find(row => row.id === fixture.deliveryId);
  assert(order && delivery, 'lifecycle service created canonical Order and Delivery records');

  const availabilityBefore=await fixture.authenticatedCall('/api/driver-availability');
  assert.equal(availabilityBefore.status,200,JSON.stringify(availabilityBefore.body));
  assert.equal(availabilityBefore.body.availability.effectiveStatus,'online','fixture Driver explicitly opted in');
  const revision=availabilityBefore.body.availability.revision;
  const secondLogin=await fixture.call('/api/identity/login',{method:'POST',body:{email:fixture.email,password:fixture.password,companyId:fixture.companyId,mfaCode:fixture.mfaCode}});
  assert.equal(secondLogin.status,200,JSON.stringify(secondLogin.body));
  const secondSessionCookie=secondLogin.headers.get('set-cookie').split(';',1)[0];
  const secondSession=await fixture.call('/api/identity/session',{cookie:secondSessionCookie});
  assert.equal(secondSession.status,200,JSON.stringify(secondSession.body));
  assert.equal(secondSession.body.driverId,fixture.driverId,'a second authenticated session resolves to the same owned Driver');
  const offlineCommand={desiredStatus:'offline',expectedRevision:revision,commandId:crypto.randomUUID()};
  const offline=await fixture.call('/api/driver-availability/commands',{method:'POST',cookie:secondSessionCookie,csrf:secondSession.body.csrfToken,body:offlineCommand});
  assert.equal(offline.status,200,JSON.stringify(offline.body));
  assert.equal(offline.body.availability.effectiveStatus,'offline');
  const observedOffline=await fixture.authenticatedCall('/api/driver-availability');
  assert.equal(observedOffline.body.availability.effectiveStatus,'offline','the first session observes the canonical change from the second session');
  const replay=await fixture.call('/api/driver-availability/commands',{method:'POST',cookie:secondSessionCookie,csrf:secondSession.body.csrfToken,body:offlineCommand});
  assert.equal(replay.status,200,JSON.stringify(replay.body));
  assert.equal(replay.body.command.duplicate,true,'availability commands are idempotent');
  const stale=await fixture.authenticatedCall('/api/driver-availability/commands',{method:'POST',body:{desiredStatus:'online',expectedRevision:revision,commandId:crypto.randomUUID()}});
  assert.equal(stale.status,409,'stale concurrent device must reconcile canonical revision');

  const rejectedId=`availability-offline-${crypto.randomUUID()}`,rejectedOrder=`availability-order-${crypto.randomUUID()}`;
  const unavailablePacket={protocol:'rotamoto-sync',protocolVersion:1,schemaVersion:1,packetId:`pkt_${crypto.randomUUID()}`,
    deviceId:fixture.restaurantDevice,source:{deviceId:fixture.restaurantDevice},createdAt:new Date().toISOString(),data:{
      orders:[{id:rejectedOrder,customer:'E2E assignment gate',source:'manual',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1}],
      deliveries:[{id:rejectedId,orderId:rejectedOrder,driverId:fixture.driverId,status:'ASSIGNED',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1}]}};
  const blockedAssignment=await fixture.authenticatedCall('/api/sync/push',{method:'POST',body:unavailablePacket});
  assert.equal(blockedAssignment.status,200,JSON.stringify(blockedAssignment.body));
  assert(blockedAssignment.body.operationResults.some(result=>result.status==='rejected'),JSON.stringify(blockedAssignment.body.operationResults));
  const deliveriesWhileOffline=await fixture.authenticatedCall('/api/domain/deliveries?limit=100');
  const activeDelivery=deliveriesWhileOffline.body.records.find(row=>row.id===fixture.deliveryId);
  assert(activeDelivery,'existing assignment remains present when the Driver goes Offline');
  assert.equal(activeDelivery.record.driverId,fixture.driverId,'Offline does not cancel or clear accepted operational work');

  const onlineAgain=await fixture.authenticatedCall('/api/driver-availability/commands',{method:'POST',body:{desiredStatus:'online',expectedRevision:offline.body.availability.revision,commandId:crypto.randomUUID()}});
  assert.equal(onlineAgain.status,200,JSON.stringify(onlineAgain.body));
  assert.equal(onlineAgain.body.availability.effectiveStatus,'online');
  const heartbeat=await fixture.authenticatedCall('/api/driver-availability/heartbeat',{method:'POST',body:{revision:onlineAgain.body.availability.revision}});
  assert.equal(heartbeat.status,200,JSON.stringify(heartbeat.body));
  assert.equal(heartbeat.body.renewed,true,'foreground heartbeat extends the lease without changing the revision');
  await fixture.runtime.query(`UPDATE rotamoto.driver_availability SET lease_expires_at=now()-interval '1 second'
    WHERE company_id=$1 AND driver_id=$2`,[fixture.companyId,fixture.driverId]);
  const expiredLease=await fixture.authenticatedCall('/api/driver-availability');
  assert.equal(expiredLease.body.availability.effectiveStatus,'offline','an expired lease is not eligible for new assignments');
  assert.equal(expiredLease.body.availability.reason,'lease_expired');
  const staleSessionHeartbeat=await fixture.call('/api/driver-availability/heartbeat',{method:'POST',cookie:secondSessionCookie,
    csrf:secondSession.body.csrfToken,body:{revision:onlineAgain.body.availability.revision}});
  assert.equal(staleSessionHeartbeat.status,200);
  assert.equal(staleSessionHeartbeat.body.renewed,false,'a second session cannot renew a lease owned by the current session');
  const resumedHeartbeat=await fixture.authenticatedCall('/api/driver-availability/heartbeat',{method:'POST',
    body:{revision:onlineAgain.body.availability.revision}});
  assert.equal(resumedHeartbeat.body.renewed,true,'the authenticated current session can renew after lease expiry');
  assert.equal(resumedHeartbeat.body.availability.effectiveStatus,'online');

  const deviceId = `restaurant-imported-${crypto.randomUUID()}`;
  const installation = await fixture.authenticatedCall('/api/sync/installations/restaurante', {
    method: 'POST', body: { deviceId }
  });
  assert.equal(installation.status, 200, JSON.stringify(installation.body));
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(order.record.updatedAt) + 1000)).toISOString();
  const packet = data => ({ protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
    packetId: `pkt_${crypto.randomUUID()}`, deviceId, source: { app: 'RotaMoto Restaurante', deviceId },
    createdAt: updatedAt, data: { orders: [], deliveries: [], drivers: [], routes: [], locationUpdates: [],
      deliveryEvents: [], proofs: [], earnings: [], tombstones: [], ...data } });
  const orderUpdate = { ...order.record, id: fixture.orderId, version: order.version + 1,
    baseVersion: order.version, updatedAt, customer: 'E2E lifecycle canonical Order revisado' };
  const orderPush = await fixture.authenticatedCall('/api/sync/push', {
    method: 'POST', body: packet({ orders: [orderUpdate] })
  });
  assert.equal(orderPush.status, 200, JSON.stringify(orderPush.body));
  assert.equal(orderPush.body.operationResults[0].status, 'accepted');
  assert.equal(orderPush.body.operationResults[0].canonicalId, fixture.orderId,
    'a new installation updates an imported canonical Order by its UUID');
  const ordersAfter = await fixture.authenticatedCall('/api/domain/orders?limit=100');
  const matchingOrders = ordersAfter.body.records.filter(row => row.id === fixture.orderId);
  assert.equal(matchingOrders.length, 1, 'editing an imported canonical Order creates no duplicate');
  assert.equal(matchingOrders[0].record.customer, 'E2E lifecycle canonical Order revisado');
  assert.equal(matchingOrders[0].record.baseVersion, undefined, 'sync revision metadata is not persisted in the canonical payload');

  const deliveryUpdatedAt = new Date(Math.max(Date.now(), Date.parse(delivery.record.updatedAt) + 1000)).toISOString();
  const deliveryUpdate = { ...delivery.record, id: fixture.deliveryId, version: delivery.version + 1,
    baseVersion: delivery.version, updatedAt: deliveryUpdatedAt, priority: 'HIGH' };
  const deliveryPush = await fixture.authenticatedCall('/api/sync/push', {
    method: 'POST', body: packet({ deliveries: [deliveryUpdate] })
  });
  assert.equal(deliveryPush.status, 200, JSON.stringify(deliveryPush.body));
  assert.equal(deliveryPush.body.operationResults[0].status, 'accepted');
  assert.equal(deliveryPush.body.operationResults[0].canonicalId, fixture.deliveryId,
    'a new installation updates an imported canonical Delivery by its UUID');
  const deliveriesAfter = await fixture.authenticatedCall('/api/domain/deliveries?limit=100');
  const matchingDeliveries = deliveriesAfter.body.records.filter(row => row.id === fixture.deliveryId);
  assert.equal(matchingDeliveries.length, 1, 'editing an imported canonical Delivery creates no duplicate');
  assert.equal(matchingDeliveries[0].record.priority, 'HIGH');
  assert.equal(matchingDeliveries[0].record.baseVersion, undefined);

  await fixture.runtime.query(`UPDATE rotamoto.sessions SET last_seen_at=created_at,
    idle_expires_at=greatest(created_at + interval '1 second',now()-interval '1 second')
    WHERE user_id=$1 AND revoked_at IS NULL`,[fixture.userId]);
  const expiredPrimarySession=await fixture.call('/api/driver-availability',{cookie:fixture.browserSessionCookie});
  assert.equal(expiredPrimarySession.status,401,'expired authenticated session cannot read operational availability');
  const expiredSecondSession=await fixture.call('/api/driver-availability',{cookie:secondSessionCookie});
  assert.equal(expiredSecondSession.status,401,'the second authenticated session also enforces server expiry');
} }).then(result => {
  assert.equal(result.authenticated, true);
  assert.equal(result.mfaVerified, true);
  console.log('E2E fixture lifecycle: PASS (authenticated owner, MFA, Driver binding, operational sync, rollback teardown)');
}).catch(error => {
  console.error('E2E fixture lifecycle: FAIL:', error.message);
  process.exitCode = 1;
});
