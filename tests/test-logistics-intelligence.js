'use strict';

const assert = require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
process.env.NODE_ENV='test';
const { estimateInternalCost, makeRecommendation, normalizeSettings, summarizeFleetCapacity, assessRouteCompatibility } = require('../backend/logistics/intelligence');
const {createRouteDistanceService,calculateInsertionOptions,routeDistanceResult}=require('../backend/logistics/route-insertion');
const {createFakeRouteDistanceProvider}=require('./helpers/fake-route-distance-provider');

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
assert.equal(busyCapacity.byDriver[0].capacityLimit,null);
const configuredCapacity=summarizeFleetCapacity([{driverId:'driver-full',status:'EM ROTA',capacity:{unit:'deliveries',limit:2}}],[
  {driverId:'driver-full',status:'ASSIGNED'},{driverId:'driver-full',status:'OUT_FOR_DELIVERY'}]);
assert.equal(configuredCapacity.byDriver[0].assignedDeliveries,2);
assert.equal(configuredCapacity.byDriver[0].remainingSlots,0);
assert.equal(configuredCapacity.byDriver[0].capacityStatus,'full');
assert.equal(configuredCapacity.byDriver[0].availability,'unknown','a known remaining-slot count does not turn EM ROTA into AVAILABLE');
const availableCapacity=summarizeFleetCapacity([{driverId:'driver-free',status:'DISPONÍVEL',capacity:{unit:'deliveries',limit:3}}],[]);
assert.equal(availableCapacity.byDriver[0].remainingSlots,3);
assert.equal(availableCapacity.byDriver[0].capacityStatus,'slots_available');
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

(async()=>{
  const ids=['stop-a','stop-b'],newId='stop-new';
  const distances={
    'stop-a>stop-b':10000,
    'stop-new>stop-a>stop-b':12500,
    'stop-a>stop-new>stop-b':11200,
    'stop-a>stop-b>stop-new':13000
  };
  const fake=createFakeRouteDistanceProvider({distances,companyId:'company-a'});
  const service=createRouteDistanceService({provider:fake});
  const insertions=await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:1},routeDistanceService:service});
  assert.equal(insertions.status,'known');
  assert.deepEqual(insertions.candidates.map(item=>item.position),[0,1,2],'beginning, middle and end positions are evaluated');
  assert.deepEqual(insertions.candidates.map(item=>item.incrementalDistanceM),[2500,1200,3000]);
  assert.equal(insertions.bestPosition,1,'the minimum incremental distance selects the middle insertion');
  assert.equal(insertions.provenance.kind,'test');
  assert.equal((await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:0},routeDistanceService:service})).reason,'CAPACITY_FULL');
  assert.equal((await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'unknown',remainingSlots:null},routeDistanceService:service})).reason,'CAPACITY_UNKNOWN');
  const unknownService=createRouteDistanceService({provider:createFakeRouteDistanceProvider({unknownSequences:['stop-a>stop-b'],companyId:'company-a'})});
  assert.equal((await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:1},routeDistanceService:unknownService})).status,'unknown');
  const unavailableService=createRouteDistanceService({provider:createFakeRouteDistanceProvider({unavailableSequences:['stop-a>stop-b'],companyId:'company-a'})});
  assert.equal((await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:1},routeDistanceService:unavailableService})).status,'unavailable');
  const zeroService=createRouteDistanceService({provider:createFakeRouteDistanceProvider({distances:{
    'stop-a>stop-b':6000,'stop-new>stop-a>stop-b':6000,'stop-a>stop-new>stop-b':6000,'stop-a>stop-b>stop-new':6000
  },companyId:'company-a'})});
  const zeroInsertion=await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:1},routeDistanceService:zeroService});
  assert.equal(zeroInsertion.incrementalDistanceM,0,'zero incremental distance is a valid measured value');
  assert.equal(zeroInsertion.bestPosition,0,'zero-delta ties use stable earliest-position ordering');
  assert.equal(routeDistanceResult({status:'known',distanceM:1.5,provenance:{kind:'test',providerId:'bad'}},'bad').status,'unknown');
  assert.equal(routeDistanceResult({status:'known',distanceM:-1,provenance:{kind:'test',providerId:'bad'}},'bad').reason,'DISTANCE_VALUE_INVALID');
  assert.equal(routeDistanceResult({status:'known',distanceM:Number.MAX_SAFE_INTEGER+1,provenance:{kind:'test',providerId:'bad'}},'bad').status,'unknown');
  const invalidDelta=createRouteDistanceService({provider:createFakeRouteDistanceProvider({distances:{
    'stop-a>stop-b':7000,'stop-new>stop-a>stop-b':6000,'stop-a>stop-new>stop-b':8000,'stop-a>stop-b>stop-new':9000
  },companyId:'company-a'})});
  assert.equal((await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:1},routeDistanceService:invalidDelta})).status,'unknown','negative delta is rejected as invalid');
  assert.equal((await calculateInsertionOptions({companyId:'company-b',routeId:'route-a',deliveryIds:ids,newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:1},routeDistanceService:service})).status,'unknown','distance fixture is tenant scoped');
  let provenanceCall=0;
  const changingProvenance=createRouteDistanceService({provider:{providerId:'stable-id',async calculateDistance({deliveryIds}){
    provenanceCall+=1;return {status:'known',distanceM:deliveryIds.length*1000,provenance:{kind:'test',providerId:'stable-id',version:provenanceCall===1?'v1':'v2'}};
  }}});
  assert.equal((await calculateInsertionOptions({companyId:'company-a',routeId:'route-a',deliveryIds:['stop-a'],newDeliveryId:newId,
    capacity:{status:'known',remainingSlots:1},routeDistanceService:changingProvenance})).reason,'INSERTION_DISTANCE_COVERAGE_INCOMPLETE',
    'distance estimates from different provider versions are not compared');
  const fakeOutsideTest=spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.join(__dirname,'helpers/fake-route-distance-provider.js'))})`],
    {encoding:'utf8',env:{...process.env,NODE_ENV:'production'}});
  assert.notEqual(fakeOutsideTest.status,0,'fake distance adapter cannot be loaded outside test mode');
  const incompletePlan=assessRouteCompatibility({deliveryId:newId,routes:[{routeId:'route-incomplete',status:'ACTIVE',deliveryIds:['stop-a','stop-b'],stops:[
    {deliveryId:'stop-a',found:true,driverId:'driver-a',driverStatus:'active',status:'OUT_FOR_DELIVERY'},
    {deliveryId:'stop-b',found:false,driverId:null,driverStatus:null,status:null}
  ]}]});
  assert.equal(incompletePlan.candidates[0].planComplete,false,'an unresolved canonical stop makes Route order incomplete');
  const internalMarginal=alternative('internal-route','internal',1000);
  internalMarginal.decisionCost={status:'known',amountMinor:310,currency:'BRL'};
  assert.equal(makeRecommendation([internalMarginal,alternative('external','external_api',840)],'lowest_cost').selectedAlternativeId,'internal-route');
  assert.equal(makeRecommendation([internalMarginal,alternative('external','external_api',250)],'lowest_cost').selectedAlternativeId,'external');
  assert.equal(makeRecommendation([internalMarginal,alternative('external','external_api',310)],'lowest_cost').status,'tie');
  assert.equal(makeRecommendation([internalMarginal,alternative('external','external_api',310,{currency:'USD'})],'lowest_cost').why.code,'CURRENCY_MISMATCH');
  console.log('Logistics intelligence capacity and deterministic route insertion: OK');
})().catch(error=>{console.error(error);process.exitCode=1});
