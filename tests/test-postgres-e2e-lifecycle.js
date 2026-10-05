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
} }).then(result => {
  assert.equal(result.authenticated, true);
  assert.equal(result.mfaVerified, true);
  console.log('E2E fixture lifecycle: PASS (authenticated owner, MFA, Driver binding, operational sync, rollback teardown)');
}).catch(error => {
  console.error('E2E fixture lifecycle: FAIL:', error.message);
  process.exitCode = 1;
});
