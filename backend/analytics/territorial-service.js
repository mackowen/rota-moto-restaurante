'use strict';

const crypto = require('node:crypto');
const T = require('./territorial');

function problem(code, message) { const error = new Error(message); error.code = code; throw error; }
function createTerritorialAnalyticsService({ clock = () => new Date() } = {}) {
  async function rows(client, companyId, filters) {
    const result = await client.query(`SELECT jsonb_build_object(
          'createdAt',o.payload->'createdAt','status',o.payload->'status','deliveryStatus',o.payload->'deliveryStatus',
          'type',o.payload->'type','sourceId',o.payload->'sourceId','source',o.payload->'source','channel',o.payload->'channel',
          'driverId',o.payload->'driverId','bikeId',o.payload->'bikeId','km',o.payload->'km','gpsDistanceKm',o.payload->'gpsDistanceKm',
          'deliveryFee',o.payload->'deliveryFee','deliveryFeeCurrency',o.payload->'deliveryFeeCurrency','value',o.payload->'value',
          'currency',o.payload->'currency','amountMinor',o.payload->'amountMinor','money',o.payload->'money') AS order_payload,
        jsonb_build_object('status',d.payload->'status','driverId',d.payload->'driverId','assignedAt',d.payload->'assignedAt',
          'completedAt',d.payload->'completedAt','actualDistanceM',d.payload->'actualDistanceM',
          'estimatedDistanceM',d.payload->'estimatedDistanceM') AS delivery_payload,o.created_at AS order_created_at,
        g.latitude,g.longitude,g.provenance,g.accuracy_m,g.resolved_at,
        f.mode,f.provider_id,p.code AS provider_code
      FROM rotamoto.domain_records d
      JOIN rotamoto.domain_records o ON o.company_id=d.company_id AND o.record_id=coalesce(d.related_record_id::text,d.payload->>'orderId')::uuid AND o.entity_type='Order'
      LEFT JOIN rotamoto.delivery_geo_snapshots g ON g.company_id=d.company_id AND g.delivery_id=d.record_id
      LEFT JOIN LATERAL (SELECT mode,provider_id FROM rotamoto.delivery_fulfillments f0
        WHERE f0.company_id=d.company_id AND f0.delivery_id=d.record_id AND f0.status<>'superseded'
        ORDER BY f0.revision DESC LIMIT 1) f ON true
      LEFT JOIN rotamoto.logistics_providers p ON p.company_id=d.company_id AND p.provider_id=f.provider_id
      WHERE d.company_id=$1 AND d.entity_type='Delivery' AND d.deleted_at IS NULL
        AND o.deleted_at IS NULL AND o.created_at >= $2 AND o.created_at <= $3
      ORDER BY d.record_id LIMIT $4`, [companyId, filters.start, filters.end, T.MAX_ROWS + 1]);
    if (result.rowCount > T.MAX_ROWS) problem('RECORTE_LIMIT_EXCEEDED', 'Recorte indisponível.');
    return result.rows.map(row => ({ order: row.order_payload, order_created_at:row.order_created_at, delivery: row.delivery_payload,
      latitude: row.latitude, longitude: row.longitude, provenance: row.provenance, accuracyM: row.accuracy_m,
      resolvedAt: row.resolved_at, mode: row.mode, providerId: row.provider_id, providerCode: row.provider_code }));
  }
  async function heatmap(client, principal, query) {
    const company = await client.query(`SELECT to_jsonb(c)->>'time_zone' AS time_zone FROM rotamoto.companies c WHERE c.id=$1`,[principal.company_id]);
    const now = clock();
    const filters = T.normalizeFilters(query, now, company.rows[0]?.time_zone || null);
    const data = await rows(client, principal.company_id, filters);
    const report = T.aggregate(data, filters, now.getTime());
    const seen = new Map();
    for (const item of data) if (item.providerId && item.providerCode) seen.set(item.providerId, item.providerCode);
    return { ...report, timeZone:filters.timeZone, providerFilters: [...seen.entries()].map(([id, code]) => ({ id, code })).sort((a,b) => a.code.localeCompare(b.code)) };
  }
  async function setDestination(client, principal, deliveryId, input) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (!uuid.test(deliveryId) || !input || Object.keys(input).some(key => !['latitude','longitude','accuracyM','confirmDestination','expectedVersion'].includes(key)) || input.confirmDestination !== true ||
        !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 1000000000)
      problem('INVALID_INPUT', 'Confirme que as coordenadas representam o destino da entrega.');
    const latitude = input.latitude, longitude = input.longitude, accuracy = input.accuracyM ?? null;
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 ||
        accuracy !== null && (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000))
      problem('INVALID_INPUT', 'Coordenadas ou precisão inválidas.');
    const exists = await client.query(`SELECT 1 FROM rotamoto.domain_records d
      JOIN rotamoto.domain_records o ON o.company_id=d.company_id AND o.record_id=coalesce(d.related_record_id::text,d.payload->>'orderId')::uuid AND o.entity_type='Order'
      WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Delivery' AND d.deleted_at IS NULL AND o.deleted_at IS NULL`,
    [principal.company_id, deliveryId]);
    if (!exists.rowCount) problem('NOT_FOUND', 'Entrega não encontrada.');
    const now = clock();
    const result = await client.query(`INSERT INTO rotamoto.delivery_geo_snapshots
      (company_id,delivery_id,latitude,longitude,provenance,accuracy_m,resolved_at,algorithm_version,created_by,updated_by)
      VALUES($1,$2,$3,$4,'manual',$5,$6,'destination-v1',$7,$7)
      ON CONFLICT(company_id,delivery_id) DO UPDATE SET latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,
        provenance='manual',accuracy_m=EXCLUDED.accuracy_m,resolved_at=EXCLUDED.resolved_at,
        algorithm_version='destination-v1',updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.resolved_at
      WHERE rotamoto.delivery_geo_snapshots.version=$8
      RETURNING delivery_id,provenance,accuracy_m,resolved_at,algorithm_version,version`,
    [principal.company_id, deliveryId, latitude, longitude, accuracy, now, principal.user_id, input.expectedVersion]);
    if (!result.rowCount) problem('REVISION_CONFLICT', 'Snapshot geográfico alterado em outra sessão.');
    const auditId = crypto.randomUUID();
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user','analytics.destination_snapshot.updated','delivery_geo_snapshot',$4,$5::jsonb)`,
    [auditId, principal.company_id, principal.user_id, deliveryId, JSON.stringify({ provenance: 'manual', accuracyKnown: accuracy !== null, algorithmVersion: 'destination-v1' })]);
    const row = result.rows[0];
    return { deliveryId: row.delivery_id, provenance: row.provenance, accuracyM: row.accuracy_m, resolvedAt: row.resolved_at, algorithmVersion: row.algorithm_version, version:row.version };
  }
  async function destinationStatus(client, principal, deliveryId) {
    const result=await client.query(`SELECT version,provenance,accuracy_m,resolved_at,algorithm_version
      FROM rotamoto.delivery_geo_snapshots WHERE company_id=$1 AND delivery_id=$2`,[principal.company_id,deliveryId]);
    const row=result.rows[0];
    return row?{exists:true,version:row.version,provenance:row.provenance,accuracyM:row.accuracy_m,resolvedAt:row.resolved_at,algorithmVersion:row.algorithm_version}:{exists:false,version:0};
  }
  return Object.freeze({ heatmap, setDestination, destinationStatus });
}
module.exports = { createTerritorialAnalyticsService };
