'use strict';

const crypto = require('node:crypto');
const { uuidV7 } = require('../identity/service');
const { createMediaStorage } = require('./media-storage');
const OrderMoney = require('../../order-money');
const { projectRestaurantDriverAssignment, projectInternalExecution } = require('../logistics/sync-projection');

const WRITE_OWNERS = Object.freeze({ Order: 'restaurante', Route: 'restaurante', Driver: 'restaurante', Earning: 'restaurante',
  LocationPoint: 'motoboy', DeliveryProof: 'motoboy' });
const ENTITY_ARRAYS = Object.freeze([
  ['orders', 'Order'], ['drivers', 'Driver'], ['deliveries', 'Delivery'], ['routes', 'Route'],
  ['deliveryEvents', 'DeliveryEvent'], ['locationUpdates', 'LocationPoint'], ['proofs', 'DeliveryProof'], ['earnings', 'Earning']
]);
const TOMBSTONE_TYPES = Object.freeze({ orders: 'Order', deliveries: 'Delivery', routes: 'Route', drivers: 'Driver',
  deliveryEvents: 'DeliveryEvent', locations: 'LocationPoint', locationUpdates: 'LocationPoint', proofs: 'DeliveryProof', earnings: 'Earning' });
const TRANSITIONS = Object.freeze({
  CREATED: ['ASSIGNED', 'OUT_FOR_DELIVERY', 'CANCELLED'], ASSIGNED: ['ACCEPTED', 'OUT_FOR_DELIVERY', 'CANCELLED'],
  ACCEPTED: ['PICKED_UP', 'CANCELLED', 'FAILED'], PICKED_UP: ['OUT_FOR_DELIVERY', 'FAILED'],
  OUT_FOR_DELIVERY: ['ARRIVED', 'DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED'],
  ARRIVED: ['DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED'], DELIVERED: ['REDELIVERY'],
  CANCELLED: [], FAILED: ['REDELIVERY'], RETURNED: ['REDELIVERY'], REDELIVERY: ['ASSIGNED', 'CANCELLED']
});
const DELIVERY_RESTAURANT_FIELDS = new Set(['driverId','priority','assignedAt','estimatedDistanceM','status']);
const DELIVERY_MOTOBOY_FIELDS = new Set(['status','acceptedAt','pickedUpAt','arrivedAt','completedAt','actualDistanceM']);
const DELIVERY_META_FIELDS = new Set(['id','companyId','orderId','createdAt','updatedAt','version','baseVersion','sync','deleted','deletedAt']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function operationAuthorityError(appKey, entityType, record) {
  if (entityType === 'Company') return new SyncError('FORBIDDEN', 'Company é provisionada pelo serviço de identidade.');
  if (entityType === 'Delivery' && appKey === 'motoboy') {
    return new SyncError('FORBIDDEN', 'O Motoboy registra fatos de execução por DeliveryEvent; Delivery é projetada pelo servidor.');
  }
  const owner = WRITE_OWNERS[entityType];
  if (owner && owner !== appKey) return new SyncError('FORBIDDEN', `${entityType} não pode ser alterada por este aplicativo.`);
  if (entityType === 'DeliveryEvent') {
    const target = String(record?.entity || '').toLowerCase();
    if (!['order','delivery'].includes(target)) return new SyncError('FORBIDDEN_EVENT', 'DeliveryEvent deve referenciar Order ou Delivery.');
    if ((target === 'order' && appKey !== 'restaurante') || (target === 'delivery' && appKey !== 'motoboy')) {
      return new SyncError('FORBIDDEN', 'O aplicativo não é proprietário deste tipo de evento.');
    }
  }
  return null;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function packetDigest(packet) {
  return crypto.createHash('sha256').update(stableJson(packet)).digest();
}

class SyncError extends Error {
  constructor(code, message) { super(message); this.name = 'SyncError'; this.code = code; }
}

function invalid(message) { throw new SyncError('INVALID_INPUT', message); }
function validateOrderMoneyRecord(record) {
  if (Object.hasOwn(record || {}, 'amountMinor') && (!Number.isSafeInteger(record.amountMinor) || record.amountMinor < 0 || record.amountMinor > 9000000000000000)) invalid('Order.amountMinor legado inválido.');
  if (Object.hasOwn(record || {}, 'currency') && OrderMoney.currencyScale(record.currency) === null) invalid('Order.currency legada inválida.');
  if (!Object.hasOwn(record || {}, 'money')) return true;
  const result = OrderMoney.validateMoney(record.money);
  if (!result.valid) invalid('Order.money inválido ou inconsistente.');
  if (record.money.provenance.kind === 'external') {
    const source = typeof record.source === 'string' ? record.source.toLowerCase() : '';
    if (!source || source !== String(record.money.provenance.sourceId || '').toLowerCase()) invalid('Order.money provenance não corresponde à origem comercial.');
  }
  return true;
}
function boundedText(value, name, max = 255) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > max || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${name} inválido.`);
  return value.trim();
}
function timestamp(value, fallback, field) {
  if (value !== undefined && value !== null && !['string', 'number'].includes(typeof value)) invalid(`${field} inválido.`);
  const date = value === undefined || value === null ? new Date(fallback) : new Date(value);
  if (!Number.isFinite(date.getTime())) invalid(`${field} inválido.`);
  return date;
}
function packetUuid(value) {
  if (typeof value !== 'string' || !/^pkt_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.test(value)) invalid('packetId incompatível com o contrato rotamoto-sync v1.');
  return value.slice(4).toLowerCase();
}
function validatePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.protocol !== 'rotamoto-sync' ||
      packet.protocolVersion !== 1 || packet.schemaVersion !== 1) invalid('Envelope de sincronização inválido ou incompatível.');
  const id = packetUuid(packet.packetId);
  const deviceId = boundedText(packet.deviceId, 'deviceId', 128);
  if (packet.source?.deviceId && packet.source.deviceId !== deviceId) invalid('deviceId divergente no envelope.');
  const data = packet.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('data do pacote inválido.');
  // Current clients include local projections alongside the contract collections.
  // They are bounded and accepted for v1 compatibility, but are never canonical writes.
  const allowed = new Set([...ENTITY_ARRAYS.map(([key]) => key), 'tombstones', 'settings', 'races']);
  if (Object.keys(data).some(key => !allowed.has(key))) invalid('O pacote contém coleções não previstas no contrato v1.');
  if (data.races !== undefined && !Array.isArray(data.races)) invalid('data.races deve ser uma lista.');
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) invalid('data.settings deve ser um objeto.');
  const sensitiveKeys = new Set(['password', 'passwordhash', 'token', 'secret', 'secretref', 'authorization',
    'accesstoken', 'refreshtoken', 'apikey', 'privatekey', 'credential', 'credentials']);
  function inspect(value, depth = 0) {
    if (depth > 32) invalid('A estrutura do pacote é profunda demais.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/gu, '');
      if (sensitiveKeys.has(normalizedKey) || /(?:password|secret|token|credential|authorization|apikey|privatekey)/u.test(normalizedKey)) {
        invalid('O pacote contém campos de credencial não sincronizáveis.');
      }
      inspect(child, depth + 1);
    }
  }
  inspect(packet);
  let total = 0;
  for (const [key] of ENTITY_ARRAYS) {
    if (data[key] !== undefined && !Array.isArray(data[key])) invalid(`data.${key} deve ser uma lista.`);
    total += data[key]?.length || 0;
  }
  if (packet.events !== undefined && !Array.isArray(packet.events)) invalid('events deve ser uma lista.');
  if (data.tombstones !== undefined && !Array.isArray(data.tombstones)) invalid('tombstones deve ser uma lista.');
  total += packet.events?.length || 0;
  total += data.tombstones?.length || 0;
  total += data.races?.length || 0;
  total += data.settings ? 1 : 0;
  if (total > 500) invalid('O pacote excede 500 operações.');
  return { packetId: id, deviceId, data, events: packet.events || [] };
}

function createSyncService({ clock = () => new Date(), mediaStorage = createMediaStorage() } = {}) {
  async function assignDeliveryToRoute(client, principal, input) {
    const { routeId, deliveryId, driverId, position, expectedRouteVersion } = input || {};
    if (![routeId,deliveryId,driverId].every(value=>typeof value==='string'&&UUID.test(value))||
        !Number.isSafeInteger(position)||position<0||!Number.isSafeInteger(expectedRouteVersion)||expectedRouteVersion<1)
      throw new SyncError('INVALID_INPUT','Route assignment input is invalid.');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 402119))',[principal.company_id+':active-route-membership']);
    const routeResult=await client.query(`SELECT payload,version,updated_at FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Route' AND deleted_at IS NULL FOR UPDATE`,[principal.company_id,routeId]);
    if(!routeResult.rowCount)throw new SyncError('UNRESOLVED_REFERENCE','Route não encontrada neste tenant.');
    const routeRow=routeResult.rows[0],route=routeRow.payload;
    if(Number(routeRow.version)!==expectedRouteVersion)throw new SyncError('REVISION_CONFLICT','Route mudou desde a avaliação; recalcule a decisão.');
    if(!['PLANNED','ACTIVE','IN_PROGRESS'].includes(String(route.status||'').toUpperCase())||!Array.isArray(route.deliveryIds)||
        !route.deliveryIds.every(value=>typeof value==='string'&&UUID.test(value))||new Set(route.deliveryIds).size!==route.deliveryIds.length||position>route.deliveryIds.length)
      throw new SyncError('INVALID_ROUTE','Route não possui plano ativo, completo e ordenado.');
    if(route.deliveryIds.includes(deliveryId))return {duplicate:true,routeId,deliveryId,position:route.deliveryIds.indexOf(deliveryId),version:Number(routeRow.version)};
    const deliveryResult=await client.query(`SELECT payload,version FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL FOR UPDATE`,[principal.company_id,deliveryId]);
    if(!deliveryResult.rowCount||deliveryResult.rows[0].payload.driverId!==driverId)
      throw new SyncError('INVALID_DRIVER','Delivery deve estar alocada ao Driver escolhido para a Route.');
    const driverResult=await client.query(`SELECT payload->>'status' AS status,payload->'capacity' AS capacity
      FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Driver' AND deleted_at IS NULL FOR UPDATE`,
    [principal.company_id,driverId]);
    const driverStatus=String(driverResult.rows[0]?.status||'').normalize('NFD').replace(/[\u0300-\u036f]/gu,'').trim().toUpperCase();
    if(!driverResult.rowCount||!['ACTIVE','AVAILABLE','DISPONIVEL','EM ROTA','CHEGOU','IN ROUTE','ARRIVED'].includes(driverStatus))
      throw new SyncError('INVALID_DRIVER','Driver não está operacionalmente ativo.');
    const capacity=driverResult.rows[0].capacity;
    if(capacity?.unit!=='deliveries'||!Number.isSafeInteger(capacity.limit)||capacity.limit<1||capacity.limit>500)
      throw new SyncError('CAPACITY_UNKNOWN','Capacidade configurada do Driver não é conhecida.');
    const load=await client.query(`SELECT count(*) FILTER(WHERE upper(coalesce(payload->>'status','')) IN
        ('CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','REDELIVERY'))::int AS active_load,
      count(*) FILTER(WHERE upper(coalesce(payload->>'status','')) NOT IN
        ('CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','REDELIVERY','DELIVERED','CANCELLED','FAILED','RETURNED'))::int AS unknown_load
      FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Delivery' AND deleted_at IS NULL
        AND payload->>'driverId'=$2`,[principal.company_id,driverId]);
    if(load.rows[0].unknown_load!==0||load.rows[0].active_load>capacity.limit)
      throw new SyncError('CAPACITY_UNKNOWN','Carga atual do Driver é desconhecida ou excede a capacidade configurada.');
    const membership=await client.query(`SELECT r.record_id::text FROM rotamoto.domain_records r
      WHERE r.company_id=$1 AND r.entity_type='Route' AND r.record_id<>$2 AND r.deleted_at IS NULL
        AND upper(coalesce(r.payload->>'status',''))=ANY($3::text[]) AND jsonb_typeof(r.payload->'deliveryIds')='array'
        AND r.payload->'deliveryIds' ? $4 LIMIT 1`,[principal.company_id,routeId,['PLANNED','ACTIVE','IN_PROGRESS'],deliveryId]);
    if(membership.rowCount)throw new SyncError('ROUTE_DELIVERY_ALREADY_ACTIVE','Delivery já pertence a outra Route ativa.');
    const stopRows=route.deliveryIds.length?await client.query(`SELECT count(*)::int AS total,
      count(*) FILTER(WHERE payload->>'driverId'=$3 AND entity_type='Delivery' AND deleted_at IS NULL)::int AS same_driver
      FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=ANY($2::uuid[])`,[principal.company_id,route.deliveryIds,driverId]):{rows:[{total:0,same_driver:0}]};
    if(stopRows.rows[0].total!==route.deliveryIds.length||stopRows.rows[0].same_driver!==route.deliveryIds.length)
      throw new SyncError('INVALID_ROUTE','As paradas atuais não formam uma Route completa para este Driver.');
    const now=clock(),nextVersion=Number(routeRow.version)+1,deliveryIds=[...route.deliveryIds];
    deliveryIds.splice(position,0,deliveryId);
    const nextRoute={...route,deliveryIds,version:nextVersion,updatedAt:now.toISOString()};
    const routeUpdated=await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5
      WHERE company_id=$1 AND record_id=$2 AND version=$6 RETURNING record_id`,[principal.company_id,routeId,JSON.stringify(nextRoute),nextVersion,now,routeRow.version]);
    if(!routeUpdated.rowCount)throw new SyncError('REVISION_CONFLICT','Route mudou durante a inserção.');
    const installation=await client.query(`SELECT id FROM rotamoto.sync_installations WHERE company_id=$1 AND app_key='restaurante'
      ORDER BY last_seen_at DESC LIMIT 1`,[principal.company_id]);
    if(!installation.rowCount)throw new SyncError('INSTALLATION_REQUIRED','Sincronize o painel Restaurante antes de alterar a Route.');
    const eventId=uuidV7(now.getTime()),event={eventId,type:'CANONICAL_RECORD_UPSERTED',entity:'Route',entityId:routeId,
      occurredAt:now.toISOString(),actor:{type:'user',id:principal.user_id},payload:{...nextRoute,id:routeId,companyId:principal.company_id},protocolVersion:1};
    await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,payload)
      VALUES($1,$2,'restaurante',$3,$4::jsonb)`,[principal.company_id,eventId,installation.rows[0].id,JSON.stringify(event)]);
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user','route.delivery-membership.changed','Route',$4,$5::jsonb)`,
    [uuidV7(now.getTime()),principal.company_id,principal.user_id,routeId,JSON.stringify({added:[deliveryId],removed:[],position,version:nextVersion,source:'approved_logistics_decision'})]);
    return {duplicate:false,routeId,deliveryId,position,version:nextVersion};
  }
  async function registerInstallation(client, principal, appKey, deviceId) {
    if (!['restaurante', 'motoboy'].includes(appKey)) invalid('Aplicativo de instalação inválido.');
    requireDriverInstallation({ app_key: appKey }, principal);
    const localDeviceId = boundedText(deviceId, 'deviceId', 128);
    const result = await client.query(`INSERT INTO rotamoto.sync_installations
      (id,company_id,app_key,local_device_id,registered_by_user_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(company_id,app_key,local_device_id) DO UPDATE
        SET last_seen_at=greatest(rotamoto.sync_installations.last_seen_at,now())
        WHERE rotamoto.sync_installations.registered_by_user_id=$5
      RETURNING id::text,app_key,local_device_id`,
    [uuidV7(clock().getTime()), principal.company_id, appKey, localDeviceId, principal.user_id]);
    if (!result.rowCount) throw new SyncError('INSTALLATION_FORBIDDEN', 'A instalação já está vinculada a outra identidade.');
    return { installationId: result.rows[0].id, appKey: result.rows[0].app_key, deviceId: result.rows[0].local_device_id };
  }

  async function findInstallation(client, principal, deviceId, appKey = null) {
    const result = await client.query(`SELECT id::text,app_key FROM rotamoto.sync_installations
      WHERE company_id=$1 AND registered_by_user_id=$2 AND local_device_id=$3
        AND ($4::text IS NULL OR app_key=$4) FOR UPDATE`,
    [principal.company_id, principal.user_id, boundedText(deviceId, 'deviceId', 128), appKey]);
    if (!result.rowCount) throw new SyncError('INSTALLATION_REQUIRED', 'Registre este dispositivo na sessão antes de sincronizar.');
    if (result.rowCount > 1) throw new SyncError('INSTALLATION_AMBIGUOUS', 'deviceId está vinculado a mais de um aplicativo.');
    await client.query('UPDATE rotamoto.sync_installations SET last_seen_at=greatest(last_seen_at,now()) WHERE company_id=$1 AND id=$2', [principal.company_id, result.rows[0].id]);
    return result.rows[0];
  }

  function requireDriverInstallation(installation, principal) {
    if (installation.app_key === 'motoboy' && !principal?.driver_id) {
      throw new SyncError('DRIVER_LINK_REQUIRED', 'A associação desta conta a um motorista precisa ser configurada pela empresa.');
    }
  }

  async function assertAssignedDriver(client, principal, appKey, deliveryId) {
    if (appKey !== 'motoboy') return;
    if (!principal?.driver_id) throw new SyncError('DRIVER_LINK_REQUIRED', 'A associação desta conta a um motorista precisa ser configurada pela empresa.');
    const delivery = await client.query(`SELECT payload->>'driverId' AS driver_id,deleted_at
      FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='Delivery' FOR UPDATE`,
    [principal.company_id, deliveryId]);
    if (!delivery.rowCount || delivery.rows[0].deleted_at || delivery.rows[0].driver_id !== principal.driver_id) {
      throw new SyncError('DRIVER_NOT_ASSIGNED', 'A entrega não está atribuída ao motorista desta sessão.');
    }
  }

  async function resolveLocal(client, companyId, appKey, installationId, entityType, localId, { create = false } = {}) {
    const local = boundedText(localId, `${entityType}.id`);
    const lockId = `${companyId}:${appKey}:${installationId}:${entityType}:${local}`;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 402116))', [lockId]);
    const prior = await client.query(`SELECT canonical_id::text FROM rotamoto.local_id_maps
      WHERE company_id=$1 AND app_key=$2 AND installation_id=$3 AND entity_type=$4 AND local_id=$5`,
    [companyId, appKey, installationId, entityType, local]);
    if (prior.rowCount) return { localId: local, canonicalId: prior.rows[0].canonical_id, created: false };
    if (entityType === 'DeliveryEvent') {
      // The shared contract defines eventId as a globally idempotent fact key,
      // independent of which device retries it.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 402118))', [`${companyId}:event:${local}`]);
      const event = await client.query(`SELECT record_id::text FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type='DeliveryEvent' AND source_event_id=$2`, [companyId, local]);
      if (event.rowCount) return { localId: local, canonicalId: event.rows[0].record_id, created: true, canonicalExists: true };
    }
    if (entityType !== 'DeliveryEvent' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(local)) {
      const canonical = await client.query(`SELECT record_id::text FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type=$2 AND record_id=$3`, [companyId, entityType, local]);
      if (canonical.rowCount) return { localId: local, canonicalId: canonical.rows[0].record_id, created: true, canonicalExists: true };
    }
    if (!create) return null;
    return { localId: local, canonicalId: uuidV7(clock().getTime()), created: true };
  }

  async function addAlias(client, companyId, appKey, installationId, entityType, localId, canonicalId) {
    await client.query(`INSERT INTO rotamoto.local_id_maps
      (id,company_id,app_key,installation_id,entity_type,local_id,canonical_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,app_key,installation_id,entity_type,local_id) DO NOTHING`,
    [uuidV7(clock().getTime()), companyId, appKey, installationId, entityType, localId, canonicalId]);
  }

  async function resolveReferencedAlias(client, companyId, entityType, localId) {
    if (typeof localId !== 'string' || !localId.trim()) return null;
    const result = await client.query(`SELECT DISTINCT canonical_id::text FROM rotamoto.local_id_maps
      WHERE company_id=$1 AND entity_type=$2 AND local_id=$3 ORDER BY canonical_id`, [companyId, entityType, localId.trim()]);
    if (result.rowCount > 1) throw new SyncError('SYNC_CONFLICT', `Referência ambígua para ${entityType}; reconciliação explícita necessária.`);
    if (result.rows[0]?.canonical_id) return result.rows[0].canonical_id;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(localId.trim())) {
      const canonical = await client.query(`SELECT record_id::text FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type=$2 AND record_id=$3`, [companyId, entityType, localId.trim()]);
      return canonical.rows[0]?.record_id || null;
    }
    return null;
  }

  function metadata(record, entityType, now) {
    const updatedAt = timestamp(record.updatedAt ?? record.occurredAt ?? record.at, now, `${entityType}.updatedAt`);
    const createdAt = timestamp(record.createdAt ?? record.occurredAt ?? record.at, updatedAt, `${entityType}.createdAt`);
    const version = record.version ?? record.sync?.version ?? 1;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) invalid(`${entityType}.version inválida.`);
    if (updatedAt < createdAt) invalid(`${entityType}.updatedAt anterior a createdAt.`);
    return { createdAt, updatedAt, version };
  }

  async function push(client, principal, packet) {
    const validated = validatePacket(packet);
    const companyId = principal?.company_id;
    const userId = principal?.user_id;
    if (typeof companyId !== 'string' || typeof userId !== 'string') throw new SyncError('UNAUTHENTICATED', 'Sessão inválida.');
    const { packetId, deviceId, data, events } = validated;
    const installation = await findInstallation(client, principal, deviceId);
    const appKey = installation.app_key;
    requireDriverInstallation(installation, principal);
    if ((data.proofs || []).length || (data.tombstones || []).some(item => TOMBSTONE_TYPES[item?.store] === 'DeliveryProof' || item?.entityType === 'DeliveryProof' || item?.type === 'DeliveryProof')) {
      // Serialize canonical proof/intent changes with the backup and media GC barrier.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['rotamoto:proof-media:snapshot:v1']);
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 402117))', [`${companyId}:${packetId}`]);
    const prior = await client.query(`SELECT payload_digest,result FROM rotamoto.sync_inbox
      WHERE company_id=$1 AND packet_id=$2`, [companyId, packetId]);
    if (prior.rowCount) {
      const digest = packetDigest(packet);
      if (!Buffer.from(prior.rows[0].payload_digest).equals(digest)) throw new SyncError('SYNC_CONFLICT', 'packetId já foi usado para outro conteúdo.');
      return { ...prior.rows[0].result, duplicate: true,
        operationResults: (prior.rows[0].result.operationResults || []).map(result =>
          result.status === 'accepted' ? { ...result, status: 'duplicate' } : result) };
    }
    const installationId = installation.id;
    const pending = [];
    const assignmentRevocations = [];
    const aliases = [];
    const operationResults = [];
    const outcomes = { received: 0, updated: 0, ignored: 0, deleted: 0 };
    const seen = new Set();
    const now = clock();

    const incoming = ENTITY_ARRAYS.flatMap(([key, type]) => (data[key] || []).map((record, index) => ({ record, entityType: type, operationIndex: `${key}:${index}` })));
    incoming.push(...events.map((record, index) => ({ record, entityType: 'DeliveryEvent', operationIndex: `events:${index}` })));
    for (const item of incoming) {
      const { record, entityType } = item;
      const localId = record && typeof record === 'object' ? (entityType === 'DeliveryEvent' ? (record.eventId || record.id) : record.id) : null;
      const authorityError = operationAuthorityError(appKey, entityType, record);
      if (authorityError) {
        operationResults.push({ operation: item.operationIndex, entity: entityType, localId: localId || null,
          status: 'rejected', error: { code: authorityError.code } });
        continue;
      }
      await client.query('SAVEPOINT sync_operation');
      const pendingBefore = pending.length;
      const revocationsBefore = assignmentRevocations.length;
      const aliasesBefore = aliases.length;
      const resultBefore = operationResults.length;
      const countsBefore = { ...outcomes };
      let seenKey = null;
      let ackCanonicalId = null;
      let ackVersion = null;
      try {
      if (!record || typeof record !== 'object' || Array.isArray(record)) invalid(`${entityType} inválido.`);
      const operationLocalId = boundedText(localId, `${entityType}.id`);
      const resolved = await resolveLocal(client, companyId, appKey, installationId, entityType, operationLocalId, { create: true });
      let canonicalId = resolved.canonicalId;
      const meta = metadata(record, entityType, now);
      let canonical = { ...record, id: canonicalId, companyId,
        ...(entityType === 'DeliveryEvent' ? { eventId: canonicalId } : {}),
        createdAt: meta.createdAt.toISOString(), updatedAt: meta.updatedAt.toISOString(), version: meta.version };
      delete canonical.baseVersion;
      delete canonical.sync;
      let routeMembershipChange = null;
      if(entityType==='Driver'&&record.capacity!==undefined){
        const capacity=record.capacity;
        if(!capacity||typeof capacity!=='object'||Array.isArray(capacity)||Object.keys(capacity).some(key=>!['unit','limit'].includes(key))||
          Object.keys(capacity).length!==2||capacity.unit!=='deliveries'||!Number.isSafeInteger(capacity.limit)||capacity.limit<1||capacity.limit>500)
          invalid('Driver.capacity deve informar um limite entre 1 e 500 entregas ativas.');
        canonical.capacity={unit:'deliveries',limit:capacity.limit};
      }
      if(entityType==='Route'&&record.deliveryIds===undefined&&resolved.created)canonical.deliveryIds=[];
      if(entityType==='Route'&&record.deliveryIds!==undefined){
        if(appKey!=='restaurante')throw new SyncError('FORBIDDEN','Somente o Restaurante planeja a associação de rotas.');
        if(!Array.isArray(record.deliveryIds)||record.deliveryIds.length>500||new Set(record.deliveryIds).size!==record.deliveryIds.length||
          record.deliveryIds.some(id=>typeof id!=='string'||!id.trim()||id.length>200))invalid('Route.deliveryIds inválido.');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 402119))',[companyId+':active-route-membership']);
        const canonicalIds=[];
        for(const localDeliveryId of record.deliveryIds){
          const deliveryId=await resolveReferencedAlias(client,companyId,'Delivery',localDeliveryId);
          if(!deliveryId)throw new SyncError('UNRESOLVED_REFERENCE','Route referencia Delivery sem ID canônico.');
          const exists=await client.query('SELECT 1 FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type=\'Delivery\' AND deleted_at IS NULL',[companyId,deliveryId]);
          if(!exists.rowCount)throw new SyncError('UNRESOLVED_REFERENCE','Route referencia Delivery ausente ou tombstonada.');
          const activeElsewhere=await client.query(`SELECT record_id::text FROM rotamoto.domain_records
            WHERE company_id=$1 AND entity_type='Route' AND record_id<>$2 AND deleted_at IS NULL
              AND payload->'deliveryIds' ? $3 LIMIT 1`,[companyId,canonicalId,deliveryId]);
          if(activeElsewhere.rowCount)throw new SyncError('ROUTE_DELIVERY_ALREADY_ACTIVE','Delivery já pertence a outra Route ativa.');
          canonicalIds.push(deliveryId);
        }
        if(new Set(canonicalIds).size!==canonicalIds.length)invalid('Route.deliveryIds contém a mesma Delivery por aliases diferentes.');
        canonical.deliveryIds=canonicalIds;
      }
      if(entityType==='Earning'){
        if(record.amountMinor===undefined&&typeof record.amount==='number'&&Number.isFinite(record.amount)){
          const legacyMinor=Math.round(record.amount*100);
          if(!Number.isSafeInteger(legacyMinor)||Math.abs(legacyMinor)>9000000000000000)invalid('Earning.amount legado fora do limite seguro.');
          canonical.amountMinor=legacyMinor;
          canonical.currency=record.currency||'BRL';
          canonical.components=Array.isArray(record.components)?record.components:[];
          delete canonical.amount;
        }
        if(!Number.isSafeInteger(canonical.amountMinor)||typeof canonical.currency!=='string'||!/^[A-Z]{3}$/u.test(canonical.currency))
          invalid('Earning exige amountMinor inteiro seguro e currency ISO explícita.');
        if(Object.hasOwn(record,'amountMinor')&&(!Number.isSafeInteger(record.amountMinor)||Math.abs(record.amountMinor)>9000000000000000))invalid('Earning.amountMinor deve ser um inteiro seguro em unidade monetária mínima.');
        if(Object.hasOwn(record,'currency')&&(typeof record.currency!=='string'||!/^[A-Z]{3}$/u.test(record.currency)))invalid('Earning.currency inválida.');
        if(Object.hasOwn(record,'components')&&(!Array.isArray(record.components)||record.components.length>100||
          record.components.some(item=>!item||typeof item.code!=='string'||!item.code.trim()||item.code.length>4000||!Number.isSafeInteger(item.amountMinor)||Math.abs(item.amountMinor)>9000000000000000)))invalid('Earning.components inválido.');
        if(Object.hasOwn(record,'ruleVersion')&&(typeof record.ruleVersion!=='string'||record.ruleVersion.length>4000))invalid('Earning.ruleVersion inválida.');
      }
      if(entityType==='Order'){
        validateOrderMoneyRecord(record);
      }
      if (entityType === 'Delivery' && canonical.driverId) {
        const driverId = await resolveReferencedAlias(client, companyId, 'Driver', canonical.driverId);
        if (!driverId) throw new SyncError('UNRESOLVED_REFERENCE', 'Delivery.driverId ainda não possui ID canônico.');
        const driver = await client.query(`SELECT 1 FROM rotamoto.domain_records
          WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='Driver' AND deleted_at IS NULL FOR UPDATE`, [companyId, driverId]);
        if (!driver.rowCount) throw new SyncError('UNRESOLVED_REFERENCE', 'Delivery.driverId não referencia um motorista ativo desta empresa.');
        canonical.driverId = driverId;
      }
      if(entityType==='DeliveryProof'){
        const media=record.media;
        if(media!==undefined){
          if(!media||typeof media!=='object'||Array.isArray(media)||typeof media.mimeType!=='string'||
            !['image/png','image/jpeg'].includes(media.mimeType)||!Number.isSafeInteger(media.sizeBytes)||media.sizeBytes<0||media.sizeBytes>8388608)
            invalid('DeliveryProof.media inválida.');
          if(media.dataUrl!==undefined)invalid('Conteúdo inline legado deve permanecer local até existir um blob storage configurado.');
          if(!media.storageRef||typeof media.storageRef!=='object'||Array.isArray(media.storageRef)||
            typeof media.storageRef.provider!=='string'||media.storageRef.provider.length>64||
            typeof media.storageRef.objectKey!=='string'||!media.storageRef.objectKey.trim()||media.storageRef.objectKey.length>512||
            typeof media.sha256!=='string'||!/^[a-f0-9]{64}$/iu.test(media.sha256))
            invalid('DeliveryProof exige referência de armazenamento e digest SHA-256.');
          const deliveryCanonicalId=await resolveReferencedAlias(client,companyId,'Delivery',record.deliveryId);
          if(!deliveryCanonicalId)throw new SyncError('UNRESOLVED_REFERENCE','Delivery da prova ainda não possui ID canônico.');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`proof-media:${companyId}:${deliveryCanonicalId}`]);
          const storageResult=await mediaStorage.validateReference(media.storageRef,{companyId,deliveryId:deliveryCanonicalId,
            mimeType:media.mimeType,sizeBytes:media.sizeBytes,sha256:media.sha256});
          if(!storageResult.valid)throw new SyncError(storageResult.code||'MEDIA_STORAGE_UNAVAILABLE','Storage de prova não está configurado ou a referência não foi validada.');
        }
      }
      if (entityType === 'DeliveryEvent') canonical.actor = { type: 'user', id: userId };
      if (canonical.deletedAt !== undefined && canonical.deletedAt !== null) canonical.deletedAt = timestamp(canonical.deletedAt, now, `${entityType}.deletedAt`).toISOString();
      if (entityType === 'Delivery' && !Object.hasOwn(TRANSITIONS, canonical.status)) invalid('Delivery.status inválido.');
      let relatedType = null;
      let relatedId = null;
      let referenceField = null;
      let targetLocalId = null;
      if (entityType === 'Delivery') { relatedType = 'Order'; referenceField = 'orderId'; targetLocalId = canonical.orderId; }
      else if (entityType === 'DeliveryEvent') {
        const target = String(canonical.entity || '').toLowerCase();
        if (target === 'delivery' || target === 'order') {
          relatedType = target === 'delivery' ? 'Delivery' : 'Order';
          referenceField = 'entityId';
          targetLocalId = canonical.entityId;
        }
      } else if (['LocationPoint','DeliveryProof','Earning'].includes(entityType)) {
        relatedType = 'Delivery'; referenceField = 'deliveryId'; targetLocalId = canonical.deliveryId;
      }
      if (targetLocalId !== undefined && targetLocalId !== null && targetLocalId !== '') {
        relatedId = await resolveReferencedAlias(client, companyId, relatedType, targetLocalId);
        if (!relatedId) throw new SyncError('UNRESOLVED_REFERENCE', `Referência ${relatedType} ainda não possui ID canônico.`);
        canonical[referenceField] = relatedId;
      }
      if (['DeliveryEvent','LocationPoint','DeliveryProof'].includes(entityType) && relatedId) {
        await assertAssignedDriver(client, principal, appKey, relatedId);
      }
      if(entityType==='Earning'&&canonical.driverId){
        const driverId=await resolveReferencedAlias(client,companyId,'Driver',canonical.driverId);
        if(!driverId)throw new SyncError('UNRESOLVED_REFERENCE','Earning.driverId ainda não possui ID canônico.');
        canonical.driverId=driverId;
      }
      if (entityType === 'Delivery' && resolved.created && relatedId) {
        const matches = await client.query(`SELECT record_id::text FROM rotamoto.domain_records
          WHERE company_id=$1 AND entity_type='Delivery' AND related_entity_type='Order' AND related_record_id=$2
          ORDER BY record_id LIMIT 2`, [companyId, relatedId]);
        if (matches.rowCount > 1) throw new SyncError('SYNC_CONFLICT', 'Mais de uma Delivery canônica está associada ao Order; reconciliação explícita necessária.');
        if (matches.rowCount === 1) {
          canonicalId = matches.rows[0].record_id;
          canonical.id = canonicalId;
          resolved.canonicalId = canonicalId;
          resolved.canonicalExists = true;
        }
      }
      if (seen.has(`${entityType}:${canonicalId}`)) invalid(`O pacote repete ${entityType} ${operationLocalId}.`);
      seenKey = `${entityType}:${canonicalId}`;
      seen.add(seenKey);
      const existing = await client.query(`SELECT entity_type,payload,version,created_at,updated_at,deleted_at,
        related_entity_type,related_record_id::text
        FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 FOR UPDATE`, [companyId, canonicalId]);
      if (existing.rowCount && existing.rows[0].entity_type !== entityType) throw new SyncError('SYNC_CONFLICT', 'ID canônico já pertence a outro tipo de entidade.');
      if(entityType==='Route'&&record.deliveryIds!==undefined){
        const before=existing.rows[0]?.payload?.deliveryIds||[],after=canonical.deliveryIds||[];
        routeMembershipChange={added:after.filter(id=>!before.includes(id)),removed:before.filter(id=>!after.includes(id))};
      }
      if (existing.rowCount) {
        ackCanonicalId = canonicalId;
        ackVersion = Number(existing.rows[0].version);
      }
      if (existing.rowCount && entityType === 'DeliveryEvent') {
        const oldPayload = existing.rows[0].payload;
        if (stableJson(oldPayload) !== stableJson(canonical)) throw new SyncError('SYNC_CONFLICT', 'eventId já foi usado para outro fato.');
        if (resolved.created) await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
        aliases.push({ entity: entityType, localId: resolved.localId, canonicalId });
        operationResults.push({ operation: item.operationIndex, entity: entityType, localId: resolved.localId,
          canonicalId, canonicalVersion: Number(existing.rows[0].version), status: 'duplicate' });
        continue;
      }
      let changed = !existing.rowCount;
      let canonicalVersion = 1;
      canonical.version = 1;
      if (existing.rowCount) {
        const old = existing.rows[0];
        if (entityType === 'Driver' && appKey === 'restaurante' && canonical.deletedAt) {
          const linked = await client.query(`SELECT 1 FROM rotamoto.memberships WHERE company_id=$1 AND driver_id=$2::uuid
            UNION ALL SELECT 1 FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Delivery'
              AND payload->>'driverId'=$2 AND deleted_at IS NULL
              AND payload->>'status' IN ('CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','REDELIVERY') LIMIT 1`, [companyId, canonicalId]);
          if (linked.rowCount) throw new SyncError('DRIVER_LINKED', 'Desvincule a identidade e reatribua entregas ativas antes de remover o motorista.');
        }
        canonicalVersion = Number(old.version);
        if (entityType === 'Delivery' && appKey === 'motoboy' && canonical.status === 'CANCELLED') {
          throw new SyncError('FORBIDDEN_FIELD', 'Cancelamento administrativo de Delivery pertence ao Restaurante.');
        }
        if (entityType === 'Delivery' && appKey === 'motoboy' &&
            !['ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','DELIVERED','FAILED','RETURNED'].includes(canonical.status)) {
          throw new SyncError('FORBIDDEN_FIELD', 'O Motoboy pode registrar somente estados derivados da execução.');
        }
        const restaurantRedelivery = appKey === 'restaurante' && canonical.status === 'REDELIVERY' &&
          ['DELIVERED','FAILED','RETURNED'].includes(old.payload.status);
        if (entityType === 'Delivery' && appKey === 'restaurante' && old.payload.status !== canonical.status &&
            !['ASSIGNED','CANCELLED'].includes(canonical.status) && !restaurantRedelivery) {
          throw new SyncError('FORBIDDEN_FIELD', 'O Restaurante pode atribuir, cancelar ou solicitar reentrega após falha/retorno/conclusão; estados de execução pertencem ao Motoboy.');
        }
        if (entityType === 'Delivery' && appKey === 'motoboy' &&
            Object.keys(record).some(key => !DELIVERY_META_FIELDS.has(key) && !DELIVERY_MOTOBOY_FIELDS.has(key) &&
              stableJson(record[key]) !== stableJson(old.payload[key]))) {
          throw new SyncError('FORBIDDEN_FIELD', 'O Motoboy não pode sobrescrever campos comerciais ou de planejamento da entrega.');
        }
        if (entityType === 'Delivery' && appKey === 'restaurante' &&
            Object.keys(record).some(key => !DELIVERY_META_FIELDS.has(key) && !DELIVERY_RESTAURANT_FIELDS.has(key) &&
              !(key === 'status' && (['ASSIGNED','CANCELLED'].includes(record.status) || restaurantRedelivery)) &&
              stableJson(record[key]) !== stableJson(old.payload[key]))) {
          throw new SyncError('FORBIDDEN_FIELD', 'O Restaurante não pode sobrescrever campos de execução da entrega.');
        }
        if (entityType === 'Delivery' && old.payload.status !== canonical.status &&
            !TRANSITIONS[old.payload.status]?.includes(canonical.status)) {
          throw new SyncError('INVALID_TRANSITION', `Transição de entrega inválida: ${old.payload.status} → ${canonical.status}.`);
        }
        if (entityType === 'Delivery' && appKey === 'motoboy' && canonical.status === 'CANCELLED') {
          throw new SyncError('FORBIDDEN_FIELD', 'Cancelamento administrativo de Delivery pertence ao Restaurante.');
        }
        if (old.deleted_at) throw new SyncError('SYNC_CONFLICT', 'Registro tombstonado não pode ser reativado sem operação explícita.');
        const baseVersion = record.baseVersion ?? record.sync?.canonicalVersion;
        if (!Number.isSafeInteger(baseVersion) || baseVersion !== Number(old.version)) {
          throw new SyncError('REVISION_CONFLICT', 'A revisão local não corresponde à revisão canônica atual.');
        }
        canonicalVersion = Number(old.version) + 1;
        if (entityType === 'Delivery' && appKey === 'restaurante' && old.payload.driverId &&
            old.payload.driverId !== canonical.driverId) {
          assignmentRevocations.push({ deliveryId: canonicalId, driverId: old.payload.driverId,
            version: canonicalVersion, updatedAt: now.toISOString() });
        }
        // v1 sends complete records today, but merging absent fields prevents a
        // partial device projection from erasing fields owned by another client.
        canonical = { ...old.payload, ...canonical,
          id: canonicalId, companyId, createdAt: new Date(old.created_at).toISOString(), version: canonicalVersion };
        if (entityType === 'Delivery') {
          const allowedFields = appKey === 'restaurante' ? DELIVERY_RESTAURANT_FIELDS : DELIVERY_MOTOBOY_FIELDS;
          for (const key of Object.keys(canonical)) {
            if (!allowedFields.has(key) && !DELIVERY_META_FIELDS.has(key)) canonical[key] = old.payload[key];
          }
          if (appKey === 'restaurante' && old.payload.status !== canonical.status && !['ASSIGNED','CANCELLED'].includes(canonical.status) && !restaurantRedelivery) {
            canonical.status = old.payload.status;
          }
        }
        canonical.updatedAt = now.toISOString();
        if (!relatedId && old.related_record_id) {
          relatedType = old.related_entity_type;
          relatedId = old.related_record_id;
        }
        changed = true;
      }
      if (entityType === 'Delivery' && !existing.rowCount && appKey !== 'restaurante') {
        throw new SyncError('FORBIDDEN', 'Somente o Restaurante pode criar Delivery canônica.');
      }
      if (entityType === 'Delivery' && !existing.rowCount && !['CREATED','ASSIGNED'].includes(canonical.status)) {
        throw new SyncError('FORBIDDEN_FIELD', 'Uma Delivery nova deve começar em CREATED ou ASSIGNED.');
      }
      if (!existing.rowCount) {
        await client.query(`INSERT INTO rotamoto.domain_records
          (company_id,record_id,entity_type,source_app,source_installation_id,source_event_id,related_entity_type,related_record_id,payload,version,created_at,updated_at,deleted_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
        [companyId, canonicalId, entityType, appKey, installationId, entityType === 'DeliveryEvent' ? localId : null,
          relatedId ? relatedType : null, relatedId, JSON.stringify(canonical), canonicalVersion, meta.createdAt, meta.updatedAt, canonical.deletedAt || null]);
        await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
        outcomes.received += 1;
      } else {
        if (resolved.created) await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
        if (changed) {
          await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5,deleted_at=$6,
            related_entity_type=$7,related_record_id=$8 WHERE company_id=$1 AND record_id=$2`,
          [companyId, canonicalId, JSON.stringify(canonical), canonicalVersion, canonical.updatedAt, canonical.deletedAt || null,
            relatedId ? relatedType : null, relatedId]);
          outcomes.updated += 1;
        }
      }
      if (entityType === 'Delivery' && appKey === 'restaurante') {
        const previousDriverId = existing.rows[0]?.payload?.driverId || null;
        const nextDriverId = canonical.driverId || null;
        await projectRestaurantDriverAssignment(client, { companyId, userId, deliveryId: canonicalId,
          previousDriverId, driverId: nextDriverId, deliveryStatus: canonical.status, now });
      }
      if (entityType === 'DeliveryProof' && canonical.media?.storageRef?.objectKey) {
        await client.query(`DELETE FROM rotamoto.proof_media_upload_intents
          WHERE company_id=$1 AND proof_id=$2::uuid AND object_key=$3`,
        [companyId, resolved.localId, canonical.media.storageRef.objectKey]);
      }
      if (entityType === 'Delivery' && appKey === 'restaurante' && canonical.status === 'REDELIVERY' && existing.rowCount) {
        await client.query(`INSERT INTO rotamoto.audit_log
          (id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
          VALUES($1,$2,$3,'user','delivery.redelivery.requested','Delivery',$4,$5::jsonb)`,
        [uuidV7(now.getTime()),companyId,userId,canonicalId,JSON.stringify({from:existing.rows[0].payload.status,to:'REDELIVERY'})]);
      }
      if(entityType==='Route'&&routeMembershipChange&&(routeMembershipChange.added.length||routeMembershipChange.removed.length)){
        await client.query(`INSERT INTO rotamoto.audit_log
          (id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
          VALUES($1,$2,$3,'user','route.delivery-membership.changed','Route',$4,$5::jsonb)`,
        [uuidV7(now.getTime()),companyId,userId,canonicalId,JSON.stringify(routeMembershipChange)]);
      }
      if (entityType === 'DeliveryEvent' && String(canonical.entity || '').toLowerCase() === 'delivery' && !existing.rowCount) {
        const executionStatus = ({ DELIVERY_ACCEPTED: 'ACCEPTED', DELIVERY_PICKED_UP: 'PICKED_UP',
          DELIVERY_STARTED: 'OUT_FOR_DELIVERY', DELIVERY_ARRIVED: 'ARRIVED',
          DELIVERY_COMPLETED: 'DELIVERED', DELIVERY_FAILED: 'FAILED', DELIVERY_RETURNED: 'RETURNED' })[canonical.type];
        if (!executionStatus) throw new SyncError('FORBIDDEN_EVENT', 'Evento de execução não reconhecido ou não permitido.');
        const currentDelivery = await client.query(`SELECT payload,version,created_at,deleted_at FROM rotamoto.domain_records
          WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' FOR UPDATE`, [companyId, relatedId]);
        if (!currentDelivery.rowCount || currentDelivery.rows[0].deleted_at) throw new SyncError('UNRESOLVED_REFERENCE', 'Delivery canônica inexistente ou encerrada.');
        const oldStatus = currentDelivery.rows[0].payload.status;
        if (oldStatus !== executionStatus && !TRANSITIONS[oldStatus]?.includes(executionStatus)) {
          throw new SyncError('INVALID_TRANSITION', `Transição de entrega inválida: ${oldStatus} → ${executionStatus}.`);
        }
        if (oldStatus !== executionStatus) {
          const projectedAt = now.toISOString();
          const projectedVersion = Number(currentDelivery.rows[0].version) + 1;
          const projected = { ...currentDelivery.rows[0].payload, status: executionStatus,
            updatedAt: projectedAt, version: projectedVersion };
          if (executionStatus === 'ACCEPTED') projected.acceptedAt = canonical.occurredAt || projectedAt;
          if (executionStatus === 'PICKED_UP') projected.pickedUpAt = canonical.occurredAt || projectedAt;
          if (executionStatus === 'OUT_FOR_DELIVERY') projected.pickedUpAt = projected.pickedUpAt || canonical.occurredAt || projectedAt;
          if (executionStatus === 'ARRIVED') projected.arrivedAt = canonical.occurredAt || projectedAt;
          if (executionStatus === 'DELIVERED') projected.completedAt = canonical.occurredAt || projectedAt;
          await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5
            WHERE company_id=$1 AND record_id=$2`, [companyId, relatedId, JSON.stringify(projected), projectedVersion, projectedAt]);
          await projectInternalExecution(client, { companyId, userId, deliveryId: relatedId,
            deliveryStatus: executionStatus, now });
          pending.push({ entityType: 'Delivery', canonicalId: relatedId, canonical: projected,
            meta: { createdAt: new Date(currentDelivery.rows[0].created_at), updatedAt: new Date(projectedAt), version: projectedVersion },
            changed: true, relatedType: 'Order', relatedId: null });
        }
      }
      pending.push({ entityType, canonicalId, canonical, meta, changed, relatedType, relatedId });
      aliases.push({ entity: entityType, localId: resolved.localId, canonicalId });
      operationResults.push({ operation: item.operationIndex, entity: entityType, localId: resolved.localId,
        canonicalId, canonicalVersion, status: existing.rowCount ? 'accepted' : 'accepted' });
      } catch (error) {
        if (/^(08|57P)/u.test(String(error?.code || ''))) throw error;
        await client.query('ROLLBACK TO SAVEPOINT sync_operation');
        pending.length = pendingBefore;
        assignmentRevocations.length = revocationsBefore;
        aliases.length = aliasesBefore;
        operationResults.length = resultBefore;
        Object.assign(outcomes, countsBefore);
        if (seenKey) seen.delete(seenKey);
        const conflictCodes = new Set(['SYNC_CONFLICT','REVISION_CONFLICT','INVALID_TRANSITION','UNRESOLVED_REFERENCE','IMMUTABLE_EVENT','ROUTE_DELIVERY_ALREADY_ACTIVE','DRIVER_LINKED']);
        operationResults.push({ operation: item.operationIndex, entity: entityType, localId: localId || null,
          ...(ackCanonicalId ? { canonicalId: ackCanonicalId } : {}), ...(ackVersion ? { canonicalVersion: ackVersion } : {}),
          status: conflictCodes.has(error.code) ? 'conflict' : 'rejected', error: { code: error.code || 'OPERATION_REJECTED' } });
      } finally {
        await client.query('RELEASE SAVEPOINT sync_operation');
      }
    }

    for (const item of pending) {
      if (!item.changed) continue;
      const record = item.canonical;
      const eventId = uuidV7(now.getTime());
      const outboxEvent = { eventId, type: 'CANONICAL_RECORD_UPSERTED', entity: item.entityType,
        entityId: item.canonicalId, occurredAt: now.toISOString(), actor: { type: 'user', id: userId },
        payload: item.canonical, protocolVersion: 1 };
      await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,payload)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [companyId, eventId, appKey, installationId, JSON.stringify(outboxEvent)]);
    }
    for (const revocation of assignmentRevocations) {
      const eventId = uuidV7(now.getTime());
      const event = { eventId, type: 'CANONICAL_ASSIGNMENT_REVOKED', entity: 'Delivery',
        entityId: revocation.deliveryId, occurredAt: now.toISOString(), actor: { type: 'user', id: userId },
        payload: { id: revocation.deliveryId, companyId, version: revocation.version, updatedAt: revocation.updatedAt }, protocolVersion: 1 };
      await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,recipient_driver_id,payload)
        VALUES($1,$2,'restaurante',$3,$4,$5::jsonb)`,
      [companyId, eventId, installationId, revocation.driverId, JSON.stringify(event)]);
    }

    for (const [index, tombstone] of (data.tombstones || []).entries()) {
      await client.query('SAVEPOINT sync_tombstone');
      const resultBefore = operationResults.length;
      let entityType = null;
      let localId = null;
      let canonicalId = null;
      let canonicalVersion = null;
      try {
        if (!tombstone || typeof tombstone !== 'object' || Array.isArray(tombstone)) invalid('Tombstone inválido.');
        if (typeof tombstone.store !== 'string' || !Object.hasOwn(TOMBSTONE_TYPES, tombstone.store)) invalid('Tipo de tombstone não suportado pelo contrato v1.');
        entityType = TOMBSTONE_TYPES[tombstone.store];
        if (entityType === 'Driver' && appKey === 'restaurante') {
          const resolvedDriver = await resolveReferencedAlias(client, companyId, 'Driver', tombstone.id);
          if (resolvedDriver) {
            const linked = await client.query(`SELECT 1 FROM rotamoto.memberships WHERE company_id=$1 AND driver_id=$2::uuid
              UNION ALL SELECT 1 FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Delivery'
                AND payload->>'driverId'=$2 AND deleted_at IS NULL
                AND payload->>'status' IN ('CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','REDELIVERY') LIMIT 1`, [companyId, resolvedDriver]);
            if (linked.rowCount) throw new SyncError('DRIVER_LINKED', 'Desvincule a identidade e reatribua entregas ativas antes de remover o motorista.');
          }
        }
        localId = boundedText(tombstone.id, 'Tombstone.id');
        if (entityType === 'DeliveryEvent') throw new SyncError('IMMUTABLE_EVENT', 'Eventos são fatos e não aceitam tombstone.');
        const ownerError = operationAuthorityError(appKey, entityType, tombstone);
        if (ownerError || (entityType === 'Delivery' && appKey !== 'restaurante')) {
          throw ownerError || new SyncError('FORBIDDEN', 'Somente o Restaurante pode cancelar administrativamente uma Delivery.');
        }
        let resolved = await resolveLocal(client, companyId, appKey, installationId, entityType, localId);
        if (!resolved) {
          const referenced = await resolveReferencedAlias(client, companyId, entityType, localId);
          if (!referenced) throw new SyncError('UNRESOLVED_REFERENCE', 'Tombstone sem mapeamento canônico.');
          resolved = { localId, canonicalId: referenced };
        }
        canonicalId = resolved.canonicalId;
        const existing = await client.query(`SELECT entity_type,payload,version,created_at,updated_at,deleted_at FROM rotamoto.domain_records
          WHERE company_id=$1 AND record_id=$2 FOR UPDATE`, [companyId, canonicalId]);
        if (!existing.rowCount) throw new SyncError('UNRESOLVED_REFERENCE', 'Tombstone aponta para registro inexistente.');
        if (existing.rows[0].entity_type !== entityType) throw new SyncError('SYNC_CONFLICT', 'Tombstone tem tipo diferente do registro canônico.');
        canonicalVersion = Number(existing.rows[0].version);
        if (existing.rows[0].deleted_at) {
          operationResults.push({ operation: `tombstones:${index}`, entity: entityType, localId, canonicalId, canonicalVersion, status: 'duplicate' });
          continue;
        }
        const baseVersion = tombstone.baseVersion ?? tombstone.sync?.canonicalVersion;
        if (!Number.isSafeInteger(baseVersion) || baseVersion !== canonicalVersion) {
          throw new SyncError('REVISION_CONFLICT', 'Tombstone baseado em revisão canônica obsoleta.');
        }
        canonicalVersion += 1;
        const deletedAt = now;
        const updatedAt = now;
        const payload = { ...existing.rows[0].payload, deleted: true, deletedAt: deletedAt.toISOString(),
          updatedAt: updatedAt.toISOString(), version: canonicalVersion, id: canonicalId, companyId };
        await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5,deleted_at=$6
          WHERE company_id=$1 AND record_id=$2`, [companyId, canonicalId, JSON.stringify(payload), canonicalVersion, updatedAt, deletedAt]);
        const eventId = uuidV7(now.getTime());
        const outboxEvent = { eventId, type: 'CANONICAL_RECORD_TOMBSTONED', entity: entityType,
          entityId: canonicalId, occurredAt: now.toISOString(), actor: { type: 'user', id: userId },
          payload: { id: canonicalId, deletedAt: deletedAt.toISOString(), updatedAt: updatedAt.toISOString(), version: canonicalVersion }, protocolVersion: 1 };
        await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,payload)
          VALUES($1,$2,$3,$4,$5::jsonb)`, [companyId, eventId, appKey, installationId, JSON.stringify(outboxEvent)]);
        outcomes.deleted += 1;
        aliases.push({ entity: entityType, localId, canonicalId });
        operationResults.push({ operation: `tombstones:${index}`, entity: entityType, localId, canonicalId, canonicalVersion, status: 'accepted' });
      } catch (error) {
        if (/^(08|57P)/u.test(String(error?.code || ''))) throw error;
        await client.query('ROLLBACK TO SAVEPOINT sync_tombstone');
        operationResults.length = resultBefore;
        const conflictCodes = new Set(['SYNC_CONFLICT','REVISION_CONFLICT','UNRESOLVED_REFERENCE','IMMUTABLE_EVENT','DRIVER_LINKED']);
        operationResults.push({ operation: `tombstones:${index}`, ...(entityType ? { entity: entityType } : {}), localId,
          ...(canonicalId ? { canonicalId } : {}), ...(canonicalVersion ? { canonicalVersion } : {}),
          status: conflictCodes.has(error.code) ? 'conflict' : 'rejected', error: { code: error.code || 'OPERATION_REJECTED' } });
      } finally {
        await client.query('RELEASE SAVEPOINT sync_tombstone');
      }
    }

    const digest = packetDigest(packet);
    const result = { ...outcomes, duplicate: false, packetId: packet.packetId, companyId, aliases, operationResults };
    await client.query(`INSERT INTO rotamoto.sync_inbox(company_id,packet_id,app_key,installation_id,payload_digest,result)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [companyId, packetId, appKey, installationId, digest, JSON.stringify(result)]);
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user','sync.packet.accepted','sync_packet',$4,$5::jsonb)`,
    [uuidV7(now.getTime()), companyId, userId, packet.packetId, JSON.stringify({ received: outcomes.received, updated: outcomes.updated, deleted: outcomes.deleted })]);
    return result;
  }

  function encodeCursor(row) { return Buffer.from(`${row.created_at_cursor}\n${row.event_id}`).toString('base64url'); }
  async function pull(client, principal, { cursor = null, limit = 100, deviceId } = {}) {
    const responseDeviceId = boundedText(deviceId, 'deviceId', 128);
    const installation = await findInstallation(client, principal, responseDeviceId);
    requireDriverInstallation(installation, principal);
    const size = Number(limit);
    if (!Number.isSafeInteger(size) || size < 1 || size > 100) invalid('limit deve estar entre 1 e 100.');
    let afterAt = new Date(0).toISOString();
    let afterId = '00000000-0000-0000-0000-000000000000';
    if (cursor !== null) {
      if (typeof cursor !== 'string' || cursor.length > 512) invalid('cursor inválido.');
      let decoded;
      try { decoded = Buffer.from(cursor, 'base64url').toString('utf8').split('\n'); } catch (_) { invalid('cursor inválido.'); }
      if (decoded.length !== 2 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(decoded[0]) ||
          !Number.isFinite(Date.parse(decoded[0])) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded[1])) invalid('cursor inválido.');
      // Preserve PostgreSQL's microsecond precision; converting to JS Date here
      // truncates the cursor and can replay rows created in the same millisecond.
      afterAt = decoded[0]; afterId = decoded[1];
    }
    const scope = installation.app_key === 'restaurante' ? '' : `AND (
      o.recipient_driver_id=$4::uuid OR (o.recipient_driver_id IS NULL AND EXISTS (
        SELECT 1 FROM rotamoto.domain_records d
        WHERE d.company_id=o.company_id AND d.record_id::text=o.payload->>'entityId' AND d.entity_type=o.payload->>'entity' AND (
          (d.entity_type='Delivery' AND d.payload->>'driverId'=$4::text) OR
          (d.entity_type='Driver' AND d.record_id=$4::uuid) OR
          (d.entity_type='Order' AND EXISTS (SELECT 1 FROM rotamoto.domain_records x
            WHERE x.company_id=d.company_id AND x.entity_type='Delivery' AND x.related_entity_type='Order'
              AND x.related_record_id=d.record_id AND x.payload->>'driverId'=$4::text)) OR
          (d.entity_type IN ('DeliveryEvent','LocationPoint','DeliveryProof') AND EXISTS
            (SELECT 1 FROM rotamoto.domain_records x WHERE x.company_id=d.company_id AND x.entity_type='Delivery'
              AND x.record_id=d.related_record_id AND x.payload->>'driverId'=$4::text)) OR
          (d.entity_type='Earning' AND (d.payload->>'driverId'=$4::text OR EXISTS
            (SELECT 1 FROM rotamoto.domain_records x WHERE x.company_id=d.company_id AND x.entity_type='Delivery'
              AND x.record_id=d.related_record_id AND x.payload->>'driverId'=$4::text))) OR
          (d.entity_type='Route' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(
              CASE WHEN jsonb_typeof(d.payload->'deliveryIds')='array' THEN d.payload->'deliveryIds' ELSE '[]'::jsonb END) ids(id)
            JOIN rotamoto.domain_records x ON x.company_id=d.company_id AND x.record_id=ids.id::uuid
            WHERE x.entity_type='Delivery' AND x.payload->>'driverId'=$4::text))
        ))))`;
    const params = [principal.company_id, afterAt, afterId];
    if (installation.app_key === 'motoboy') params.push(principal.driver_id);
    params.push(size + 1);
    const pullSql = `SELECT o.event_id::text,o.payload,o.created_at,
        to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
      FROM rotamoto.sync_outbox o WHERE o.company_id=$1 AND (o.created_at,o.event_id)>($2::timestamptz,$3::uuid)
        ${scope} ORDER BY o.created_at,o.event_id LIMIT $${params.length}`;
    const result = await client.query(pullSql, params);
    const hasMore = result.rowCount > size;
    const rows = result.rows.slice(0, size);
    const events = [];
    for (const row of rows) {
      const event = row.payload;
      if (installation.app_key === 'motoboy' && event.entity === 'Route' && Array.isArray(event.payload?.deliveryIds)) {
        const localIds = event.payload.deliveryIds.filter(id => UUID.test(id));
        const allowed = localIds.length ? await client.query(`SELECT record_id::text FROM rotamoto.domain_records
          WHERE company_id=$1 AND entity_type='Delivery' AND payload->>'driverId'=$2 AND record_id=ANY($3::uuid[])`,
        [principal.company_id, principal.driver_id, localIds]) : { rows: [] };
        const visible = new Set(allowed.rows.map(item => item.record_id));
        const payload = { ...event.payload, deliveryIds: event.payload.deliveryIds.filter(id => visible.has(id)) };
        delete payload.stops;
        delete payload.driverId;
        events.push({ ...event, payload });
      } else events.push(event);
    }
    let companySettings = null;
    if (installation.app_key === 'motoboy') {
      const company = await client.query(`SELECT id::text AS company_id,name,support_phone,time_zone,operational_address,
          operational_latitude,operational_longitude,operational_location_provenance,operational_location_version,company_settings_version,route_grouping_policy
        FROM rotamoto.companies WHERE id=$1 AND status='active'`, [principal.company_id]);
      if (company.rowCount) {
        const row = company.rows[0];
        companySettings = { companyId: row.company_id, authority: 'restaurant', revision: Number(row.company_settings_version),
          name: row.name, supportPhone: row.support_phone || null, timeZone: row.time_zone || null,
          routeGroupingPolicy: row.route_grouping_policy,
          operationalLocation: row.operational_latitude == null ? null : { address: row.operational_address,
            latitude: Number(row.operational_latitude), longitude: Number(row.operational_longitude),
            provenance: row.operational_location_provenance, version: Number(row.operational_location_version) } };
      }
    }
    return { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
      packetId: `pkt_${uuidV7(clock().getTime())}`, companyId: principal.company_id,
      deviceId: responseDeviceId, createdAt: clock().toISOString(), ackFor: null, events,
      ...(companySettings ? { companySettings } : {}),
      data: { orders: [], deliveries: [], drivers: [], routes: [], locationUpdates: [], deliveryEvents: [], proofs: [], earnings: [], tombstones: [] },
      nextCursor: rows.length ? encodeCursor(rows.at(-1)) : cursor, hasMore };
  }

  return Object.freeze({ registerInstallation, push, pull, assignDeliveryToRoute });
}

module.exports = { SyncError, createSyncService, validatePacket, validateOrderMoneyRecord, ENTITY_ARRAYS, TRANSITIONS, WRITE_OWNERS };
