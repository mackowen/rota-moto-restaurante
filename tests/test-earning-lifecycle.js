'use strict';
const assert = require('node:assert/strict');
const Ops = require('../restaurant-operations');

const pending = { id: 'order-1', companyId: 'company-1', deliveryId: 'delivery-1', driverId: 'driver-1',
  deliveryStatus: 'ASSIGNED', motoboyEarnings: 8.4, motoboyEarningsShare: 0.7,
  deliveryFeeModel: 'perKm', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T10:01:00.000Z', version: 2 };
assert.equal(Ops.canonicalEarningFromCompletedOrder(pending, 'company-1'), null,
  'assignment is a prospective payout, not a realized Earning');
assert.equal(Ops.canonicalEarningFromCompletedOrder({ ...pending, deliveryStatus: 'FAILED' }, 'company-1'), null);
assert.equal(Ops.canonicalEarningFromCompletedOrder({ ...pending, deliveryStatus: 'CANCELLED' }, 'company-1'), null);

const completed = Ops.canonicalEarningFromCompletedOrder({ ...pending, deliveryStatus: 'DELIVERED',
  completedAt: '2026-10-01T10:37:00.000Z' }, 'company-1');
assert.equal(completed.id, 'earning:order-1');
assert.equal(completed.companyId, 'company-1');
assert.equal(completed.driverId, 'driver-1');
assert.equal(completed.amountMinor, 840);
assert.equal(completed.currency, 'BRL');
assert.equal(completed.createdAt, '2026-10-01T10:37:00.000Z');
assert.equal(completed.rule.share, 0.7);

const canonical = Ops.canonicalOrder({ ...pending, coords: [-23.5, -46.6], sourceData: { channel: 'manual' } }, 'company-1');
assert.equal(canonical.extensions.x_rotamoto_driver_payout.amountMinor, 840);
assert.equal(canonical.extensions.x_rotamoto_navigation_coordinates.provenance, 'restaurant_order_coordinates');
assert.deepEqual(canonical.extensions.x_restaurante_source_data, { channel: 'manual' });
const remote = Ops.mergeCanonicalOrder({ ...pending }, canonical);
assert.equal(Ops.canonicalEarningFromCompletedOrder({ ...remote, deliveryStatus: 'DELIVERED', completedAt: '2026-10-01T10:37:00.000Z' }, 'company-1').amountMinor, 840,
  'payout rule snapshot survives sync and is not recalculated with changed settings');

assert.equal(Ops.canonicalEarningFromCompletedOrder({ id: 'order-2', deliveryId: 'delivery-2', deliveryStatus: 'DELIVERED' }, 'company-1'), null,
  'unknown payout remains unknown rather than becoming zero');
const zero = Ops.canonicalEarningFromCompletedOrder({ ...pending, motoboyEarnings: 0, deliveryStatus: 'DELIVERED' }, 'company-1');
assert.equal(zero.amountMinor, 0, 'explicit zero remains distinguishable from a missing payout');
console.log('Earning lifecycle: completion-gated, snapshotted, idempotent projection and unknown-value semantics PASS');
