'use strict';

const MAX_DISTANCE_M = Number.MAX_SAFE_INTEGER;
const PROVENANCE_KIND = new Set(['canonical','manual','test']);

function routeDistanceResult(value, expectedProviderId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['known','unknown','unavailable'].includes(value.status)) {
    return { status:'unknown', distanceM:null, provenance:null, reason:'DISTANCE_RESULT_INVALID' };
  }
  const provenance = value.provenance;
  const provenanceValid = provenance && typeof provenance === 'object' && !Array.isArray(provenance) &&
    Object.keys(provenance).every(key=>['kind','providerId','version','evaluatedAt','configuration'].includes(key)) &&
    PROVENANCE_KIND.has(provenance.kind) && typeof provenance.providerId === 'string' &&
    provenance.providerId.length > 0 && provenance.providerId.length <= 100 &&
    (provenance.version === undefined || typeof provenance.version === 'string' && provenance.version.length <= 40) &&
    (provenance.evaluatedAt === undefined || typeof provenance.evaluatedAt === 'string' && !Number.isNaN(Date.parse(provenance.evaluatedAt))) &&
    (provenance.configuration === undefined || typeof provenance.configuration === 'string' && provenance.configuration.length <= 64) &&
    (expectedProviderId === null || provenance.providerId === expectedProviderId);
  if (!provenanceValid) return { status:'unknown', distanceM:null, provenance:null, reason:'DISTANCE_PROVENANCE_INVALID' };
  if (value.status === 'known') {
    if (!Number.isSafeInteger(value.distanceM) || value.distanceM < 0 || value.distanceM > MAX_DISTANCE_M)
      return { status:'unknown', distanceM:null, provenance, reason:'DISTANCE_VALUE_INVALID' };
    return { status:'known', distanceM:value.distanceM, provenance, reason:null };
  }
  return { status:value.status, distanceM:null, provenance, reason:typeof value.reason==='string' ? value.reason.slice(0,100) : null };
}

function createRouteDistanceService({ provider = null } = {}) {
  if (provider && (typeof provider.calculateDistance !== 'function' || typeof provider.providerId !== 'string' ||
      !provider.providerId.trim() || provider.providerId.length > 100)) throw new TypeError('Invalid route distance provider.');
  if (provider?.testOnly === true && process.env.NODE_ENV !== 'test')
    throw new Error('Test-only route distance provider is unavailable outside NODE_ENV=test.');
  return Object.freeze({
    async calculate(input) {
      if (!provider) return { status:'unavailable', distanceM:null,
        provenance:{kind:'canonical',providerId:'not-configured'}, reason:'ROUTE_DISTANCE_PROVIDER_NOT_CONFIGURED' };
      let result;
      try { result = await provider.calculateDistance(Object.freeze({ ...input, deliveryIds:Object.freeze([...input.deliveryIds]) })); }
      catch (_) { return { status:'unavailable', distanceM:null,
        provenance:{kind:provider.testOnly?'test':'canonical',providerId:provider.providerId}, reason:'ROUTE_DISTANCE_PROVIDER_UNAVAILABLE' }; }
      return routeDistanceResult(result,provider.providerId);
    }
  });
}

async function calculateInsertionOptions({ companyId, routeId, deliveryIds, newDeliveryId, capacity,
  routeDistanceService, coordinatesByDeliveryId = null, startCoordinate = null, endCoordinate = null,
  startLabel = 'origin', endLabel = 'origin' }) {
  if (!routeDistanceService || typeof routeDistanceService.calculate !== 'function') throw new TypeError('Route distance service required.');
  if (!Array.isArray(deliveryIds) || deliveryIds.length > 500 || new Set(deliveryIds).size !== deliveryIds.length ||
      deliveryIds.some(id=>typeof id!=='string'||!id) || typeof newDeliveryId!=='string' || deliveryIds.includes(newDeliveryId))
    return { status:'unknown', reason:'ROUTE_ORDER_INVALID', routeDistance:{status:'unknown',distanceM:null,provenance:null}, candidates:[] };
  if (!capacity || capacity.status !== 'known' || !Number.isSafeInteger(capacity.remainingSlots))
    return { status:'unknown', reason:'CAPACITY_UNKNOWN', routeDistance:{status:'unknown',distanceM:null,provenance:null}, candidates:[] };
  if (capacity.remainingSlots <= 0)
    return { status:'unavailable', reason:'CAPACITY_FULL', routeDistance:{status:'unknown',distanceM:null,provenance:null}, candidates:[] };
  const distanceInput = ids => {
    const coordinates = Object.assign(Object.create(null),coordinatesByDeliveryId||{});
    const ordered=[...ids];
    if(startCoordinate){ordered.unshift(`__route_start_${startLabel}__`);coordinates[ordered[0]]=startCoordinate;}
    if(endCoordinate){const id=`__route_end_${endLabel}__`;ordered.push(id);coordinates[id]=endCoordinate;}
    return {companyId,routeId,deliveryIds:ordered,coordinatesByDeliveryId:coordinates};
  };
  const routeDistance = await routeDistanceService.calculate(distanceInput(deliveryIds));
  if (routeDistance.status !== 'known')
    return { status:routeDistance.status, reason:routeDistance.reason||'ROUTE_DISTANCE_UNKNOWN', routeDistance, candidates:[] };
  const candidates=[];
  for (let position=0; position<=deliveryIds.length; position++) {
    const next=[...deliveryIds.slice(0,position),newDeliveryId,...deliveryIds.slice(position)];
    const after=await routeDistanceService.calculate(distanceInput(next));
    let deltaM=null, status=after.status, reason=after.reason||null;
    if (after.status==='known') {
      const beforeSource=routeDistance.provenance,afterSource=after.provenance;
      if(beforeSource.kind!==afterSource.kind||beforeSource.providerId!==afterSource.providerId||beforeSource.version!==afterSource.version||beforeSource.configuration!==afterSource.configuration){status='unknown';reason='DISTANCE_PROVENANCE_MISMATCH';}
      else {
        deltaM=after.distanceM-routeDistance.distanceM;
        if (!Number.isSafeInteger(deltaM) || deltaM < 0) { status='unknown'; deltaM=null; reason='DISTANCE_DELTA_INVALID'; }
      }
    }
    candidates.push({ position, deliveryIds:next, status, currentDistanceM:routeDistance.distanceM,
      distanceAfterInsertionM:after.status==='known'&&status==='known'?after.distanceM:null,
      incrementalDistanceM:deltaM, provenance:after.provenance||routeDistance.provenance, reason });
  }
  const incomplete=candidates.filter(candidate=>candidate.status!=='known');
  if (incomplete.length) {
    const status=incomplete.some(candidate=>candidate.status==='unavailable')?'unavailable':'unknown';
    return { status, reason:'INSERTION_DISTANCE_COVERAGE_INCOMPLETE', routeDistance,
      candidates:candidates.map(({deliveryIds:_ids,...candidate})=>candidate), bestPosition:null };
  }
  const best=[...candidates].sort((a,b)=>a.incrementalDistanceM-b.incrementalDistanceM||a.position-b.position)[0];
  return { status:'known', reason:null, routeDistance, candidates:candidates.map(({deliveryIds:_ids,...candidate})=>candidate),
    bestPosition:best.position, incrementalDistanceM:best.incrementalDistanceM,
    distanceAfterInsertionM:best.distanceAfterInsertionM, provenance:best.provenance };
}

module.exports={routeDistanceResult,createRouteDistanceService,calculateInsertionOptions};
