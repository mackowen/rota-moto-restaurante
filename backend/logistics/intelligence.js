'use strict';

const crypto = require('node:crypto');
const Money = require('../../order-money');
const D = require('./domain');
const { resolveTestProviderConfiguration } = require('./provider-integration');
const { createRouteDistanceService, calculateInsertionOptions } = require('./route-insertion');

const POLICIES = Object.freeze(['lowest_cost','prefer_internal','earliest_eta']);
const MAX_MINOR = 9000000000000000;
const ACTIVE_DELIVERY_STATES = new Set(['CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','REDELIVERY']);
const IN_PROGRESS_DELIVERY_STATES = new Set(['ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED']);
const TERMINAL_DELIVERY_STATES = new Set(['DELIVERED','CANCELLED','FAILED','RETURNED']);
const ACTIVE_ROUTE_STATES = new Set(['PLANNED','ACTIVE','IN_PROGRESS']);
const ACTIVE_DRIVER_STATES = new Set(['ACTIVE','AVAILABLE','DISPONIVEL','EM ROTA','CHEGOU','IN ROUTE','ARRIVED']);
const UNAVAILABLE_DRIVER_STATES = new Set(['INACTIVE','OFFLINE','DISABLED','SUSPENDED','INATIVO','INDISPONIVEL']);

function invalid(message) { throw Object.assign(new Error(message), { code: 'INVALID_INPUT' }); }
function normalizePolicy(value) {
  if (!POLICIES.includes(value)) invalid('Política de recomendação inválida.');
  return value;
}
function normalizeSettings(input) {
  const allowed = new Set(['expectedVersion','fixedCostPerDeliveryMinor','variableCostPerKmMinor','currency','defaultPolicy']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)) ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) invalid('Configuração econômica inválida.');
  const raw = [input.fixedCostPerDeliveryMinor,input.variableCostPerKmMinor,input.currency];
  const cleared = raw.every(value => value === null || value === undefined);
  const configured = raw.every(value => value !== null && value !== undefined);
  if (!cleared && !configured) invalid('Informe custo fixo, custo por km e moeda juntos; zero explícito é válido.');
  let costModel = null;
  if (configured) {
    if (![input.fixedCostPerDeliveryMinor,input.variableCostPerKmMinor].every(value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINOR) ||
        Money.currencyScale(input.currency) === null) invalid('Valores do perfil de frota inválidos.');
    costModel = { fixedCostPerDeliveryMinor: input.fixedCostPerDeliveryMinor,
      variableCostPerKmMinor: input.variableCostPerKmMinor, currency: input.currency };
  }
  return { expectedVersion: input.expectedVersion, costModel,
    defaultPolicy: input.defaultPolicy === undefined ? undefined : normalizePolicy(input.defaultPolicy) };
}

function estimateInternalCost(model, distanceM) {
  if (!model) return { status: 'insufficient_data', reason: 'FLEET_COST_MODEL_NOT_CONFIGURED' };
  if (model.variableCostPerKmMinor > 0 && !Number.isSafeInteger(distanceM))
    return { status: 'insufficient_data', reason: 'DELIVERY_DISTANCE_UNKNOWN' };
  const variable = model.variableCostPerKmMinor === 0 ? 0 : Number((BigInt(model.variableCostPerKmMinor) * BigInt(distanceM) + 999n) / 1000n);
  const amount = model.fixedCostPerDeliveryMinor + variable;
  if (!Number.isSafeInteger(amount) || amount > MAX_MINOR) return { status: 'insufficient_data', reason: 'COST_MODEL_OVERFLOW' };
  return { status: 'known', amountMinor: amount, currency: model.currency, fixedCostMinor: model.fixedCostPerDeliveryMinor,
    variableCostMinor: variable, variableCostPerKmMinor: model.variableCostPerKmMinor, distanceM: Number.isSafeInteger(distanceM) ? distanceM : null,
    rounding: 'variable component rounded up to the next minor unit', source: 'operator_configured_fleet_model', componentsKnown: 2, componentsTotal: 2 };
}

function normalizedOperationalStatus(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/gu,'').trim().toUpperCase();
}

function summarizeFleetCapacity(drivers = [], deliveries = []) {
  const workload = new Map();
  let assignedDeliveries = 0, inProgressDeliveries = 0;
  for (const delivery of deliveries) {
    const driverId = typeof delivery.driverId === 'string' ? delivery.driverId : null;
    const status = String(delivery.status || '').toUpperCase();
    if (!driverId) continue;
    const item = workload.get(driverId) || { assigned: 0, inProgress: 0, unknown: 0 };
    if (ACTIVE_DELIVERY_STATES.has(status)) {
      item.assigned += 1; assignedDeliveries += 1;
      if (IN_PROGRESS_DELIVERY_STATES.has(status)) { item.inProgress += 1; inProgressDeliveries += 1; }
    } else if (!TERMINAL_DELIVERY_STATES.has(status)) item.unknown += 1;
    workload.set(driverId,item);
  }
  let activeDrivers = 0, knownUnavailableDrivers = 0, unknownStatusDrivers = 0;
  const driversWithLoad = [], byDriver=[];
  let explicitlyAvailable = false;
  for (const driver of drivers) {
    const status = normalizedOperationalStatus(driver.status), load = workload.get(driver.driverId) || { assigned: 0, inProgress: 0, unknown: 0 };
    const active = ACTIVE_DRIVER_STATES.has(status), unavailable = UNAVAILABLE_DRIVER_STATES.has(status);
    if (active) activeDrivers += 1;
    else if (unavailable) knownUnavailableDrivers += 1;
    else unknownStatusDrivers += 1;
    if (load.assigned) driversWithLoad.push({ driverId: driver.driverId, assigned: load.assigned, inProgress: load.inProgress });
    const configured=driver.capacity?.unit==='deliveries'&&Number.isSafeInteger(driver.capacity.limit)&&driver.capacity.limit>=1&&driver.capacity.limit<=500;
    const loadKnown=load.unknown===0;
    const capacityKnown=configured&&loadKnown;
    const remainingSlots=capacityKnown?Math.max(0,driver.capacity.limit-load.assigned):null;
    const capacityStatus=!capacityKnown?'unknown':remainingSlots>0?'slots_available':'full';
    const available=active&&['AVAILABLE','DISPONIVEL'].includes(status)&&loadKnown&&load.assigned===0;
    if (available) explicitlyAvailable = true;
    byDriver.push({driverId:driver.driverId,status:driver.status||null,active,availability:available?'available':unavailable?'unavailable':'unknown',
      capacityLimit:configured?driver.capacity.limit:null,capacityUnit:configured?'deliveries':null,assignedDeliveries:load.assigned,
      inProgressDeliveries:load.inProgress,loadKnown,unknownAssignedDeliveries:load.unknown,remainingSlots,capacityStatus});
  }
  const availability = explicitlyAvailable ? 'available' :
    drivers.length > 0 && activeDrivers === 0 && unknownStatusDrivers === 0 ? 'unavailable' : 'unknown';
  const knownCapacity=byDriver.filter(driver=>driver.capacityStatus!=='unknown');
  return { availability, activeDrivers, knownUnavailableDrivers, unknownStatusDrivers,byDriver,
    assignedDeliveries, inProgressDeliveries, driversWithLoad,
    capacityDriversKnown:knownCapacity.length, capacityDriversTotal:drivers.length,
    remainingSlots:knownCapacity.length===drivers.length&&drivers.length>0?knownCapacity.reduce((sum,driver)=>sum+driver.remainingSlots,0):null,
    capacityStatus:drivers.length>0&&knownCapacity.length===drivers.length?'known':'unknown',
    evidence: { driverStatusesObserved: drivers.length, canonicalWorkloadObserved: true, capacityConfigurationObserved:true },
    reasons: [
      ...(availability === 'available' ? [{ code: 'EXPLICIT_AVAILABLE_STATUS', message: 'Há ao menos um Driver com status explicitamente disponível e sem entrega atribuída no retrato canônico.' }] : []),
      ...(driversWithLoad.length ? [{ code: 'KNOWN_ASSIGNED_WORKLOAD', message: 'Entregas atribuídas/em andamento foram contadas por Driver.' }] : []),
      ...(knownCapacity.length<drivers.length ? [{ code: 'CAPACITY_LIMIT_OR_LOAD_UNKNOWN', message: 'Limite por Driver não configurado ou carga atribuída incompleta; slots desse Driver permanecem desconhecidos.' }] : []),
      ...(unknownStatusDrivers ? [{ code: 'DRIVER_STATUS_UNRECOGNIZED', message: 'Há status de Driver sem semântica operacional conhecida.' }] : [])
    ] };
}

