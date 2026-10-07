/* RotaMoto shared domain contract v1.0 */
(() => {
  'use strict';
  const PROTOCOL_VERSION = 1;
  const SCHEMA_VERSION = 1;
  const APP = 'RotaMotoContract';
  const now = () => new Date().toISOString();
  const id = (prefix='id') => globalThis.crypto?.randomUUID?.() ? `${prefix}_${globalThis.crypto.randomUUID()}` : `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
  const STATUS = Object.freeze({
    CREATED:'CREATED', ASSIGNED:'ASSIGNED', ACCEPTED:'ACCEPTED', PICKED_UP:'PICKED_UP',
    OUT_FOR_DELIVERY:'OUT_FOR_DELIVERY', ARRIVED:'ARRIVED', DELIVERED:'DELIVERED',
    CANCELLED:'CANCELLED', FAILED:'FAILED', RETURNED:'RETURNED', REDELIVERY:'REDELIVERY'
  });
  const TRANSITIONS = Object.freeze({
    CREATED:['ASSIGNED','OUT_FOR_DELIVERY','CANCELLED'],
    ASSIGNED:['ACCEPTED','OUT_FOR_DELIVERY','CANCELLED'],
    ACCEPTED:['PICKED_UP','CANCELLED','FAILED'],
    PICKED_UP:['OUT_FOR_DELIVERY','FAILED'],
    OUT_FOR_DELIVERY:['ARRIVED','DELIVERED','CANCELLED','FAILED','RETURNED'],
    ARRIVED:['DELIVERED','CANCELLED','FAILED','RETURNED'],
    DELIVERED:['REDELIVERY'],
    CANCELLED:[], FAILED:['REDELIVERY'], RETURNED:['REDELIVERY'], REDELIVERY:['ASSIGNED','CANCELLED']
  });
  // Additive v1 execution facts. The server derives Delivery status from these
  // immutable event types; administrative cancellation/re-delivery stay owned
  // by the Restaurante and are never emitted by the Motoboy.
  const EXECUTION_EVENT_STATUS = Object.freeze({
    DELIVERY_ACCEPTED:'ACCEPTED', DELIVERY_PICKED_UP:'PICKED_UP',
    DELIVERY_STARTED:'OUT_FOR_DELIVERY', DELIVERY_ARRIVED:'ARRIVED',
    DELIVERY_COMPLETED:'DELIVERED', DELIVERY_FAILED:'FAILED', DELIVERY_RETURNED:'RETURNED'
  });
  const REST_TO_CANONICAL = Object.freeze({
    AGUARDANDO:'CREATED', ATRIBUIDA:'ASSIGNED', EM_ROTA:'OUT_FOR_DELIVERY', CHEGOU:'ARRIVED',
    FINALIZADA:'DELIVERED', CANCELADA:'CANCELLED'
  });
  const BOY_TO_CANONICAL = Object.freeze({
    open:'ASSIGNED', route:'OUT_FOR_DELIVERY', arrived:'ARRIVED', done:'DELIVERED',
    cancelled:'CANCELLED', issue:'FAILED'
  });
  const WRITE_AUTHORITY = Object.freeze({Company:'server',Order:'restaurante',Earning:'restaurante',Route:'restaurante',Driver:'restaurante',Delivery:'shared',DeliveryEvent:'shared',LocationPoint:'motoboy',DeliveryProof:'motoboy'});
  // Canonical fields are deliberately explicit. Legacy/local-only fields stay
  // outside these shapes and may be carried under namespaced extensions.
  const ENTITY_SCHEMAS = Object.freeze({
    Company:Object.freeze({required:['id','name','createdAt','updatedAt'],fields:Object.freeze({id:'id',name:'text',status:'text',timeZone:'nullable-iana-time-zone',createdAt:'timestamp',updatedAt:'timestamp'})}),
    Order:Object.freeze({required:['id','companyId','createdAt','updatedAt','version'],fields:Object.freeze({id:'id',companyId:'id',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',baseVersion:'revision',deletedAt:'nullable-timestamp',number:'text',customer:'object-or-text',phone:'text',address:'text',notes:'text',items:'array',payments:'array',amountMinor:'money-minor',currency:'currency',money:'order-money',source:'text',externalId:'text',extensions:'extensions'})}),
    Driver:Object.freeze({required:['id','companyId','createdAt','updatedAt','version'],fields:Object.freeze({id:'id',companyId:'id',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',baseVersion:'revision',deletedAt:'nullable-timestamp',name:'text',phone:'text',email:'text',status:'text',capacity:'delivery-capacity',extensions:'extensions'})}),
    Route:Object.freeze({required:['id','companyId','createdAt','updatedAt','version','deliveryIds'],fields:Object.freeze({id:'id',companyId:'id',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',baseVersion:'revision',deletedAt:'nullable-timestamp',deliveryIds:'id-array',stops:'array',origin:'object',status:'text',extensions:'extensions'})}),
    Delivery:Object.freeze({required:['id','companyId','status','createdAt','updatedAt','version'],fields:Object.freeze({id:'id',companyId:'id',orderId:'id',driverId:'id',status:'delivery-status',priority:'text',assignedAt:'nullable-timestamp',acceptedAt:'nullable-timestamp',pickedUpAt:'nullable-timestamp',arrivedAt:'nullable-timestamp',completedAt:'nullable-timestamp',estimatedDistanceM:'nullable-number',actualDistanceM:'nullable-number',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',baseVersion:'revision',deletedAt:'nullable-timestamp',extensions:'extensions'})}),
    DeliveryEvent:Object.freeze({required:['eventId','entity','entityId','type','occurredAt','protocolVersion'],fields:Object.freeze({eventId:'id',entity:'text',entityId:'id',type:'text',occurredAt:'timestamp',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',companyId:'id',actor:'object',payload:'object',protocolVersion:'positive-integer',extensions:'extensions'})}),
    LocationPoint:Object.freeze({required:['id','deliveryId','latitude','longitude','recordedAt'],fields:Object.freeze({id:'id',deliveryId:'id',latitude:'latitude',longitude:'longitude',accuracyM:'nullable-number',recordedAt:'timestamp',eventId:'id',companyId:'id',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',extensions:'extensions'})}),
    DeliveryProof:Object.freeze({required:['id','deliveryId','createdAt','media'],fields:Object.freeze({id:'id',deliveryId:'id',companyId:'id',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',kind:'text',media:'media-ref',note:'text',extensions:'extensions'})}),
    Earning:Object.freeze({required:['id','companyId','amountMinor','currency','createdAt','updatedAt','version'],fields:Object.freeze({id:'id',companyId:'id',deliveryId:'id',driverId:'id',amountMinor:'money-minor',currency:'currency',components:'money-components',rule:'object',ruleVersion:'text',createdAt:'timestamp',updatedAt:'timestamp',version:'revision',baseVersion:'revision',extensions:'extensions'})})
  });
  const SYNC_ACK = Object.freeze({ACCEPTED:'accepted',DUPLICATE:'duplicate',REJECTED:'rejected',CONFLICT:'conflict'});
  function timestampMs(value){
    if(typeof value==='number'&&Number.isFinite(value))return value;
    if(typeof value==='string'&&value.trim()&&Number.isFinite(Number(value)))return Number(value);
    const parsed=Date.parse(value||'');return Number.isFinite(parsed)?parsed:0;
  }
  function compareRevision(a={},b={}){
    const at=timestampMs(a.updatedAt), bt=timestampMs(b.updatedAt);
    if(at!==bt) return at>bt?1:-1;
    const av=Number(a.version||a.sync?.version||0), bv=Number(b.version||b.sync?.version||0);
    if(av!==bv) return av>bv?1:-1;
    return 0;
  }
  function revise(record={},at=Date.now()){
    const previous=timestampMs(record.updatedAt), next=Math.max(timestampMs(at),previous+1);
    const version=Math.max(Number(record.version||0),Number(record.sync?.version||0))+1;
    return {...record,updatedAt:new Date(next).toISOString(),version,sync:{...(record.sync||{}),version}};
  }
  function tombstone(record={},store,at=Date.now()){
    const revised=revise(record,at);return {id:record.deliveryId||record.id,store,companyId:record.companyId||'company_local',deleted:true,deletedAt:revised.updatedAt,updatedAt:revised.updatedAt,version:revised.version};
  }
  function isNewer(candidate,current){ return !current || compareRevision(candidate,current)>0; }
  function canTransition(from,to){ if(!from || from===to) return true; return !!TRANSITIONS[from]?.includes(to); }
  function assertTransition(from,to){ if(!canTransition(from,to)) throw new Error(`Transição de entrega inválida: ${from || 'NONE'} → ${to}.`); return true; }
  function envelope(entity,data,meta={}){
    return { id:data?.id || id(entity.slice(0,3)), entity, schemaVersion:SCHEMA_VERSION,
      companyId:data?.companyId || meta.companyId || 'company_local', version:Number(data?.version || data?.sync?.version || 1),
      createdAt:data?.createdAt || meta.createdAt || now(), updatedAt:data?.updatedAt || meta.updatedAt || now(),
      deletedAt:data?.deletedAt || null, data:{...data} };
  }
  function deliveryFromOrder(order, companyId){
    const canonical = REST_TO_CANONICAL[order?.status] || order?.canonicalStatus || 'CREATED';
    return {
      id:order.deliveryId || id('del'), companyId:order.companyId || companyId || 'company_local', orderId:order.id,
      driverId:order.bikeId || order.driverId || null, status:canonical, priority:order.urgent?'HIGH':'NORMAL',
      assignedAt:order.assignedAt || null, acceptedAt:order.acceptedAt || null, pickedUpAt:order.pickedUpAt || null,
      arrivedAt:order.arrivedAt || null, completedAt:order.completedAt || null,
      estimatedDistanceM:Number.isFinite(Number(order.km)) ? Number(order.km)*1000 : null,
      actualDistanceM:Number.isFinite(Number(order.gpsDistanceKm)) ? Number(order.gpsDistanceKm)*1000 : null,
      createdAt:order.createdAt || now(), updatedAt:new Date(timestampMs(order.updatedAt)||Date.now()).toISOString(),
      version:Number(order.sync?.version || order.version || 1)
    };
  }
  function deliveryFromRace(race, companyId, driverId){
    return {
      id:race.deliveryId || race.id, companyId:race.companyId || companyId || 'company_local', orderId:race.orderId || race.orderNo || null,
      driverId:race.driverId || driverId || null, status:race.canonicalStatus || BOY_TO_CANONICAL[race.status] || 'ASSIGNED', priority:race.urgent?'HIGH':'NORMAL',
      assignedAt:race.assignedAt || race.createdAt || null, acceptedAt:race.acceptedAt || null, pickedUpAt:race.pickedUpAt || race.startedAt || null,
      arrivedAt:race.arrivedAt || null, completedAt:race.completedAt || race.finishedAt || null,
      estimatedDistanceM:Number.isFinite(Number(race.distanceKm)) ? Number(race.distanceKm)*1000 : null,
      actualDistanceM:Number.isFinite(Number(race.gpsDistanceKm)) ? Number(race.gpsDistanceKm)*1000 : null,
      createdAt:race.createdAt || now(), updatedAt:new Date(timestampMs(race.updatedAt)||Date.now()).toISOString(), version:Number(race.sync?.version || race.version || 1)
    };
  }
  function raceFromDelivery(delivery={},order={},current={}){
    const status=delivery.status||'ASSIGNED';
    const localStatus={CREATED:'open',ASSIGNED:'open',ACCEPTED:'open',PICKED_UP:'route',OUT_FOR_DELIVERY:'route',ARRIVED:'arrived',DELIVERED:'done',CANCELLED:'cancelled',FAILED:'issue',RETURNED:'issue',REDELIVERY:'open'}[status]||'open';
    const coords=Array.isArray(order.coords)?order.coords:null,shared=order.extensions?.x_rotamoto_navigation_coordinates;
    const sharedValid=shared&&shared.provenance==='restaurant_order_coordinates'&&Number.isFinite(Number(shared.latitude))&&Math.abs(Number(shared.latitude))<=90&&Number.isFinite(Number(shared.longitude))&&Math.abs(Number(shared.longitude))<=180;
    const lat=order.latitude??order.lat??coords?.[0]??(sharedValid?shared.latitude:undefined)??current.lat;
    const lng=order.longitude??order.lng??coords?.[1]??(sharedValid?shared.longitude:undefined)??current.lng;
    return {...current,id:current.id||delivery.id,deliveryId:delivery.id,companyId:delivery.companyId||order.companyId||current.companyId,
      orderId:delivery.orderId||order.id||current.orderId||null,driverId:delivery.driverId||current.driverId||null,
      status:localStatus,canonicalStatus:status,version:Number(delivery.version||delivery.sync?.version||1),updatedAt:new Date(timestampMs(delivery.updatedAt)||Date.now()).toISOString(),createdAt:current.createdAt||delivery.createdAt||now(),
      client:order.customer?.name||order.customer||current.client||'',phone:order.phone||order.customer?.phone||current.phone||'',address:order.address||current.address||'',
      lat:Number.isFinite(Number(lat))?Number(lat):null,lng:Number.isFinite(Number(lng))?Number(lng):null,
      orderNo:order.num||order.orderNo||current.orderNo||'',value:order.value??order.deliveryFee??current.value??0,
      deliveryFee:order.deliveryFee??order.value??current.deliveryFee??null,urgent:order.urgent??(delivery.priority==='HIGH'),
      notes:order.obs||order.notes||current.notes||'',items:order.items||current.items||[],deleted:!!delivery.deleted};
  }
  function event(type, entity, entityId, payload={}, actor={type:'system',id:null}){
    return { eventId:id('evt'), type, entity, entityId, occurredAt:now(), actor, payload, protocolVersion:PROTOCOL_VERSION };
  }
  function packet({companyId,deviceId,app,events=[],orders=[],deliveries=[],drivers=[],routes=[],locationUpdates=[],deliveryEvents=[],proofs=[],earnings=[],tombstones=[],ackFor=null}){
    return { protocol:'rotamoto-sync', protocolVersion:PROTOCOL_VERSION, schemaVersion:SCHEMA_VERSION, packetId:id('pkt'), companyId:companyId || 'company_local', deviceId:deviceId || id('dev'), source:{app:app || 'RotaMoto',deviceId:deviceId || null}, createdAt:now(), ackFor, events, data:{orders,deliveries,drivers,routes,locationUpdates,deliveryEvents,proofs,earnings,tombstones} };
  }
  function normalizeDeliveryStatus(value,source='restaurante'){
    return source==='motoboy' ? (BOY_TO_CANONICAL[value] || value) : (REST_TO_CANONICAL[value] || value);
  }
  const DOMAIN_TYPES={
    id:v=>typeof v==='string'&&v.trim().length>0&&v.length<=200,
    text:v=>typeof v==='string'&&v.length<=4000,
    object:v=>!!v&&typeof v==='object'&&!Array.isArray(v),
    array:Array.isArray,
    timestamp:v=>typeof v==='string'&&Number.isFinite(Date.parse(v)),
    'nullable-timestamp':v=>v===null||typeof v==='string'&&Number.isFinite(Date.parse(v)),
    revision:v=>Number.isSafeInteger(v)&&v>0,
    'positive-integer':v=>Number.isSafeInteger(v)&&v>0,
    'nullable-number':v=>v===null||Number.isFinite(v),
    'money-minor':v=>Number.isSafeInteger(v)&&Math.abs(v)<=9000000000000000,
    currency:v=>validIsoCurrency(v),
    'iana-time-zone':v=>validTimeZone(v),
    'nullable-iana-time-zone':v=>v===null||validTimeZone(v),
    'order-money':v=>validateOrderMoney(v),
    'delivery-capacity':v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===2&&v.unit==='deliveries'&&Number.isSafeInteger(v.limit)&&v.limit>=1&&v.limit<=500,
    'delivery-status':v=>Object.hasOwn(STATUS,v),
    latitude:v=>Number.isFinite(v)&&v>=-90&&v<=90,
    longitude:v=>Number.isFinite(v)&&v>=-180&&v<=180,
    'object-or-text':v=>typeof v==='string'||!!v&&typeof v==='object'&&!Array.isArray(v),
    'id-array':v=>Array.isArray(v)&&v.length<=500&&v.every(x=>DOMAIN_TYPES.id(x)),
    'money-components':v=>Array.isArray(v)&&v.length<=100&&v.every(x=>DOMAIN_TYPES.object(x)&&DOMAIN_TYPES.text(x.code)&&Number.isSafeInteger(x.amountMinor)),
    'media-ref':v=>DOMAIN_TYPES.object(v)&&DOMAIN_TYPES.text(v.mimeType)&&['image/png','image/jpeg'].includes(v.mimeType)&&Number.isSafeInteger(v.sizeBytes)&&v.sizeBytes>=0&&v.sizeBytes<=8388608&&DOMAIN_TYPES.object(v.storageRef)&&DOMAIN_TYPES.id(v.storageRef.provider)&&DOMAIN_TYPES.text(v.storageRef.objectKey)&&v.storageRef.objectKey.trim().length<=512&&/^[a-f0-9]{64}$/iu.test(v.sha256||''),
    extensions:v=>DOMAIN_TYPES.object(v)
  };
  function validTimeZone(value){try{if(typeof value!=='string'||!value.trim()||/^[+-]\d{2}:?\d{2}$/u.test(value)||/^Etc\/GMT[+-]\d{1,2}$/iu.test(value))return false;new Intl.DateTimeFormat('en',{timeZone:value}).format(0);return true}catch(_){return false}}
  function validIsoCurrency(value){if(typeof value!=='string'||!/^[A-Z]{3}$/u.test(value)||typeof Intl.supportedValuesOf!=='function')return false;try{return Intl.supportedValuesOf('currency').includes(value)}catch(_){return false}}
  function validateOrderMoney(value){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['currency','completeness','provenance','components'].includes(k)))return false;
    if(!DOMAIN_TYPES.currency(value.currency)||!['complete','partial','unknown'].includes(value.completeness))return false;
    const p=value.provenance;if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['kind','sourceId'].includes(k))||!['manual','external','import'].includes(p.kind)||(p.sourceId!==undefined&&(typeof p.sourceId!=='string'||!/^[a-z0-9][a-z0-9_.:-]{0,79}$/iu.test(p.sourceId))))return false;
    const c=value.components;if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['itemsSubtotalMinor','discountMinor','deliveryFeeMinor','serviceFeeMinor','otherFeeMinor','totalMinor'].includes(k))||(value.completeness==='unknown'&&Object.keys(c).length))return false;
    if(Object.values(c).some(n=>!Number.isSafeInteger(n)||n<0||n>9000000000000000))return false;
    const keys=['itemsSubtotalMinor','discountMinor','deliveryFeeMinor','serviceFeeMinor','otherFeeMinor','totalMinor'];
    if(value.completeness==='complete'&&keys.some(k=>!Object.hasOwn(c,k)))return false;
    if(keys.every(k=>Object.hasOwn(c,k))&&c.itemsSubtotalMinor-c.discountMinor+c.deliveryFeeMinor+c.serviceFeeMinor+c.otherFeeMinor!==c.totalMinor)return false;
    return true;
  }
  function validateEntity(entity,record){
    const schema=ENTITY_SCHEMAS[entity],errors=[];
    if(!schema)return{valid:false,errors:['UNKNOWN_ENTITY']};
    if(!record||typeof record!=='object'||Array.isArray(record))return{valid:false,errors:['INVALID_RECORD']};
    for(const key of schema.required)if(record[key]===undefined||record[key]===null)errors.push('REQUIRED:'+key);
    for(const [key,value]of Object.entries(record)){
      const type=schema.fields[key];
      if(!type){if(/^x_[a-z0-9]+_/iu.test(key))continue;errors.push('UNKNOWN_FIELD:'+key);continue}
      if(!DOMAIN_TYPES[type](value))errors.push('INVALID:'+key);
    }
    if(entity==='Order'){
      if(Object.hasOwn(record,'amountMinor')&&record.amountMinor!==undefined&&record.amountMinor!==null&&(!Number.isSafeInteger(record.amountMinor)||record.amountMinor<0))errors.push('INVALID:amountMinor');
      if(Object.hasOwn(record,'currency')&&record.currency!==undefined&&record.currency!==null&&!validIsoCurrency(record.currency))errors.push('INVALID:currency');
    }
    return{valid:errors.length===0,errors};
  }
  function validateRouteMembership(routes){
    const assigned=new Map(),errors=[];
    for(const route of routes||[])for(const deliveryId of route.deliveryIds||[]){
      if(assigned.has(deliveryId))errors.push('DELIVERY_IN_MULTIPLE_ACTIVE_ROUTES:'+deliveryId);
      else assigned.set(deliveryId,route.id);
    }
    return{valid:errors.length===0,errors};
  }
  globalThis.RotaMotoContract = Object.freeze({APP,PROTOCOL_VERSION,SCHEMA_VERSION,STATUS,TRANSITIONS,EXECUTION_EVENT_STATUS,WRITE_AUTHORITY,SYNC_ACK,ENTITY_SCHEMAS,validateEntity,validateRouteMembership,canTransition,assertTransition,timestampMs,compareRevision,isNewer,revise,tombstone,envelope,deliveryFromOrder,deliveryFromRace,raceFromDelivery,event,packet,normalizeDeliveryStatus,now,id});
})();
