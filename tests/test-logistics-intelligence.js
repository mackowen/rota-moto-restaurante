'use strict';

const assert = require('node:assert/strict');
const { estimateInternalCost, makeRecommendation, normalizeSettings } = require('../backend/logistics/intelligence');

const alternative = (id, mode, amountMinor, options = {}) => ({ id, mode, eligible: options.eligible ?? true,
  cost: amountMinor === null ? { status: 'insufficient_data', reason: options.reason || 'NO_COST' } :
    { status: 'known', amountMinor, currency: options.currency || 'BRL' }, etaAt: options.etaAt || null });

assert.deepEqual(estimateInternalCost(null, 2000), { status: 'insufficient_data', reason: 'FLEET_COST_MODEL_NOT_CONFIGURED' });
assert.equal(estimateInternalCost({ fixedCostPerDeliveryMinor: 100, variableCostPerKmMinor: 51, currency: 'BRL' }, 1001).amountMinor, 152);
assert.equal(estimateInternalCost({ fixedCostPerDeliveryMinor: 100, variableCostPerKmMinor: 51, currency: 'BRL' }, null).status, 'insufficient_data');
assert.throws(() => normalizeSettings({ expectedVersion: 0, fixedCostPerDeliveryMinor: null, variableCostPerKmMinor: 0,
  currency: 'BRL', defaultPolicy: 'lowest_cost' }), /juntos/u);

const own = alternative('own', 'internal', 900);
const external = alternative('external', 'external_api', 1200);
assert.equal(makeRecommendation([own, external], 'lowest_cost').selectedAlternativeId, 'own', 'own fleet can be cheapest');
assert.equal(makeRecommendation([alternative('own', 'internal', 1500), alternative('provider', 'external_api', 800)], 'lowest_cost').selectedAlternativeId,
  'provider', 'external quote can be cheapest');
assert.equal(makeRecommendation([own, alternative('provider', 'external_api', 800, { etaAt: '2026-10-06T10:00:00Z' })], 'earliest_eta').status,
  'insufficient_data', 'unknown fleet ETA causes abstention');
assert.equal(makeRecommendation([alternative('a', 'internal', 100, { etaAt: '2026-10-06T10:00:00Z' }),
  alternative('b', 'external_api', 200, { etaAt: '2026-10-06T09:00:00Z' })], 'earliest_eta').selectedAlternativeId, 'b');
assert.equal(makeRecommendation([own, alternative('expired', 'external_api', null, { eligible: false, reason: 'QUOTE_EXPIRED' })], 'lowest_cost').status,
  'insufficient_data', 'expired quote does not become eligible');
assert.equal(makeRecommendation([own, alternative('usd', 'external_api', 100, { currency: 'USD' })], 'lowest_cost').why.code,
  'CURRENCY_MISMATCH', 'currencies are not converted');
assert.equal(makeRecommendation([own, alternative('manual', 'external_manual', null)], 'lowest_cost').why.code,
  'COST_COVERAGE_INCOMPLETE', 'missing manual cost causes abstention, not zero');
assert.equal(makeRecommendation([alternative('b', 'internal', 100), alternative('a', 'external_api', 100)], 'lowest_cost').status,
  'tie', 'nominal cost tie is returned without selecting');
assert.equal(makeRecommendation([own], 'lowest_cost').status, 'insufficient_data', 'one eligible alternative is insufficient');

console.log('Logistics intelligence deterministic recommendations: OK');
