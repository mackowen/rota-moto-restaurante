'use strict';

const assert = require('node:assert/strict');
const { estimateInternalCost, makeRecommendation, normalizeSettings, summarizeFleetCapacity, assessRouteCompatibility } = require('../backend/logistics/intelligence');

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

const busyCapacity=summarizeFleetCapacity([{driverId:'driver-a',status:'active'}],Array.from({length:4},(_,index)=>({
  driverId:'driver-a',status:index===0?'ASSIGNED':'OUT_FOR_DELIVERY'
})));
assert.equal(busyCapacity.activeDrivers,1);
assert.equal(busyCapacity.assignedDeliveries,4);
assert.equal(busyCapacity.inProgressDeliveries,3);
assert.equal(busyCapacity.availability,'unknown','active Driver plus workload never implies free capacity');
assert.equal(busyCapacity.capacityStatus,'unknown','load limit is not invented when no capacity setting exists');
assert.equal(busyCapacity.capacityLimit,null);
const explicitlyAvailable=summarizeFleetCapacity([{driverId:'driver-b',status:'DISPONÍVEL'}],[]);
assert.equal(explicitlyAvailable.availability,'available','the canonical Restaurant available status is recognized only without assigned workload');
const activeInRoute=summarizeFleetCapacity([{driverId:'driver-route',status:'EM ROTA'}],[{driverId:'driver-route',status:'OUT_FOR_DELIVERY'}]);
assert.equal(activeInRoute.activeDrivers,1,'the canonical Restaurant in-route status is an active Driver');
assert.equal(activeInRoute.availability,'unknown','an in-route Driver is active but not available for another assignment');
const offlineCapacity=summarizeFleetCapacity([{driverId:'driver-c',status:'OFFLINE'}],[]);
assert.equal(offlineCapacity.availability,'unavailable','an explicit offline status is a known unavailable state');

const routeCandidate=assessRouteCompatibility({deliveryId:'delivery-new',targetCoordinatesKnown:true,routes:[{
  routeId:'route-active',status:'IN_PROGRESS',deliveryIds:['delivery-stop'],stops:[{
    deliveryId:'delivery-stop',driverId:'driver-a',driverStatus:'active',coordinatesKnown:true
  }]
}]});
assert.equal(routeCandidate.status,'candidate_requires_route_validation');
assert.equal(routeCandidate.compatibility,'unknown','an active route and confirmed coordinates alone do not prove road compatibility');
assert.equal(routeCandidate.candidates[0].driverId,'driver-a');
assert.equal(routeCandidate.candidates[0].incrementalDistanceM,null,'no straight-line value is passed off as route distance');
assert.equal(routeCandidate.candidates[0].marginalCost.status,'insufficient_data');
const incompatibleRoute=assessRouteCompatibility({deliveryId:'delivery-new',routes:[{
  routeId:'route-offline',status:'ACTIVE',deliveryIds:['delivery-stop'],stops:[{
    deliveryId:'delivery-stop',driverId:'driver-offline',driverStatus:'offline',coordinatesKnown:true
  }]
}]});
assert.equal(incompatibleRoute.compatibility,'incompatible','route with an explicitly offline Driver is operationally incompatible');
assert.equal(incompatibleRoute.rejected[0].reason,'ROUTE_DRIVER_UNAVAILABLE');
assert.equal(assessRouteCompatibility({deliveryId:'delivery-new',routes:[{routeId:'old',status:'COMPLETED',stops:[]}]}).status,
  'no_active_route_observed','completed routes are not considered active candidates');
assert.equal(assessRouteCompatibility({deliveryId:'delivery-new',deliveryDriverId:'driver-already-assigned'}).status,
  'not_applicable','already allocated deliveries do not receive a route addition suggestion');
const unknownRouteCost=alternative('internal-route','internal',900);
unknownRouteCost.decisionCost={status:'insufficient_data',reason:'INCREMENTAL_ROUTE_DISTANCE_UNKNOWN'};
assert.equal(makeRecommendation([unknownRouteCost,external],'lowest_cost').why.code,'COST_COVERAGE_INCOMPLETE',
  'a cheaper quote cannot be declared while the internal route marginal cost is unknown');

console.log('Logistics intelligence deterministic recommendations: OK');
