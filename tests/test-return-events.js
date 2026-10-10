'use strict';

const assert = require('node:assert/strict');
const { TRANSITIONS, validateReturnEvent } = require('../backend/logistics/return-events');

assert.deepEqual(Object.keys(TRANSITIONS), ['DELIVERY_RETURN_STARTED', 'DELIVERY_RETURN_ARRIVED', 'DELIVERY_RETURN_HANDED_OVER']);
assert.equal(validateReturnEvent({ type: 'DELIVERY_RETURN_STARTED', deliveryType: 'RETURN', status: 'ASSIGNED',
  expectedVersion: 4, canonicalVersion: 4 }).transition.to, 'OUT_FOR_DELIVERY');
assert.equal(validateReturnEvent({ type: 'DELIVERY_RETURN_ARRIVED', deliveryType: 'RETURN', status: 'OUT_FOR_DELIVERY',
  expectedVersion: 5, canonicalVersion: 5 }).transition.to, 'ARRIVED');
const handover = validateReturnEvent({ type: 'DELIVERY_RETURN_HANDED_OVER', deliveryType: 'RETURN', status: 'ARRIVED',
  custodyState: 'WITH_DRIVER', expectedVersion: 6, canonicalVersion: 6 });
assert.equal(handover.custodyState, 'AWAITING_RESTAURANT_RECEIPT');
assert.equal(handover.transition.to, null, 'physical handover does not mark a Delivery terminal');
assert.equal(validateReturnEvent({ type: 'DELIVERY_RETURN_STARTED', deliveryType: 'STANDARD', status: 'ASSIGNED',
  expectedVersion: 1, canonicalVersion: 1 }).error, 'FORBIDDEN_EVENT');
assert.equal(validateReturnEvent({ type: 'DELIVERY_RETURN_STARTED', deliveryType: 'RETURN', status: 'CANCELLED',
  expectedVersion: 1, canonicalVersion: 1 }).error, 'INVALID_TRANSITION');
assert.equal(validateReturnEvent({ type: 'DELIVERY_RETURN_ARRIVED', deliveryType: 'RETURN', status: 'OUT_FOR_DELIVERY',
  expectedVersion: 2, canonicalVersion: 3 }).error, 'REVISION_CONFLICT');
assert.equal(validateReturnEvent({ type: 'DELIVERY_RETURN_HANDED_OVER', deliveryType: 'RETURN', status: 'ARRIVED',
  custodyState: 'AWAITING_RESTAURANT_RECEIPT', expectedVersion: 2, canonicalVersion: 2 }).error, 'INVALID_TRANSITION');
console.log('RETURN event transitions, custody handover, revision and type guards: PASS');
