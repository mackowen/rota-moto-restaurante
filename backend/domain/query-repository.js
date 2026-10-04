'use strict';

const COLLECTIONS = Object.freeze({
  orders: 'Order', deliveries: 'Delivery', routes: 'Route', drivers: 'Driver',
  'delivery-events': 'DeliveryEvent', locations: 'LocationPoint', proofs: 'DeliveryProof', earnings: 'Earning'
});
const FILTERS = Object.freeze({
  Order: new Set(['status']),
  Delivery: new Set(['status', 'driverId', 'orderId']),
  Route: new Set(['status']),
  Driver: new Set(['status']),
  DeliveryEvent: new Set(['relatedId']),
  LocationPoint: new Set(['relatedId']),
  DeliveryProof: new Set(['relatedId']),
  Earning: new Set(['driverId', 'relatedId'])
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function invalid(message) { const error = new Error(message); error.code = 'INVALID_INPUT'; throw error; }
function cursorDecode(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) invalid('cursor inválido.');
  let parts;
  try { parts = Buffer.from(value, 'base64url').toString('utf8').split('\n'); } catch (_) { invalid('cursor inválido.'); }
  if (parts.length !== 2 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(parts[0]) || !UUID.test(parts[1]) ||
      !Number.isFinite(Date.parse(parts[0])) || new Date(parts[0]).toISOString().slice(0, 19) !== parts[0].slice(0, 19)) invalid('cursor inválido.');
  return { updatedAt: parts[0], id: parts[1].toLowerCase() };
}
function cursorEncode(row) { return Buffer.from(`${row.updated_at_cursor}\n${row.record_id}`).toString('base64url'); }

function appendDriverScope(where, params, entityType, driverId) {
  if (!driverId) return;
  params.push(driverId);
  const p = `$${params.length}`;
  const scopes = {
    Driver: `d.record_id=${p}::uuid`,
    Delivery: `d.payload->>'driverId'=${p}`,
    Order: `EXISTS (SELECT 1 FROM rotamoto.domain_records x WHERE x.company_id=d.company_id
      AND x.entity_type='Delivery' AND x.related_entity_type='Order' AND x.related_record_id=d.record_id AND x.payload->>'driverId'=${p})`,
    Route: `EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.payload->'deliveryIds')='array'
      THEN d.payload->'deliveryIds' ELSE '[]'::jsonb END) i(id) JOIN rotamoto.domain_records x
      ON x.company_id=d.company_id AND x.record_id=i.id::uuid WHERE x.entity_type='Delivery' AND x.payload->>'driverId'=${p})`,
    DeliveryEvent: `d.related_entity_type='Delivery' AND EXISTS (SELECT 1 FROM rotamoto.domain_records x
      WHERE x.company_id=d.company_id AND x.record_id=d.related_record_id AND x.entity_type='Delivery' AND x.payload->>'driverId'=${p})`,
    LocationPoint: `d.related_entity_type='Delivery' AND EXISTS (SELECT 1 FROM rotamoto.domain_records x
      WHERE x.company_id=d.company_id AND x.record_id=d.related_record_id AND x.entity_type='Delivery' AND x.payload->>'driverId'=${p})`,
    DeliveryProof: `d.related_entity_type='Delivery' AND EXISTS (SELECT 1 FROM rotamoto.domain_records x
      WHERE x.company_id=d.company_id AND x.record_id=d.related_record_id AND x.entity_type='Delivery' AND x.payload->>'driverId'=${p})`,
    Earning: `(d.payload->>'driverId'=${p} OR EXISTS (SELECT 1 FROM rotamoto.domain_records x
      WHERE x.company_id=d.company_id AND x.record_id=d.related_record_id AND x.entity_type='Delivery' AND x.payload->>'driverId'=${p}))`
  };
  where.push(scopes[entityType]);
}

async function projectDriverRoute(client, companyId, row, driverId) {
  if (!driverId || row.entity_type !== 'Route') return row;
  const ids = Array.isArray(row.payload.deliveryIds) ? row.payload.deliveryIds : [];
  const validIds = ids.filter(id => UUID.test(id));
  const allowed = validIds.length ? await client.query(`SELECT record_id::text FROM rotamoto.domain_records
    WHERE company_id=$1 AND entity_type='Delivery' AND payload->>'driverId'=$2 AND record_id=ANY($3::uuid[])`,
  [companyId, driverId, validIds]) : { rows: [] };
  const visible = new Set(allowed.rows.map(item => item.record_id));
  const payload = { ...row.payload, deliveryIds: validIds.filter(id => visible.has(id)) };
  delete payload.stops;
  delete payload.driverId;
  return { ...row, payload };
}

function createDomainQueryRepository() {
  async function get(client, { companyId, entityType, id, driverId = null }) {
    if (!Object.values(COLLECTIONS).includes(entityType) || !UUID.test(id)) invalid('Identificador inválido.');
    const params = [companyId, entityType, id.toLowerCase()];
    const where = ['company_id=$1', 'entity_type=$2', 'record_id=$3::uuid', 'deleted_at IS NULL'];
    appendDriverScope(where, params, entityType, driverId);
    const result = await client.query(`SELECT record_id::text,payload,version,created_at,updated_at,deleted_at
      FROM rotamoto.domain_records d WHERE ${where.join(' AND ')}`, params);
    if (!result.rowCount) { const error = new Error('Recurso não encontrado.'); error.code = 'NOT_FOUND'; throw error; }
    const row = result.rows[0];
    const projected = await projectDriverRoute(client, companyId, { ...row, entity_type: entityType }, driverId);
    return { id: row.record_id, record: projected.payload, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
  }
  async function list(client, { companyId, entityType, limit, cursor, filters, includeDeleted, driverId = null }) {
    if (!Object.values(COLLECTIONS).includes(entityType)) invalid('Entidade não consultável.');
    const params = [companyId, entityType];
    const where = ['company_id=$1', 'entity_type=$2'];
    if (!includeDeleted) where.push('deleted_at IS NULL');
    const after = cursorDecode(cursor);
    if (after) {
      params.push(after.updatedAt, after.id);
      where.push(`(updated_at < $${params.length - 1}::timestamptz OR
        (updated_at=$${params.length - 1}::timestamptz AND record_id > $${params.length}::uuid))`);
    }
    const permitted = FILTERS[entityType];
    for (const [field, value] of Object.entries(filters || {})) {
      if (!permitted.has(field)) invalid(`Filtro ${field} não permitido para ${entityType}.`);
      if (field === 'relatedId') {
        if (!UUID.test(value)) invalid('relatedId inválido.');
        params.push(value.toLowerCase());
        where.push(`related_record_id=$${params.length}::uuid`);
      } else if (field === 'driverId' || field === 'orderId') {
        if (!UUID.test(value)) invalid(`${field} inválido.`);
        params.push(value.toLowerCase());
        where.push(`payload->>'${field}'=$${params.length}`);
      } else {
        if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${field} inválido.`);
        params.push(value.trim());
        where.push(`payload->>'status'=$${params.length}`);
      }
    }
    appendDriverScope(where, params, entityType, driverId);
    params.push(limit + 1);
    const result = await client.query(`SELECT record_id::text,payload,version,created_at,updated_at,deleted_at,
        to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor
      FROM rotamoto.domain_records d WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC,record_id ASC LIMIT $${params.length}`, params);
    const hasMore = result.rowCount > limit;
    const rows = result.rows.slice(0, limit);
    return {
      records: await Promise.all(rows.map(async row => ({ id: row.record_id, record: (await projectDriverRoute(client, companyId, { ...row, entity_type: entityType }, driverId)).payload, version: row.version,
        createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at }))),
      nextCursor: hasMore && rows.length ? cursorEncode(rows.at(-1)) : null,
      hasMore
    };
  }
  return Object.freeze({ get, list });
}

module.exports = { COLLECTIONS, FILTERS, cursorDecode, cursorEncode, appendDriverScope, createDomainQueryRepository };