function assessRouteCompatibility({ deliveryId, deliveryDriverId = null, routes = [], targetCoordinatesKnown = false } = {}) {
  if (deliveryDriverId) return { status: 'not_applicable', compatibility: 'unknown', candidates: [],
    reason: 'DELIVERY_ALREADY_ASSIGNED', message: 'A Delivery já possui Driver; a avaliação de inclusão em outra rota não se aplica.' };
  const active = routes.filter(route => ACTIVE_ROUTE_STATES.has(String(route.status || '').toUpperCase()));
  if (!active.length) return { status: 'no_active_route_observed', compatibility: 'unknown', candidates: [],
    reason: 'NO_ACTIVE_ROUTE_OBSERVED', message: 'Nenhuma Route ativa foi encontrada no retrato canônico do backend.' };
  const candidates = [], rejected = [];
  for (const route of active) {
    if ((route.deliveryIds || []).includes(deliveryId)) {
      rejected.push({ routeId: route.routeId, reason: 'DELIVERY_ALREADY_IN_ROUTE' }); continue;
    }
    const resolvedStops=(route.stops||[]).filter(stop=>stop.found!==false);
    const driverIds = [...new Set(resolvedStops.map(stop => stop.driverId).filter(Boolean))];
    if (!resolvedStops.length || driverIds.length !== 1 || resolvedStops.some(stop => !stop.driverId)) {
      rejected.push({ routeId: route.routeId, reason: 'ROUTE_DRIVER_NOT_UNAMBIGUOUS' }); continue;
    }
    const driverStatus = normalizedOperationalStatus(resolvedStops[0].driverStatus);
    if (!ACTIVE_DRIVER_STATES.has(driverStatus)) {
      rejected.push({ routeId: route.routeId, driverId: driverIds[0], reason: UNAVAILABLE_DRIVER_STATES.has(driverStatus) ? 'ROUTE_DRIVER_UNAVAILABLE' : 'ROUTE_DRIVER_STATUS_UNKNOWN' });
      continue;
    }
    const orderedStops=route.stops||[],remainingStops=orderedStops.filter(stop=>ACTIVE_DELIVERY_STATES.has(String(stop.status||'').toUpperCase()));
    const stopsWithCoordinates = remainingStops.filter(stop => stop.coordinatesKnown).length;
    candidates.push({ routeId: route.routeId, status: route.status, driverId: driverIds[0], stopCount: remainingStops.length,
      deliveryIds:remainingStops.map(stop=>stop.deliveryId),
      destinationCoordinateCoverage: remainingStops.length ? stopsWithCoordinates / remainingStops.length : 0,
      targetCoordinatesKnown: Boolean(targetCoordinatesKnown), compatibility: 'unknown',
      incrementalDistanceM: null, marginalCost: { status: 'insufficient_data', reason: 'CAPACITY_OR_DISTANCE_UNKNOWN' },
      planComplete: route.deliveryIds.length>0&&route.stops.length===route.deliveryIds.length&&route.stops.every((stop,index)=>
        stop.found===true&&stop.deliveryId===route.deliveryIds[index]&&
        (ACTIVE_DELIVERY_STATES.has(String(stop.status||'').toUpperCase())||TERMINAL_DELIVERY_STATES.has(String(stop.status||'').toUpperCase())))&&
        remainingStops.length>0&&new Set(route.deliveryIds).size===route.deliveryIds.length,
      plannedStops:route.stops.map((stop,index)=>({deliveryId:stop.deliveryId,sequence:index+1,status:stop.status||null,found:stop.found===true})),
      reason: !targetCoordinatesKnown || stopsWithCoordinates !== remainingStops.length ? 'CONFIRMED_DESTINATION_COORDINATES_INCOMPLETE' : 'ROAD_DISTANCE_MODEL_UNAVAILABLE',
      explanation: !targetCoordinatesKnown || stopsWithCoordinates !== remainingStops.length ?
        'Faltam coordenadas de destino confirmadas para todas as paradas e para a nova entrega.' :
        'Driver ativo e Route canônica identificados. A capacidade, completude e distância serão validadas antes de sugerir uma posição.' });
  }
  if (candidates.length) return { status: 'candidate_requires_route_validation', compatibility: 'unknown', candidates, rejected,
    reason: 'ROAD_DISTANCE_MODEL_UNAVAILABLE', message: 'A rota é candidata por vínculo canônico com um Driver ativo; compatibilidade geográfica e distância incremental não podem ser confirmadas.' };
  return { status: 'no_compatible_route_observed', compatibility: 'incompatible', candidates: [], rejected,
    reason: 'NO_OPERATIONALLY_COMPATIBLE_ROUTE', message: 'Nenhuma Route ativa observada tem um Driver interno ativo e inequívoco.' };
}

function makeRecommendation(alternatives, policy) {
  const eligible = alternatives.filter(item => item.eligible);
  const decisionCost = item => item.decisionCost || item.cost;
  const abstain = (code, message, details = {}) => ({ status: 'insufficient_data', selectedAlternativeId: null,
    tiedAlternativeIds: [], why: { code, message, ...details } });
  if (eligible.length < 2) return abstain('NOT_ENOUGH_ELIGIBLE_ALTERNATIVES', 'São necessárias pelo menos duas alternativas operacionais elegíveis para recomendar.');
  if (policy === 'prefer_internal') {
    const own = eligible.find(item => item.mode === 'internal');
    if (!own) return abstain('INTERNAL_FLEET_UNAVAILABLE', 'A frota própria não está elegível neste recorte.');
    const cost = own.decisionCost || own.cost;
    if (cost.status !== 'known') return abstain(cost.reason || 'INTERNAL_COST_UNKNOWN', 'A preferência pela frota própria não substitui o custo marginal ou os dados operacionais ausentes.', { requirements: ['configure fixed cost, variable cost per km and currency', 'provide a valid delivery distance when the variable rate is positive', 'confirm there is no active route requiring an unknown incremental road distance'] });
    return { status: 'recommended', selectedAlternativeId: own.id, tiedAlternativeIds: [], why: {
      code: 'POLICY_PREFER_INTERNAL', message: 'A frota própria foi recomendada pela política configurada; a decisão final e a confirmação de capacidade são humanas.',
      evidence: [{ code: 'INTERNAL_FLEET_PREFERENCE', value: policy }, { code: 'CONFIGURED_COST', amountMinor: cost.amountMinor, currency: cost.currency }],
      limitations: ['fleet capacity is not verified by this comparison', 'this is a configured estimate, not realized operating cost'] } };
  }
  if (policy === 'lowest_cost') {
    const missing = eligible.filter(item => decisionCost(item).status !== 'known');
    if (missing.length) return abstain('COST_COVERAGE_INCOMPLETE', 'Há alternativas elegíveis sem custo conhecido; não é possível afirmar qual tem menor custo.', { missingAlternativeIds: missing.map(item => item.id) });
    const currencies = [...new Set(eligible.map(item => decisionCost(item).currency))];
    if (currencies.length !== 1) return abstain('CURRENCY_MISMATCH', 'As alternativas usam moedas diferentes; nenhuma conversão é feita.', { currencies });
    const min = Math.min(...eligible.map(item => decisionCost(item).amountMinor));
    const winners = eligible.filter(item => decisionCost(item).amountMinor === min).sort((a,b) => a.id.localeCompare(b.id));
    if (winners.length > 1) return { status: 'tie', selectedAlternativeId: null, tiedAlternativeIds: winners.map(item => item.id),
      why: { code: 'COST_TIE', message: 'As alternativas têm o mesmo valor nominal conhecido; a decisão continua humana.', currency: currencies[0], amountMinor: min } };
    return { status: 'recommended', selectedAlternativeId: winners[0].id, tiedAlternativeIds: [], why: {
      code: 'LOWEST_KNOWN_AMOUNT', message: 'Menor valor nominal entre custos/quotes conhecidos na mesma moeda; escopos e cobertura são exibidos por alternativa.',
      evidence: [{ code: 'LOWEST_AMOUNT', amountMinor: min, currency: currencies[0] }],
      limitations: ['external quote is not a realized charge', 'fleet estimate covers only the configured fixed and distance components', 'capacity is not verified; operator must decide'] } };
  }
  if (eligible.some(item => !item.etaAt)) return abstain('ETA_COVERAGE_INCOMPLETE', 'ETA não é conhecido para todas as alternativas elegíveis; o sistema não estima nem inventa prazo.', { missingAlternativeIds: eligible.filter(item => !item.etaAt).map(item => item.id) });
  const dated = eligible.filter(item => Number.isFinite(Date.parse(item.etaAt))).sort((a,b) => Date.parse(a.etaAt)-Date.parse(b.etaAt) || a.id.localeCompare(b.id));
  if (dated.length !== eligible.length) return abstain('ETA_INVALID', 'Uma ou mais alternativas têm ETA indisponível ou inválido.');
  const first = Date.parse(dated[0].etaAt), tied = dated.filter(item => Date.parse(item.etaAt) === first);
  if (tied.length > 1) return { status: 'tie', selectedAlternativeId: null, tiedAlternativeIds: tied.map(item => item.id),
    why: { code: 'ETA_TIE', message: 'As alternativas têm o mesmo ETA conhecido; a decisão continua humana.' } };
  return { status: 'recommended', selectedAlternativeId: dated[0].id, tiedAlternativeIds: [], why: {
    code: 'EARLIEST_KNOWN_ETA', message: 'Menor ETA explicitamente fornecido entre alternativas elegíveis.',
    evidence: [{ code: 'EARLIEST_ETA', etaAt: dated[0].etaAt }], limitations: ['capacity is not verified; operator must decide'] } };
}

