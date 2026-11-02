'use strict';

const assert = require('node:assert/strict');
const { validateInitialSetup } = require('../backend/identity/bootstrap-setup');

const valid = { company: { supportPhone: null, timeZone: 'America/Sao_Paulo',
  routeGroupingPolicy: 'nearest_extension', operationalLocation: null }, deliveryPricing: null };
assert.deepEqual(validateInitialSetup(valid), valid, 'empty address and unconfigured rates remain pending without fake defaults');
assert.throws(() => validateInitialSetup({ ...valid, company: { ...valid.company, timeZone: 'Not/A-Timezone' } }),
  error => error.code === 'INVALID_INPUT');
assert.throws(() => validateInitialSetup({ ...valid, company: { ...valid.company, timeZone: null } }),
  error => error.code === 'INVALID_INPUT', 'initial installation requires a canonical time zone');
assert.throws(() => validateInitialSetup({ ...valid, company: { ...valid.company, operationalLocation: {
  address: 'Rua confirmada', latitude: null, longitude: null, confirmed: false
} } }), error => error.code === 'INVALID_INPUT');
assert.throws(() => validateInitialSetup({ ...valid, company: { ...valid.company, operationalLocation: {
  address: null, latitude: -23.5, longitude: null, confirmed: true
} } }), error => error.code === 'INVALID_INPUT');
assert.throws(() => validateInitialSetup({ ...valid, unsupportedHours: [] }), error => error.code === 'INVALID_INPUT');

const pricing = { model: 'range', minFee: 3, perKm: 0, fixedFee: 0, round: false, roundTo: 0.01,
  ranges: [{ from: 0, to: 4, value: 0.29 }, { from: 4, to: null, value: 8 }], repasseMode: 'percentage', repassePercent: 80 };
assert.deepEqual(validateInitialSetup({ ...valid, deliveryPricing: pricing }).deliveryPricing, pricing);
assert.throws(() => validateInitialSetup({ ...valid, deliveryPricing: { ...pricing, ranges: [{ from: 1, to: null, value: 5 }] } }),
  error => error.code === 'INVALID_INPUT');
assert.throws(() => validateInitialSetup({ ...valid, deliveryPricing: { ...pricing, repassePercent: 101 } }),
  error => error.code === 'INVALID_INPUT');
console.log('bootstrap initial settings validation: canonical fields, explicit location confirmation, pending optional rates and pricing bounds PASS');
