'use strict';

const crypto = require('node:crypto');
const { uuidV7 } = require('../identity/service');

const APP_KEYS = Object.freeze({ 'RotaMoto Restaurante': 'restaurante', Restaurante: 'restaurante', RotaMoto: 'motoboy' });
const WRITE_OWNERS = Object.freeze({ Order: 'restaurante', Route: 'restaurante', Earning: 'restaurante',
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
  const sourceApp = packet.source?.app;
  if (typeof sourceApp !== 'string' || !Object.hasOwn(APP_KEYS, sourceApp)) invalid('Aplicativo de origem incompatível com o contrato compartilhado.');
  const appKey = APP_KEYS[sourceApp];
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
  return { packetId: id, deviceId, appKey, data, events: packet.events || [] };
}

function createSyncService({ clock = () => new Date() } = {}) {
  async function ensureInstallation(client, companyId, appKey, deviceId) {
    const result = await client.query(`INSERT INTO rotamoto.sync_installations
      (id,company_id,app_key,local_device_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(company_id,app_key,local_device_id) DO UPDATE SET last_seen_at=greatest(rotamoto.sync_installations.last_seen_at,now())
      RETURNING id::text`, [uuidV7(clock().getTime()), companyId, appKey, deviceId]);
    return result.rows[0].id;
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
    return result.rows[0]?.canonical_id || null;
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
    const { packetId, deviceId, appKey, data, events } = validated;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 402117))', [`${companyId}:${packetId}`]);
    const prior = await client.query(`SELECT payload_digest,result FROM rotamoto.sync_inbox
      WHERE company_id=$1 AND packet_id=$2`, [companyId, packetId]);
    if (prior.rowCount) {
      const digest = packetDigest(packet);
      if (!Buffer.from(prior.rows[0].payload_digest).equals(digest)) throw new SyncError('SYNC_CONFLICT', 'packetId já foi usado para outro conteúdo.');
      return { ...prior.rows[0].result, duplicate: true };
    }
    const installationId = await ensureInstallation(client, companyId, appKey, deviceId);
    const pending = [];
    const aliases = [];
    const outcomes = { received: 0, updated: 0, ignored: 0, deleted: 0 };
    const seen = new Set();
    const now = clock();

    const incoming = ENTITY_ARRAYS.flatMap(([key, type]) => (data[key] || []).map(record => ({ record, entityType: type })));
    incoming.push(...events.map(record => ({ record, entityType: 'DeliveryEvent' })));
    for (const item of incoming) {
      const { record, entityType } = item;
      if (entityType === 'Company') throw new SyncError('FORBIDDEN', 'Company é provisionada pelo serviço de identidade.');
      const owner = WRITE_OWNERS[entityType];
      if (owner && owner !== appKey) throw new SyncError('FORBIDDEN', `${entityType} não pode ser alterada por este aplicativo.`);
      if (entityType === 'DeliveryEvent') {
        const target = String(record?.entity || '').toLowerCase();
        if ((target === 'order' && appKey !== 'restaurante') || (target === 'delivery' && appKey !== 'motoboy')) {
          throw new SyncError('FORBIDDEN', 'O aplicativo não é proprietário deste tipo de evento.');
        }
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) invalid(`${entityType} inválido.`);
      const localId = entityType === 'DeliveryEvent' ? (record.eventId || record.id) : record.id;
      const resolved = await resolveLocal(client, companyId, appKey, installationId, entityType, localId, { create: true });
      let canonicalId = resolved.canonicalId;
      const meta = metadata(record, entityType, now);
      let canonical = { ...record, id: canonicalId, companyId,
        ...(entityType === 'DeliveryEvent' ? { eventId: canonicalId } : {}),
        createdAt: meta.createdAt.toISOString(), updatedAt: meta.updatedAt.toISOString(), version: meta.version };
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
      if (seen.has(`${entityType}:${canonicalId}`)) invalid(`O pacote repete ${entityType} ${localId}.`);
      seen.add(`${entityType}:${canonicalId}`);
      const existing = await client.query(`SELECT entity_type,payload,version,created_at,updated_at,deleted_at,
        related_entity_type,related_record_id::text
        FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 FOR UPDATE`, [companyId, canonicalId]);
      if (existing.rowCount && existing.rows[0].entity_type !== entityType) throw new SyncError('SYNC_CONFLICT', 'ID canônico já pertence a outro tipo de entidade.');
      if (existing.rowCount && entityType === 'DeliveryEvent') {
        const oldPayload = existing.rows[0].payload;
        if (stableJson(oldPayload) !== stableJson(canonical)) throw new SyncError('SYNC_CONFLICT', 'eventId já foi usado para outro fato.');
        if (resolved.created) await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
        aliases.push({ entity: entityType, localId: resolved.localId, canonicalId });
        continue;
      }
      let changed = !existing.rowCount;
      if (existing.rowCount) {
        const old = existing.rows[0];
        const oldTime = new Date(old.updated_at).getTime();
        const newTime = meta.updatedAt.getTime();
        if (newTime < oldTime || (newTime === oldTime && meta.version < Number(old.version))) {
          outcomes.ignored += 1;
          if (resolved.created) await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
          aliases.push({ entity: entityType, localId: resolved.localId, canonicalId });
          continue;
        }
        if (newTime === oldTime && meta.version === Number(old.version)) {
          if (stableJson(old.payload) !== stableJson(canonical)) throw new SyncError('SYNC_CONFLICT', 'A mesma revisão contém conteúdo diferente.');
          if (resolved.created) await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
          aliases.push({ entity: entityType, localId: resolved.localId, canonicalId });
          continue;
        }
        if (entityType === 'Delivery' && old.payload.status !== canonical.status &&
            !TRANSITIONS[old.payload.status]?.includes(canonical.status)) {
          throw new SyncError('INVALID_TRANSITION', `Transição de entrega inválida: ${old.payload.status} → ${canonical.status}.`);
        }
        if (old.deleted_at) throw new SyncError('SYNC_CONFLICT', 'Registro tombstonado não pode ser reativado sem operação explícita.');
        // v1 sends complete records today, but merging absent fields prevents a
        // partial device projection from erasing fields owned by another client.
        canonical = { ...old.payload, ...canonical,
          id: canonicalId, companyId, createdAt: new Date(old.created_at).toISOString() };
        if (!relatedId && old.related_record_id) {
          relatedType = old.related_entity_type;
          relatedId = old.related_record_id;
        }
        changed = true;
      }
      if (!existing.rowCount) {
        await client.query(`INSERT INTO rotamoto.domain_records
          (company_id,record_id,entity_type,source_app,source_installation_id,source_event_id,related_entity_type,related_record_id,payload,version,created_at,updated_at,deleted_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
        [companyId, canonicalId, entityType, appKey, installationId, entityType === 'DeliveryEvent' ? localId : null,
          relatedId ? relatedType : null, relatedId, JSON.stringify(canonical), meta.version, meta.createdAt, meta.updatedAt, canonical.deletedAt || null]);
        await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
        outcomes.received += 1;
      } else {
        if (resolved.created) await addAlias(client, companyId, appKey, installationId, entityType, resolved.localId, canonicalId);
        if (changed) {
          await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5,deleted_at=$6,
            related_entity_type=$7,related_record_id=$8 WHERE company_id=$1 AND record_id=$2`,
          [companyId, canonicalId, JSON.stringify(canonical), meta.version, meta.updatedAt, canonical.deletedAt || null,
            relatedId ? relatedType : null, relatedId]);
          outcomes.updated += 1;
        }
      }
      pending.push({ entityType, canonicalId, canonical, meta, changed, relatedType, relatedId });
      aliases.push({ entity: entityType, localId: resolved.localId, canonicalId });
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

    for (const tombstone of data.tombstones || []) {
      if (!tombstone || typeof tombstone !== 'object' || Array.isArray(tombstone)) invalid('Tombstone inválido.');
      if (typeof tombstone.store !== 'string' || !Object.hasOwn(TOMBSTONE_TYPES, tombstone.store)) invalid('Tipo de tombstone não suportado pelo contrato v1.');
      const entityType = TOMBSTONE_TYPES[tombstone.store];
      if (entityType === 'DeliveryEvent') throw new SyncError('IMMUTABLE_EVENT', 'Eventos são fatos e não aceitam tombstone.');
      const localId = boundedText(tombstone.id, 'Tombstone.id');
      let resolved = await resolveLocal(client, companyId, appKey, installationId, entityType, localId);
      if (!resolved) {
        const canonicalId = await resolveReferencedAlias(client, companyId, entityType, localId);
        if (!canonicalId) throw new SyncError('UNRESOLVED_REFERENCE', 'Tombstone sem mapeamento canônico.');
        resolved = { localId, canonicalId };
      }
      const existing = await client.query(`SELECT entity_type,payload,version,created_at,updated_at,deleted_at FROM rotamoto.domain_records
        WHERE company_id=$1 AND record_id=$2 FOR UPDATE`, [companyId, resolved.canonicalId]);
      if (!existing.rowCount) throw new SyncError('UNRESOLVED_REFERENCE', 'Tombstone aponta para registro inexistente.');
      if (existing.rows[0].entity_type !== entityType) throw new SyncError('SYNC_CONFLICT', 'Tombstone tem tipo diferente do registro canônico.');
      const deletedAt = timestamp(tombstone.deletedAt || tombstone.updatedAt, now, 'Tombstone.deletedAt');
      const updatedAt = timestamp(tombstone.updatedAt || tombstone.deletedAt, deletedAt, 'Tombstone.updatedAt');
      if (deletedAt < new Date(existing.rows[0].created_at) || updatedAt < deletedAt) invalid('Tombstone possui timestamps inconsistentes.');
      const version = tombstone.version ?? Number(existing.rows[0].version) + 1;
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) invalid('Tombstone.version inválida.');
      const oldUpdatedAt = new Date(existing.rows[0].updated_at);
      if (updatedAt < oldUpdatedAt || (updatedAt.getTime() === oldUpdatedAt.getTime() && version <= Number(existing.rows[0].version))) {
        outcomes.ignored += 1; continue;
      }
      const payload = { ...existing.rows[0].payload, deleted: true, deletedAt: deletedAt.toISOString(),
        updatedAt: updatedAt.toISOString(), version, id: resolved.canonicalId, companyId };
      await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5,deleted_at=$6
        WHERE company_id=$1 AND record_id=$2`, [companyId, resolved.canonicalId, JSON.stringify(payload), version, updatedAt, deletedAt]);
      const eventId = uuidV7(now.getTime());
      const outboxEvent = { eventId, type: 'CANONICAL_RECORD_TOMBSTONED', entity: entityType,
        entityId: resolved.canonicalId, occurredAt: now.toISOString(), actor: { type: 'user', id: userId },
        payload: { id: resolved.canonicalId, deletedAt: deletedAt.toISOString(), updatedAt: updatedAt.toISOString(), version }, protocolVersion: 1 };
      await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,payload)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [companyId, eventId, appKey, installationId, JSON.stringify(outboxEvent)]);
      outcomes.deleted += 1;
      aliases.push({ entity: entityType, localId, canonicalId: resolved.canonicalId });
    }

    const digest = packetDigest(packet);
    const result = { ...outcomes, duplicate: false, packetId: packet.packetId, companyId, aliases };
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
    const result = await client.query(`SELECT event_id::text,payload,created_at,
        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
      FROM rotamoto.sync_outbox WHERE company_id=$1 AND (created_at,event_id)>($2::timestamptz,$3::uuid)
      ORDER BY created_at,event_id LIMIT $4`, [principal.company_id, afterAt, afterId, size + 1]);
    const hasMore = result.rowCount > size;
    const rows = result.rows.slice(0, size);
    const events = rows.map(row => row.payload);
    return { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
      packetId: `pkt_${uuidV7(clock().getTime())}`, companyId: principal.company_id,
      deviceId: responseDeviceId, createdAt: clock().toISOString(), ackFor: null, events,
      data: { orders: [], deliveries: [], drivers: [], routes: [], locationUpdates: [], deliveryEvents: [], proofs: [], earnings: [], tombstones: [] },
      nextCursor: rows.length ? encodeCursor(rows.at(-1)) : cursor, hasMore };
  }

  return Object.freeze({ push, pull });
}

module.exports = { SyncError, createSyncService, validatePacket, APP_KEYS, ENTITY_ARRAYS, TRANSITIONS, WRITE_OWNERS };
