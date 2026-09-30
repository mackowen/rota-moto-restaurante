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
  const REST_TO_CANONICAL = Object.freeze({
    AGUARDANDO:'CREATED', ATRIBUIDA:'ASSIGNED', EM_ROTA:'OUT_FOR_DELIVERY', CHEGOU:'ARRIVED',
    FINALIZADA:'DELIVERED', CANCELADA:'CANCELLED'
  });
  const BOY_TO_CANONICAL = Object.freeze({
    open:'ASSIGNED', route:'OUT_FOR_DELIVERY', arrived:'ARRIVED', done:'DELIVERED',
    cancelled:'CANCELLED', issue:'FAILED'
  });
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
    const coords=Array.isArray(order.coords)?order.coords:null;
    const lat=order.latitude??order.lat??coords?.[0]??current.lat;
    const lng=order.longitude??order.lng??coords?.[1]??current.lng;
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
  globalThis.RotaMotoContract = Object.freeze({APP,PROTOCOL_VERSION,SCHEMA_VERSION,STATUS,TRANSITIONS,canTransition,assertTransition,timestampMs,compareRevision,isNewer,revise,tombstone,envelope,deliveryFromOrder,deliveryFromRace,raceFromDelivery,event,packet,normalizeDeliveryStatus,now,id});
})();
