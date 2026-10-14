'use strict';

const assert = require('node:assert/strict');
const { SyncError, validatePacket } = require('../backend/domain/sync-service');

const packetId = 'pkt_00000000-0000-4000-8000-000000000001';
const packet = {
  protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
  packetId, deviceId: 'restaurant-device-1',
  source: { deviceId: 'restaurant-device-1', app: 'restaurante' },
  events: [{ eventId: 'event-1', type: 'ORDER_UPDATED' }],
  data: { orders: [{ id: 'order-1' }], deliveries: [], races: [], settings: { language: 'pt-BR' } }
};

const validated = validatePacket(packet);
assert.deepEqual(Object.keys(validated).sort(), ['data', 'deviceId', 'events', 'packetId'].sort());
assert.equal(validated.packetId, '00000000-0000-4000-8000-000000000001');
assert.equal(validated.deviceId, packet.deviceId);
assert.equal(validated.data, packet.data, 'validation returns the original bounded data without rewriting it');
assert.equal(validated.events, packet.events, 'validation preserves event identity and order');

function rejectsWithCode(value, code) {
  assert.throws(() => validatePacket(value), error => error instanceof SyncError && error.code === code);
}

rejectsWithCode(null, 'INVALID_INPUT');
rejectsWithCode({ ...packet, protocolVersion: 2 }, 'INVALID_INPUT');
rejectsWithCode({ ...packet, packetId: 'not-a-packet-id' }, 'INVALID_INPUT');
rejectsWithCode({ ...packet, source: { deviceId: 'different-device' } }, 'INVALID_INPUT');
rejectsWithCode({ ...packet, data: { ...packet.data, unknownCollection: [] } }, 'INVALID_INPUT');
rejectsWithCode({ ...packet, data: { ...packet.data, deliveries: {} } }, 'INVALID_INPUT');
rejectsWithCode({ ...packet, data: { ...packet.data, credentials: { api_key: 'synthetic' } } }, 'INVALID_INPUT');
rejectsWithCode({ ...packet, events: Array.from({ length: 501 }, (_, index) => ({ eventId: `e-${index}` })) }, 'INVALID_INPUT');
rejectsWithCode({ ...packet, data: { ...packet.data, races: Array(501).fill({}) } }, 'INVALID_INPUT');

const collections = ['orders', 'drivers', 'deliveries', 'routes', 'deliveryEvents', 'locationUpdates', 'proofs', 'earnings'];
const bounded = { ...packet, events: [], data: Object.fromEntries(collections.map(key => [key, []])) };
bounded.data.tombstones = [];
bounded.data.races = [];
bounded.data.settings = {};
bounded.data.orders = Array.from({ length: 499 }, (_, index) => ({ id: `order-${index}` }));
assert.equal(validatePacket(bounded).data.orders.length, 499, 'the documented maximum remains inclusive when one settings operation is present');

console.log('sync packet validation characterization: OK');