function createLogisticsIntelligenceService({ clock = () => new Date(), testProvider = null, ensureInternalProvider, routeDistanceProvider = null } = {}) {
  const routeDistanceService=createRouteDistanceService({provider:routeDistanceProvider});
  async function loadFleetCapacity(client, companyId) {
    const driverResult = await client.query(`SELECT record_id::text AS driver_id,payload->>'status' AS status,payload->'capacity' AS capacity FROM rotamoto.domain_records
      WHERE company_id=$1 AND entity_type='Driver' AND deleted_at IS NULL ORDER BY record_id`,[companyId]);
    const deliveryResult = await client.query(`SELECT payload->>'driverId' AS driver_id,payload->>'status' AS status FROM rotamoto.domain_records
      WHERE company_id=$1 AND entity_type='Delivery' AND deleted_at IS NULL AND NULLIF(payload->>'driverId','') IS NOT NULL`,[companyId]);
    return summarizeFleetCapacity(driverResult.rows.map(row=>({driverId:row.driver_id,status:row.status,capacity:row.capacity})),
      deliveryResult.rows.map(row=>({driverId:row.driver_id,status:row.status})));
  }

  async function loadRouteSnapshot(client, companyId, deliveryId, deliveryDriverId = null) {
    const routeSettings = await getRouteSettings(client,companyId);
    const targetGeo = await client.query(`SELECT provenance,accuracy_m,latitude,longitude FROM rotamoto.delivery_geo_snapshots
      WHERE company_id=$1 AND delivery_id=$2`,[companyId,deliveryId]);
    const routesResult = await client.query(`WITH active_routes AS (
          SELECT r.record_id,r.version,r.payload,r.updated_at,count(*) OVER() AS total_routes
          FROM rotamoto.domain_records r WHERE r.company_id=$1 AND r.entity_type='Route' AND r.deleted_at IS NULL
            AND upper(coalesce(r.payload->>'status',''))=ANY($2::text[])
          ORDER BY r.updated_at DESC,r.record_id LIMIT 100
        ) SELECT r.record_id::text AS route_id,r.version AS route_version,r.payload->>'status' AS status,
          CASE WHEN jsonb_typeof(r.payload->'deliveryIds')='array' THEN r.payload->'deliveryIds' ELSE '[]'::jsonb END AS delivery_ids,
          coalesce(r.total_routes,0)::int AS total_routes,
          coalesce(jsonb_agg(jsonb_build_object('deliveryId',members.value,'found',stop.record_id IS NOT NULL,
            'driverId',stop.payload->>'driverId','status',stop.payload->>'status','driverStatus',driver.payload->>'status',
            'driverCapacity',driver.payload->'capacity','coordinatesKnown',
            (geo.delivery_id IS NOT NULL AND geo.provenance IN ('manual','customer_destination') AND geo.accuracy_m BETWEEN 0 AND 100),
            'coordinates',CASE WHEN geo.provenance IN ('manual','customer_destination') AND geo.accuracy_m BETWEEN 0 AND 100
              THEN jsonb_build_object('latitude',geo.latitude,'longitude',geo.longitude) ELSE NULL END)
            ORDER BY members.ordinality) FILTER(WHERE members.value IS NOT NULL),'[]'::jsonb) AS stops
        FROM active_routes r
        LEFT JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.payload->'deliveryIds')='array'
          THEN r.payload->'deliveryIds' ELSE '[]'::jsonb END) WITH ORDINALITY AS members(value,ordinality) ON true
        LEFT JOIN rotamoto.domain_records stop ON stop.company_id=$1 AND stop.entity_type='Delivery' AND stop.deleted_at IS NULL
          AND stop.record_id::text=members.value
        LEFT JOIN rotamoto.domain_records driver ON driver.company_id=stop.company_id AND driver.entity_type='Driver'
          AND driver.deleted_at IS NULL AND driver.record_id::text=stop.payload->>'driverId'
        LEFT JOIN rotamoto.delivery_geo_snapshots geo ON geo.company_id=stop.company_id AND geo.delivery_id=stop.record_id
        GROUP BY r.record_id,r.version,r.payload,r.updated_at,r.total_routes ORDER BY r.updated_at DESC,r.record_id`,[companyId,[...ACTIVE_ROUTE_STATES]]);
    const routes = routesResult.rows.map(row=>({ routeId:row.route_id,routeVersion:Number(row.route_version),status:row.status,
      deliveryIds:Array.isArray(row.delivery_ids)?row.delivery_ids.filter(id=>typeof id==='string'):[],
      stops:Array.isArray(row.stops)?row.stops:[] }));
    const target=targetGeo.rows[0];
    const targetCoordinatesKnown=Boolean(target && ['manual','customer_destination'].includes(target.provenance)&&
      Number.isFinite(Number(target.accuracy_m))&&Number(target.accuracy_m)>=0&&Number(target.accuracy_m)<=100);
    const result=assessRouteCompatibility({deliveryId,deliveryDriverId,routes,targetCoordinatesKnown});
    result.routesObserved=Number(routesResult.rows[0]?.total_routes||0);
    result.routeScanLimit=100;
    result.scanComplete=result.routesObserved<=100;
    if (!result.scanComplete) result.limitations=['A análise consultou as 100 Routes ativas mais recentes; há outras Routes no tenant.'];
    result.targetCoordinate={known:targetCoordinatesKnown,provenance:target?.provenance||null,accuracyM:target?.accuracy_m==null?null:Number(target.accuracy_m)};
    result.routes=routes;
    result.origin={mode:routeSettings.originMode,source:routeSettings.originMode==='custom'?'coordenada informada pelo administrador':'estabelecimento',
      known:routeSettings.origin?.latitude!=null&&routeSettings.origin?.longitude!=null,provenance:routeSettings.originProvenance,
      version:routeSettings.version,establishmentLocationVersion:routeSettings.establishmentLocationVersion,
      returnToOrigin:routeSettings.returnToOrigin};
    const coordinatesByDeliveryId=Object.create(null);
    if(routeSettings.origin)coordinatesByDeliveryId.__route_origin__=routeSettings.origin;
    if(targetCoordinatesKnown)coordinatesByDeliveryId[deliveryId]={latitude:Number(target.latitude),longitude:Number(target.longitude)};
    for(const route of routes)for(const stop of route.stops||[])if(stop.found&&stop.coordinatesKnown&&stop.coordinates&&
      Number.isFinite(stop.coordinates.latitude)&&Number.isFinite(stop.coordinates.longitude))coordinatesByDeliveryId[stop.deliveryId]=stop.coordinates;
    for(const route of routes)for(const stop of route.stops||[])delete stop.coordinates;
    Object.defineProperty(result,'coordinatesByDeliveryId',{value:coordinatesByDeliveryId,enumerable:false});
    Object.defineProperty(result,'routeSettings',{value:routeSettings,enumerable:false});
    return result;
  }

  async function enrichRouteInsertions(client,routeAssessment,fleetCapacity,companyId,deliveryId,deliveryStatus,costModel) {
    if(deliveryAssessmentNotInsertable(deliveryStatus))return routeAssessment;
    for(const candidate of routeAssessment.candidates||[]){
      const route=(routeAssessment.routes||[]).find(item=>item.routeId===candidate.routeId);
      const driver=fleetCapacity.byDriver.find(item=>item.driverId===candidate.driverId);
      candidate.routeVersion=route?.routeVersion??null;
      candidate.capacity=driver?{status:driver.capacityStatus,limit:driver.capacityLimit,load:driver.assignedDeliveries,
        remainingSlots:driver.remainingSlots,availability:driver.availability,loadKnown:driver.loadKnown}: {status:'unknown',limit:null,load:null,remainingSlots:null,availability:'unknown'};
      candidate.order={source:'Route.deliveryIds',complete:Boolean(candidate.planComplete),plannedStops:candidate.plannedStops};
      if(!candidate.planComplete){candidate.compatibility='unknown';candidate.reason='ROUTE_PLAN_INCOMPLETE';
        candidate.insertion={status:'unknown',reason:'ROUTE_PLAN_INCOMPLETE',candidates:[],bestPosition:null};
        candidate.marginalCost={status:'insufficient_data',reason:'ROUTE_PLAN_INCOMPLETE'};continue}
      if(!driver||driver.capacityStatus==='unknown'){
        candidate.compatibility='unknown';candidate.reason='CAPACITY_UNKNOWN';
        candidate.insertion={status:'unknown',reason:'CAPACITY_UNKNOWN',routeDistance:{status:'unknown',distanceM:null,provenance:null},candidates:[],bestPosition:null};
        candidate.marginalCost={status:'insufficient_data',reason:'CAPACITY_UNKNOWN'};continue}
      if(driver.remainingSlots<=0){candidate.compatibility='incompatible';candidate.reason='CAPACITY_FULL';
        candidate.insertion={status:'unavailable',reason:'CAPACITY_FULL',routeDistance:{status:'unknown',distanceM:null,provenance:null},candidates:[],bestPosition:null};
        candidate.marginalCost={status:'insufficient_data',reason:'CAPACITY_FULL'};continue}
      const routeStatus=String(route?.status||'').toUpperCase(),requiresOrigin=!['ACTIVE','IN_PROGRESS'].includes(routeStatus)||routeAssessment.origin?.returnToOrigin;
      if(requiresOrigin&&!routeAssessment.origin?.known){candidate.compatibility='unknown';candidate.reason='ROUTE_ORIGIN_UNKNOWN';
        candidate.positionEvidence={start:'unknown',source:routeAssessment.origin?.source||'estabelecimento',returnToOrigin:Boolean(routeAssessment.origin?.returnToOrigin)};
        candidate.insertion={status:'unknown',reason:'ROUTE_ORIGIN_UNKNOWN',routeDistance:{status:'unknown',distanceM:null,provenance:null},candidates:[],bestPosition:null};
        candidate.marginalCost={status:'insufficient_data',reason:'ROUTE_ORIGIN_UNKNOWN'};continue}
      let startCoordinate=routeAssessment.coordinatesByDeliveryId.__route_origin__,startSource='origem configurada',locationEvidence=null;
      if(['ACTIVE','IN_PROGRESS'].includes(routeStatus)){
        const position=await client.query(`SELECT point.payload FROM rotamoto.domain_records point
          JOIN rotamoto.domain_records delivery ON delivery.company_id=point.company_id AND delivery.record_id=point.related_record_id
            AND delivery.entity_type='Delivery' AND delivery.deleted_at IS NULL
          WHERE point.company_id=$1 AND point.entity_type='LocationPoint' AND point.deleted_at IS NULL
            AND delivery.payload->>'driverId'=$2 AND upper(coalesce(delivery.payload->>'status',''))=ANY($3::text[])
          ORDER BY (point.payload->>'recordedAt') DESC,point.updated_at DESC LIMIT 1`,
        [companyId,candidate.driverId,[...IN_PROGRESS_DELIVERY_STATES]]);
        const point=position.rows[0]?.payload||null,at=point?.recordedAt?Date.parse(point.recordedAt):NaN,now=clock().getTime();
        const valid=point&&Number.isFinite(Number(point.latitude))&&Number(point.latitude)>=-90&&Number(point.latitude)<=90&&
          Number.isFinite(Number(point.longitude))&&Number(point.longitude)>=-180&&Number(point.longitude)<=180&&
          Number.isFinite(at)&&at<=now+30_000&&now-at<=120_000&&Number.isFinite(Number(point.accuracyM))&&Number(point.accuracyM)>=0&&Number(point.accuracyM)<=100;
        locationEvidence={status:valid?'known':'unknown',provenance:'LocationPoint Motoboy vinculado a Delivery do Driver interno',recordedAt:valid?point.recordedAt:null,
          accuracyM:valid?Number(point.accuracyM):null,reason:valid?null:'DRIVER_LOCATION_STALE_OR_INVALID'};
        if(valid){startCoordinate={latitude:Number(point.latitude),longitude:Number(point.longitude)};startSource='posição atual confiável do Driver';}
        else {candidate.compatibility='unknown';candidate.reason='DRIVER_LOCATION_STALE_OR_INVALID';candidate.positionEvidence={start:'unknown',location:locationEvidence,
          originSource:routeAssessment.origin.source,returnToOrigin:routeAssessment.origin.returnToOrigin};candidate.insertion={status:'unknown',reason:candidate.reason,
          routeDistance:{status:'unknown',distanceM:null,provenance:null},candidates:[],bestPosition:null};candidate.marginalCost={status:'insufficient_data',reason:candidate.reason};continue}
      }
      const insertion=await calculateInsertionOptions({companyId,routeId:candidate.routeId,deliveryIds:candidate.deliveryIds,
        newDeliveryId:deliveryId,capacity:{status:'known',remainingSlots:driver.remainingSlots},routeDistanceService,
        coordinatesByDeliveryId:routeAssessment.coordinatesByDeliveryId,startCoordinate,
        endCoordinate:routeAssessment.origin.returnToOrigin?routeAssessment.coordinatesByDeliveryId.__route_origin__:null,
        startLabel:routeStatus==='PLANNED'?'origin':'driver-position',endLabel:'origin'});
      if(insertion.status==='known'){
        const toCanonicalPosition=position=>position<candidate.deliveryIds.length?route.deliveryIds.indexOf(candidate.deliveryIds[position]):route.deliveryIds.length;
        insertion.bestRoutePosition=toCanonicalPosition(insertion.bestPosition);
        for(const option of insertion.candidates)option.routePosition=toCanonicalPosition(option.position);
      }
      candidate.insertion=insertion;candidate.compatibility=insertion.status==='known'?'compatible':insertion.status==='unavailable'?'unknown':'unknown';
      candidate.incrementalDistanceM=insertion.incrementalDistanceM??null;
      candidate.distanceProvenance=insertion.provenance||insertion.routeDistance?.provenance||null;
      candidate.positionEvidence={start:startSource,location:locationEvidence,originSource:routeAssessment.origin.source,
        returnToOrigin:routeAssessment.origin.returnToOrigin,originVersion:routeAssessment.origin.version,
        policy:routeAssessment.origin.returnToOrigin?'return_to_origin':'end_at_last_delivery'};
      candidate.reason=insertion.reason||null;
      candidate.explanation=insertion.status==='known'?
        `Rota, ordem, capacidade e escopo viário completo verificados. Início: ${startSource}; ${routeAssessment.origin.returnToOrigin?'retorna à origem':'termina na última entrega'}. Posição ${insertion.bestPosition+1} em Route.deliveryIds; distância ${insertion.routeDistance.distanceM} m, após inserção ${insertion.distanceAfterInsertionM} m, acréscimo ${insertion.incrementalDistanceM} m.`:
        `A inserção não pode ser calculada: ${insertion.reason||insertion.status}.`;
      if(insertion.status==='known'){
        const marginal=estimateInternalCost(costModel,insertion.incrementalDistanceM);
        candidate.marginalCost=marginal.status==='known'?{...marginal,basis:'marginal_route_insertion',formula:'fixedCostPerDeliveryMinor + ceil(variableCostPerKmMinor × incrementalDistanceM / 1000)',
          distanceProvenance:insertion.provenance,capacityEvidence:candidate.capacity,routeOrderSource:'Route.deliveryIds',positionEvidence:candidate.positionEvidence,limitations:['fixed cost remains charged per added delivery',
            'distance covers configured origin/current trusted internal Driver position, ordered remaining stops, and configured return leg',
            'distance provider provenance is required; no straight-line fallback']} : marginal;
      }else candidate.marginalCost={status:'insufficient_data',reason:insertion.reason||'ROUTE_DISTANCE_UNKNOWN'};
    }
    const bestKnown=(routeAssessment.candidates||[]).filter(item=>item.compatibility==='compatible'&&item.marginalCost?.status==='known')
      .sort((a,b)=>a.marginalCost.amountMinor-b.marginalCost.amountMinor||a.routeId.localeCompare(b.routeId)||a.insertion.bestPosition-b.insertion.bestPosition)[0];
    if(bestKnown){routeAssessment.status='insertion_calculated';routeAssessment.bestInsertion={routeId:bestKnown.routeId,driverId:bestKnown.driverId,
      position:bestKnown.insertion.bestRoutePosition??bestKnown.insertion.bestPosition,activeSequencePosition:bestKnown.insertion.bestPosition,
      incrementalDistanceM:bestKnown.insertion.incrementalDistanceM,
      distanceAfterInsertionM:bestKnown.insertion.distanceAfterInsertionM,marginalCost:bestKnown.marginalCost,
      distanceProvenance:bestKnown.distanceProvenance,positionEvidence:bestKnown.positionEvidence};
      routeAssessment.message='Inserção calculada com capacidade, ordem e distância provenientes de dados verificáveis.';}
    else if(routeAssessment.candidates?.length)routeAssessment.status='candidate_requires_validation';
    return routeAssessment;
  }

  function deliveryAssessmentNotInsertable(status){return !['CREATED','REDELIVERY'].includes(String(status||'').toUpperCase())}

  async function readSettings(client, companyId) {
    const result = await client.query(`SELECT fixed_cost_per_delivery_minor,variable_cost_per_km_minor,currency,default_policy,version,updated_at
      FROM rotamoto.logistics_intelligence_settings WHERE company_id=$1`, [companyId]);
    const row = result.rows[0];
    return row ? { configured: row.fixed_cost_per_delivery_minor !== null,
      costModel: row.fixed_cost_per_delivery_minor === null ? null : { fixedCostPerDeliveryMinor: Number(row.fixed_cost_per_delivery_minor),
        variableCostPerKmMinor: Number(row.variable_cost_per_km_minor), currency: row.currency,
        formula: 'fixedCostPerDelivery + ceil(variableCostPerKm × estimatedDistanceM / 1000)' },
      defaultPolicy: row.default_policy, version: row.version, updatedAt: row.updated_at } :
      { configured: false, costModel: null, defaultPolicy: 'lowest_cost', version: 0, updatedAt: null };
  }
  async function getSettings(client, principal) { return { settings: await readSettings(client, principal.company_id), policies: POLICIES }; }
  async function getRouteSettings(client, companyId) {
    const result=await client.query(`SELECT COALESCE(route.origin_mode,'establishment') AS origin_mode,
        CASE WHEN COALESCE(route.origin_mode,'establishment')='custom' THEN route.origin_latitude ELSE company.operational_latitude END AS origin_latitude,
        CASE WHEN COALESCE(route.origin_mode,'establishment')='custom' THEN route.origin_longitude ELSE company.operational_longitude END AS origin_longitude,
        CASE WHEN COALESCE(route.origin_mode,'establishment')='custom' THEN route.origin_provenance ELSE company.operational_location_provenance END AS origin_provenance,
        COALESCE(route.return_to_origin,false) AS return_to_origin,COALESCE(route.version,0) AS version,
        COALESCE(company.operational_location_version,0) AS establishment_location_version,
        COALESCE(route.updated_at,company.updated_at) AS updated_at,company.operational_address
      FROM rotamoto.companies company LEFT JOIN rotamoto.logistics_route_settings route ON route.company_id=company.id
      WHERE company.id=$1`,[companyId]);
    const row=result.rows[0];
    return row?{originMode:row.origin_mode,origin:row.origin_latitude==null?null:{latitude:Number(row.origin_latitude),longitude:Number(row.origin_longitude),
        ...(row.origin_mode==='establishment'?{address:row.operational_address}: {})},
      originProvenance:row.origin_provenance,returnToOrigin:row.return_to_origin,version:Number(row.version),
      establishmentLocationVersion:Number(row.establishment_location_version),updatedAt:row.updated_at}:
      {originMode:'establishment',origin:null,originProvenance:null,returnToOrigin:false,version:0,updatedAt:null};
  }
  async function readRouteSettings(client,principal){return {settings:await getRouteSettings(client,principal.company_id),locationPolicy:{maxAgeSeconds:120,maxAccuracyM:100,
    activeRouteStart:'fresh internal Driver LocationPoint only; no fallback to establishment origin'}};}
  async function updateRouteSettings(client,principal,input){
    const allowed=new Set(['expectedVersion','originMode','latitude','longitude','returnToOrigin']);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key))||
      !Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||!['establishment','custom'].includes(input.originMode)||
      typeof input.returnToOrigin!=='boolean')invalid('Configuração de origem/retorno inválida.');
    let latitude=null,longitude=null,provenance=null;
    if(input.originMode==='custom'){
      const hasLat=input.latitude!==null&&input.latitude!==undefined,hasLon=input.longitude!==null&&input.longitude!==undefined;
      if(hasLat!==hasLon)invalid('Informe latitude e longitude juntas.');
      if(hasLat){latitude=input.latitude;longitude=input.longitude;
        if(!Number.isFinite(latitude)||latitude< -90||latitude>90||!Number.isFinite(longitude)||longitude< -180||longitude>180)invalid('Coordenadas fora dos limites válidos.');
        provenance='operator_configured';}
    }else if(input.latitude!=null||input.longitude!=null)invalid('O modo estabelecimento usa somente localização canônica existente.');
    const current=await client.query(`SELECT version FROM rotamoto.logistics_route_settings WHERE company_id=$1 FOR UPDATE`,[principal.company_id]);
    const version=current.rowCount?Number(current.rows[0].version):0;
    if(version!==input.expectedVersion)throw Object.assign(new Error('Configuração alterada em outra sessão.'),{code:'REVISION_CONFLICT'});
    const result=await client.query(`INSERT INTO rotamoto.logistics_route_settings(company_id,origin_mode,origin_latitude,origin_longitude,
      origin_provenance,return_to_origin,version,updated_by) VALUES($1,$2,$3,$4,$5,$6,1,$7)
      ON CONFLICT(company_id) DO UPDATE SET origin_mode=EXCLUDED.origin_mode,origin_latitude=EXCLUDED.origin_latitude,
        origin_longitude=EXCLUDED.origin_longitude,origin_provenance=EXCLUDED.origin_provenance,return_to_origin=EXCLUDED.return_to_origin,
        version=rotamoto.logistics_route_settings.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE rotamoto.logistics_route_settings.version=$8 RETURNING version,updated_at`,
    [principal.company_id,input.originMode,latitude,longitude,provenance,input.returnToOrigin,principal.user_id,input.expectedVersion]);
    if(!result.rowCount)throw Object.assign(new Error('Configuração alterada em outra sessão.'),{code:'REVISION_CONFLICT'});
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user','logistics.route_settings_updated','logistics_route_settings',$4,$5::jsonb)`,
    [crypto.randomUUID(),principal.company_id,principal.user_id,String(principal.company_id),JSON.stringify({originMode:input.originMode,coordinatesConfigured:latitude!==null,
      returnToOrigin:input.returnToOrigin,version:Number(result.rows[0].version)})]);
    return readRouteSettings(client,principal);
  }
  async function updateSettings(client, principal, input) {
    const normalized = normalizeSettings(input);
    if (typeof ensureInternalProvider !== 'function') throw new Error('Internal provider initializer unavailable.');
    const internal = await ensureInternalProvider(client, principal);
    const prior = await client.query(`SELECT version FROM rotamoto.logistics_intelligence_settings WHERE company_id=$1 FOR UPDATE`, [principal.company_id]);
    const version = prior.rowCount ? prior.rows[0].version : 0;
    if (version !== normalized.expectedVersion) throw Object.assign(new Error('Configuração alterada em outra sessão.'), { code: 'REVISION_CONFLICT' });
    const policy = normalized.defaultPolicy || (await readSettings(client, principal.company_id)).defaultPolicy;
    const model = normalized.costModel;
    const result = await client.query(`INSERT INTO rotamoto.logistics_intelligence_settings
      (company_id,internal_provider_id,fixed_cost_per_delivery_minor,variable_cost_per_km_minor,currency,default_policy,version,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,1,$7)
      ON CONFLICT(company_id) DO UPDATE SET internal_provider_id=EXCLUDED.internal_provider_id,
        fixed_cost_per_delivery_minor=EXCLUDED.fixed_cost_per_delivery_minor,variable_cost_per_km_minor=EXCLUDED.variable_cost_per_km_minor,
        currency=EXCLUDED.currency,default_policy=EXCLUDED.default_policy,version=rotamoto.logistics_intelligence_settings.version+1,
        updated_by=EXCLUDED.updated_by,updated_at=now()
      WHERE rotamoto.logistics_intelligence_settings.version=$8
      RETURNING fixed_cost_per_delivery_minor,variable_cost_per_km_minor,currency,default_policy,version,updated_at`,
    [principal.company_id,internal.id,model?.fixedCostPerDeliveryMinor ?? null,model?.variableCostPerKmMinor ?? null,model?.currency ?? null,policy,principal.user_id,normalized.expectedVersion]);
    if (!result.rowCount) throw Object.assign(new Error('Configuração alterada em outra sessão.'), { code: 'REVISION_CONFLICT' });
    const auditId = crypto.randomUUID();
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user','logistics.intelligence.settings_updated','logistics_intelligence_settings',$4,$5::jsonb)`,
    [auditId,principal.company_id,principal.user_id,internal.id,JSON.stringify({ version: result.rows[0].version,
      configured: model !== null, currency: model?.currency || null, fixedCostPerDeliveryMinor: model?.fixedCostPerDeliveryMinor ?? null,
      variableCostPerKmMinor: model?.variableCostPerKmMinor ?? null, defaultPolicy: policy })]);
    return { settings: { configured: model !== null, costModel: model && { ...model,
      formula: 'fixedCostPerDelivery + ceil(variableCostPerKm × estimatedDistanceM / 1000)' }, defaultPolicy: policy,
      version: result.rows[0].version, updatedAt: result.rows[0].updated_at }, policies: POLICIES };
  }

  async function compareDelivery(client, principal, deliveryId, requestedPolicy) {
    D.uuid(deliveryId, 'deliveryId');
    const policy = requestedPolicy === undefined || requestedPolicy === null || requestedPolicy === '' ?
      (await readSettings(client, principal.company_id)).defaultPolicy : normalizePolicy(requestedPolicy);
    const deliveryResult = await client.query(`SELECT d.payload AS delivery_payload,o.payload AS order_payload
      FROM rotamoto.domain_records d LEFT JOIN rotamoto.domain_records o ON o.company_id=d.company_id AND o.record_id=
        CASE WHEN d.related_record_id IS NOT NULL THEN d.related_record_id ELSE NULLIF(d.payload->>'orderId','')::uuid END AND o.entity_type='Order' AND o.deleted_at IS NULL
      WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Delivery' AND d.deleted_at IS NULL`, [principal.company_id,deliveryId]);
    if (!deliveryResult.rowCount) throw Object.assign(new Error('Entrega não encontrada.'), { code: 'NOT_FOUND' });
    const delivery = deliveryResult.rows[0].delivery_payload || {}, order = deliveryResult.rows[0].order_payload || {};
    const rawDistanceM = Number.isSafeInteger(delivery.estimatedDistanceM) && delivery.estimatedDistanceM >= 0 ? delivery.estimatedDistanceM :
      Number.isFinite(order.km) && order.km >= 0 && order.km <= Number.MAX_SAFE_INTEGER / 1000 ? Math.round(order.km * 1000) : null;
    const distanceSource = Number.isSafeInteger(delivery.estimatedDistanceM) ? 'Delivery.estimatedDistanceM' : rawDistanceM !== null ? 'Order.km (legacy estimate)' : null;
    const settings = await readSettings(client, principal.company_id);
    const fleetCapacity = await loadFleetCapacity(client,principal.company_id);
    const routeAssessment = await loadRouteSnapshot(client,principal.company_id,deliveryId,delivery.driverId||null);
    await enrichRouteInsertions(client,routeAssessment,fleetCapacity,principal.company_id,deliveryId,delivery.status,settings.costModel);
    const internalResult = await client.query(`SELECT provider_id,enabled FROM rotamoto.logistics_providers
      WHERE company_id=$1 AND code='internal_fleet'`, [principal.company_id]);
    const alternatives = [];
    if (internalResult.rowCount && internalResult.rows[0].enabled) {
      const cost = estimateInternalCost(settings.costModel, rawDistanceM);
      const routeCandidate = routeAssessment.candidates.length > 0;
      const selectedRouteMarginal=routeAssessment.bestInsertion?.marginalCost;
      const driverCanAcceptNewRoute=fleetCapacity.byDriver.some(driver=>driver.active&&driver.availability==='available'&&driver.capacityStatus==='slots_available');
      const hasUnknownActiveCapacity=fleetCapacity.byDriver.some(driver=>driver.active&&driver.capacityStatus==='unknown');
      const isolatedDecisionCost = routeAssessment.status === 'no_active_route_observed' && routeAssessment.scanComplete
        ? driverCanAcceptNewRoute ? { ...cost, basis:'new_route_assumption', assumption:'explicitly available Driver with configured capacity; no active canonical Route observed; local-only Route may exist' }
          : { status:'insufficient_data',reason:hasUnknownActiveCapacity?'CAPACITY_UNKNOWN':'NO_DRIVER_WITH_KNOWN_CAPACITY' }
        : { status:'insufficient_data',reason:routeCandidate?'ROUTE_INSERTION_NOT_PROVEN':'ROUTE_STATE_NOT_COMPLETE' };
      const decisionCost=selectedRouteMarginal?.status==='known' ? selectedRouteMarginal : isolatedDecisionCost;
      const internalEligible=fleetCapacity.byDriver.some(driver=>driver.active&&(driver.capacityStatus==='unknown'||driver.remainingSlots>0));
      alternatives.push({ id: `internal:${internalResult.rows[0].provider_id}`, mode: 'internal', providerId: internalResult.rows[0].provider_id,
        providerName: 'Frota própria', kind: 'configured_estimate', eligible: internalEligible,
        availability: { status: fleetCapacity.availability, requiresHumanConfirmation: fleetCapacity.availability !== 'available' },
        etaAt: null, etaStatus: 'unknown', cost, decisionCost,
        marginalCost:selectedRouteMarginal||isolatedDecisionCost,
        fleetCapacity, routeAssessment,
        reasons: [{ code: selectedRouteMarginal?'FULL_ROUTE_MARGINAL_COST':decisionCost.status==='known'?'CAPACITY_AND_COST_KNOWN':'CAPACITY_OR_ROUTE_UNKNOWN', message: selectedRouteMarginal ?
          `Rota ${routeAssessment.bestInsertion.routeId}: distância integral ${routeAssessment.bestInsertion.distanceAfterInsertionM} m, delta ${routeAssessment.bestInsertion.incrementalDistanceM} m e custo marginal ${selectedRouteMarginal.currency} ${selectedRouteMarginal.amountMinor}, incluindo início operacional e política de retorno. Proveniência ${routeAssessment.bestInsertion.distanceProvenance?.providerId||'informada'}.` : decisionCost.status==='known' ?
          'Há Driver explicitamente disponível, limite de entregas conhecido e slots restantes; o custo apresentado é isolado para uma nova rota.' :
          internalEligible?'Capacidade, ordem da Route, distância ou perfil de custo ainda não foram comprovados para recomendar a frota própria.':'Nenhum Driver ativo com capacidade conhecida disponível foi encontrado para a nova alocação.' }] });
    }
    const providersResult = await client.query(`SELECT provider_id,code,display_name,provider_class,enabled,integration_mode,api_enabled,capabilities
      FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_class<>'internal_fleet' ORDER BY provider_id`, [principal.company_id]);
    const quotesResult = await client.query(`SELECT q.quote_id,q.provider_id,q.external_quote_id,q.status,q.currency,q.amount_minor,q.eta_at,q.issued_at,q.expires_at,
        p.code,p.display_name,p.enabled,p.integration_mode,p.api_enabled,p.capabilities
      FROM rotamoto.provider_quotes q JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
      WHERE q.company_id=$1 AND q.delivery_id=$2 ORDER BY q.created_at DESC LIMIT 50`, [principal.company_id,deliveryId]);
    const now = clock().getTime();
    for (const row of providersResult.rows) {
      const test = testProvider ? resolveTestProviderConfiguration(testProvider, principal.company_id, row.provider_id) : null;
      const apiEligible = row.enabled && (test ? row.code === test.providerCode && test.capabilities.includes('quote') && test.capabilities.includes('dispatch') :
        row.integration_mode === 'api' && row.api_enabled && row.capabilities.includes('quote') && row.capabilities.includes('dispatch'));
      const providerQuotes = quotesResult.rows.filter(quote => quote.provider_id === row.provider_id);
      const validQuotes = providerQuotes.filter(quote => apiEligible && ['available','selected'].includes(quote.status) && Date.parse(quote.expires_at) > now);
      for (const quote of validQuotes) alternatives.push({ id: `quote:${quote.quote_id}`, mode: 'external_api', providerId: row.provider_id,
        providerName: row.display_name, kind: 'provider_quote', eligible: true,
        availability: { status: 'quote_valid', requiresHumanConfirmation: true }, etaAt: quote.eta_at,
        etaStatus: quote.eta_at ? 'known_from_quote' : 'unknown', quote: { id: quote.quote_id, reference: quote.external_quote_id,
          issuedAt: quote.issued_at, expiresAt: quote.expires_at, status: quote.status },
        cost: { status: 'known', amountMinor: Number(quote.amount_minor), currency: quote.currency, source: 'provider_quote',
          scope: 'quoted provider price; not realized charge', componentsKnown: 1, componentsTotal: 1 }, reasons: [] });
      const currentManual = await client.query(`SELECT mode,estimated_cost_minor,estimated_cost_currency,eta_at,status FROM rotamoto.delivery_fulfillments
        WHERE company_id=$1 AND delivery_id=$2 AND provider_id=$3 AND mode='external' AND status<>'superseded'
        ORDER BY revision DESC LIMIT 1`, [principal.company_id,deliveryId,row.provider_id]);
      const canManual = row.enabled && (!apiEligible || !validQuotes.length);
      if (canManual) {
        const current = currentManual.rows[0];
        const cost = current?.estimated_cost_minor == null ? { status: 'insufficient_data', reason: 'MANUAL_PRICE_NOT_RECORDED' } :
          { status: 'known', amountMinor: Number(current.estimated_cost_minor), currency: current.estimated_cost_currency,
            source: 'operator_recorded_estimate', scope: 'manual estimate; not realized charge', componentsKnown: 1, componentsTotal: 1 };
        alternatives.push({ id: `manual:${row.provider_id}`, mode: 'external_manual', providerId: row.provider_id, providerName: row.display_name,
          kind: 'manual_operation', eligible: true, availability: { status: 'requires_operator', requiresHumanConfirmation: true },
          etaAt: current?.eta_at || null, etaStatus: current?.eta_at ? 'known_operator_input' : 'unknown', cost,
          reasons: current ? [] : [{ code: 'MANUAL_PRICE_NOT_RECORDED', message: 'Informe uma estimativa manual para comparar este provider.' }] });
      }
      const expired = providerQuotes.filter(quote => ['available','selected'].includes(quote.status) && Date.parse(quote.expires_at) <= now);
      for (const quote of expired.slice(0,3)) alternatives.push({ id: `expired:${quote.quote_id}`, mode: 'external_api', providerId: row.provider_id,
        providerName: row.display_name, kind: 'expired_quote', eligible: false, availability: { status: 'expired' }, etaAt: quote.eta_at,
        etaStatus: quote.eta_at ? 'known_from_expired_quote' : 'unknown', cost: { status: 'insufficient_data', reason: 'QUOTE_EXPIRED' },
        quote: { id: quote.quote_id, expiresAt: quote.expires_at, status: 'expired' }, reasons: [{ code: 'QUOTE_EXPIRED', message: 'Cotação vencida não pode ser comparada como alternativa atual.' }] });
      if (apiEligible && !validQuotes.length && !providerQuotes.some(quote => ['available','selected'].includes(quote.status) && Date.parse(quote.expires_at) <= now))
        alternatives.push({ id: `api:${row.provider_id}`, mode: 'external_api', providerId: row.provider_id, providerName: row.display_name,
          kind: 'api_without_valid_quote', eligible: false, availability: { status: 'quote_required' }, etaAt: null, etaStatus: 'unknown',
          cost: { status: 'insufficient_data', reason: 'VALID_QUOTE_REQUIRED' }, reasons: [{ code: 'VALID_QUOTE_REQUIRED', message: 'Uma cotação válida é necessária para comparar o provider API.' }] });
    }
    const earningResult = await client.query(`SELECT payload->>'amountMinor' AS amount_minor,payload->>'currency' AS currency
      FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Earning' AND deleted_at IS NULL
        AND (payload->>'deliveryId'=$2 OR related_record_id::text=$2)`, [principal.company_id,deliveryId]);
    const payoutByCurrency = new Map();
    for (const row of earningResult.rows) if (/^\d+$/u.test(row.amount_minor || '') && Money.currencyScale(row.currency)) {
      const current = payoutByCurrency.get(row.currency) || 0n; payoutByCurrency.set(row.currency,current+BigInt(row.amount_minor));
    }
    const payout = [...payoutByCurrency.entries()].map(([currency,amount]) => ({ currency,amountMinor:amount.toString(),
      meaning:'canonical Earning / driver payout record; not proof of payment or total operating cost' }));
    const recommendation = makeRecommendation(alternatives,policy);
    const routeDistanceLimitation=routeAssessment.status==='insertion_calculated'?
      'Distância viária integral usa origem configurada ou posição interna confiável, sequência Route.deliveryIds e política de retorno vigente':
      routeAssessment.candidates?.some(candidate=>candidate.insertion?.status==='unavailable')?
        'Road distance is unavailable for one or more candidate sequences; no straight-line fallback is used':
        'Road distance could not be established for the observed route; straight-line coordinates are not used as road distance';
    const knownCosts = alternatives.filter(item=>item.eligible&&(item.decisionCost||item.cost).status==='known');
    const earliestEta = alternatives.filter(item=>item.eligible&&item.etaAt&&Number.isFinite(Date.parse(item.etaAt)))
      .sort((a,b)=>Date.parse(a.etaAt)-Date.parse(b.etaAt)||a.id.localeCompare(b.id))[0] || null;
    const comparisons = alternatives.map(item=>{
      const comparedCost=item.decisionCost||item.cost;
      const sameCurrency = item.eligible&&comparedCost.status==='known' ? knownCosts.filter(other=>(other.decisionCost||other.cost).currency===comparedCost.currency) : [];
      const cheapest = sameCurrency.length ? [...sameCurrency].sort((a,b)=>(a.decisionCost||a.cost).amountMinor-(b.decisionCost||b.cost).amountMinor||a.id.localeCompare(b.id))[0] : null;
      const deltaEta = item.etaAt&&earliestEta&&Number.isFinite(Date.parse(item.etaAt)) ? Date.parse(item.etaAt)-Date.parse(earliestEta.etaAt) : null;
      return { alternativeId:item.id, ...(cheapest?{costBaselineAlternativeId:cheapest.id,costDifferenceMinor:comparedCost.amountMinor-(cheapest.decisionCost||cheapest.cost).amountMinor,currency:comparedCost.currency}:{}),
        ...(deltaEta===null?{}:{etaBaselineAlternativeId:earliestEta.id,etaDifferenceMs:deltaEta}) };
    });
    return { deliveryId, policy, policyVersion: settings.version, alternatives, comparisons, recommendation,
      capacity:fleetCapacity, routeAssessment,
      inputs: { estimatedDistanceM: rawDistanceM, distanceSource, currencyConversion: false,
        commercialOrderValueUsed: false, earningUsedAsTotalCost: false,
        driverPayout: payout, currentTime: clock().toISOString() },
      explanation: { costBasis: 'internal: configured fixed-per-delivery plus variable-per-kilometer estimate; external: valid quote or operator-entered manual estimate',
      limitations: ['Order value/revenue is not logistics cost', 'Earning is a driver payout record and is shown separately',
          'quote and estimates are not realized charges', 'fixed and variable profile covers only the components explicitly configured',
          'driver records do not prove availability or spare capacity; the operator must confirm',
          routeDistanceLimitation,
          ...(routeAssessment.origin?.known?[]:['Origem operacional sem coordenadas canônicas/confiáveis; custo marginal integral abstido']),
          'the recommendation never dispatches'] } };
  }

  async function economicAnalytics(client, principal) {
    const result = await client.query(`WITH latest AS (
      SELECT DISTINCT ON(f.delivery_id) f.delivery_id,f.mode,f.provider_id,p.code,p.display_name,f.status,
        f.estimated_cost_minor,f.estimated_cost_currency,f.final_cost_minor,f.final_cost_currency
      FROM rotamoto.delivery_fulfillments f JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
      WHERE f.company_id=$1 AND f.status<>'superseded' ORDER BY f.delivery_id,f.revision DESC
    ), costs AS (
      SELECT mode,status,count(*)::int AS allocations,
        count(*) FILTER(WHERE estimated_cost_minor IS NOT NULL)::int AS estimated_count,
        count(*) FILTER(WHERE final_cost_minor IS NOT NULL)::int AS realized_count,
        count(*) FILTER(WHERE status='completed')::int AS completed_count,
        COALESCE(jsonb_agg(jsonb_build_object('currency',estimated_cost_currency,'amountMinor',estimated_cost_minor)) FILTER(WHERE estimated_cost_minor IS NOT NULL),'[]'::jsonb) AS estimates,
        COALESCE(jsonb_agg(jsonb_build_object('currency',final_cost_currency,'amountMinor',final_cost_minor)) FILTER(WHERE final_cost_minor IS NOT NULL),'[]'::jsonb) AS realized
      FROM latest GROUP BY mode,status
    ), earning AS (
      SELECT count(DISTINCT d.record_id)::int AS deliveries_with_earning,
        count(DISTINCT d.record_id) FILTER(WHERE e.payload->>'currency' IS NOT NULL)::int AS known,
        COALESCE(jsonb_agg(jsonb_build_object('currency',e.payload->>'currency','amountMinor',e.payload->>'amountMinor')) FILTER(WHERE e.record_id IS NOT NULL),'[]'::jsonb) AS payouts
      FROM latest l JOIN rotamoto.domain_records d ON d.company_id=$1 AND d.record_id=l.delivery_id AND d.entity_type='Delivery'
      LEFT JOIN rotamoto.domain_records e ON e.company_id=d.company_id AND e.entity_type='Earning' AND e.deleted_at IS NULL
        AND (e.payload->>'deliveryId'=d.record_id::text OR e.related_record_id=d.record_id)
      WHERE l.mode='internal'
    ) SELECT COALESCE(jsonb_agg(to_jsonb(costs)),'[]'::jsonb) AS modes,(SELECT to_jsonb(earning) FROM earning) AS earning FROM costs`, [principal.company_id]);
    const settings = await readSettings(client,principal.company_id);
    const capacity = await loadFleetCapacity(client,principal.company_id);
    const routeCoverageResult=await client.query(`SELECT count(*)::int AS evaluated,
      count(*) FILTER(WHERE snapshot->'routeAssessment'->'origin'->>'known'='true')::int AS origin_known,
      count(*) FILTER(WHERE snapshot->'routeAssessment'->>'status'='insertion_calculated')::int AS full_route_calculated,
      count(*) FILTER(WHERE jsonb_typeof(snapshot->'routeAssessment'->'candidates')='array'
        AND jsonb_array_length(snapshot->'routeAssessment'->'candidates')>0
        AND snapshot->'routeAssessment'->>'status'<>'insertion_calculated')::int AS route_abstentions,
      count(*) FILTER(WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(snapshot->'alternatives','[]'::jsonb)) a
        WHERE a->>'id'=snapshot->'recommendation'->>'selectedAlternativeId' AND a->>'mode'='internal'
          AND a->'decisionCost'->>'basis'='marginal_route_insertion'))::int AS marginal_cost_recommendations
      FROM rotamoto.logistics_decisions WHERE company_id=$1`,[principal.company_id]);
    const routeCoverage=routeCoverageResult.rows[0]||{};
    const abstentionReasons=await client.query(`SELECT coalesce(candidate.value->>'reason',snapshot->'routeAssessment'->>'reason','UNKNOWN') AS reason,
      count(*)::int AS count FROM rotamoto.logistics_decisions decision
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(decision.snapshot->'routeAssessment'->'candidates')='array'
        THEN decision.snapshot->'routeAssessment'->'candidates' ELSE '[]'::jsonb END) candidate(value)
      WHERE decision.company_id=$1 AND decision.snapshot->'routeAssessment'->>'status'<>'insertion_calculated'
      GROUP BY 1 ORDER BY count(*) DESC,reason LIMIT 5`,[principal.company_id]);
    const modes = result.rows[0]?.modes || [];
    const internalRows = modes.filter(item=>item.mode==='internal'), externalRows=modes.filter(item=>item.mode==='external');
    const summarize = rows => {
      const combine = (field) => {
        const sums=new Map(); for (const row of rows) for (const item of row[field]||[]) if (item.currency && item.amountMinor!==null) {
          const prior=sums.get(item.currency)||{amount:0n,count:0}; sums.set(item.currency,{amount:prior.amount+BigInt(item.amountMinor),count:prior.count+1});
        }
        return [...sums.entries()].map(([currency,value])=>({currency,amountMinor:value.amount.toString(),count:value.count,
          averageAmountMinor:((value.amount+BigInt(Math.floor(value.count/2)))/BigInt(value.count)).toString()})).sort((a,b)=>a.currency.localeCompare(b.currency));
      };
      const total=rows.reduce((n,row)=>n+row.allocations,0),completed=rows.reduce((n,row)=>n+row.completed_count,0),estimated=rows.reduce((n,row)=>n+row.estimated_count,0),realized=rows.reduce((n,row)=>n+row.realized_count,0);
      return { allocations:total,completed,estimatedCount:estimated,realizedCount:realized,
        estimatedCoverage:total?estimated/total:null,realizedCoverage:completed?realized/completed:null,
        estimatedByCurrency:combine('estimates'),realizedByCurrency:combine('realized'),
        limitations:['amounts are grouped by currency; currencies are never summed together','realized means a final cost explicitly reconciled on fulfillment','estimated fulfillment amount may be a provider quote or operator estimate'] };
    };
    const earning=result.rows[0]?.earning||{};
    const payouts=new Map(); for (const item of earning.payouts||[]) if(item.currency&&/^\d+$/u.test(String(item.amountMinor||''))) payouts.set(item.currency,(payouts.get(item.currency)||0n)+BigInt(item.amountMinor));
    const ownFleet=summarize(internalRows);
    return { settings, ownFleet, external:summarize(externalRows), capacity,
      routeCoverage:{evaluated:Number(routeCoverage.evaluated||0),originKnown:Number(routeCoverage.origin_known||0),
        fullRouteCalculated:Number(routeCoverage.full_route_calculated||0),routeAbstentions:Number(routeCoverage.route_abstentions||0),
        marginalCostRecommendations:Number(routeCoverage.marginal_cost_recommendations||0),
        abstentionReasons:abstentionReasons.rows.map(row=>({reason:row.reason,count:Number(row.count)})),
        coverage:Number(routeCoverage.evaluated||0)?Number(routeCoverage.full_route_calculated||0)/Number(routeCoverage.evaluated):null,
        note:'Cobertura baseada nos snapshots imutáveis de avaliação; origem e rota integral são conhecidas somente quando registradas no instante da decisão.'},
      driverPayout:{ deliveriesWithEarning:Number(earning.known||0),totalEligibleDeliveries:ownFleet.completed,
        coverage:ownFleet.completed?Number(earning.known||0)/ownFleet.completed:null,
        byCurrency:[...payouts.entries()].map(([currency,amount])=>({currency,amountMinor:amount.toString()})),
        note:'Earning representa repasse canônico calculado; não confirma pagamento nem representa custo total da operação.' },
      comparisonNote:'Diferença entre estimativas não é economia gerada pelo RotaMoto: não existe baseline contrafactual de decisões alternativas.' };
  }
  return Object.freeze({ getIntelligenceSettings:getSettings, updateIntelligenceSettings:updateSettings,
    getRouteSettings:readRouteSettings,updateRouteSettings,
    compareLogisticsAlternatives:compareDelivery, logisticsEconomicAnalytics:economicAnalytics });
}

module.exports = { POLICIES, normalizePolicy, normalizeSettings, estimateInternalCost, makeRecommendation,
  summarizeFleetCapacity, assessRouteCompatibility, createLogisticsIntelligenceService };
