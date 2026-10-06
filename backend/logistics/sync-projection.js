'use strict';

const { uuidV7 } = require('../identity/service');
const { ACTIVE_STATUSES } = require('./domain');

async function writeAudit(client, companyId, userId, action, resourceId, details, now) {
  await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
    VALUES($1,$2,$3,'user',$4,'delivery_fulfillment',$5,$6::jsonb)`,
  [uuidV7(now.getTime()), companyId, userId, action, resourceId, JSON.stringify(details)]);
}

async function ensureInternalProvider(client, companyId, userId, now) {
  const found = await client.query(`SELECT provider_id FROM rotamoto.logistics_providers
    WHERE company_id=$1 AND code='internal_fleet'`, [companyId]);
  if (found.rowCount) return found.rows[0].provider_id;
  const providerId = uuidV7(now.getTime());
  await client.query(`INSERT INTO rotamoto.logistics_providers(company_id,provider_id,code,display_name,provider_class,enabled,capabilities,created_by,updated_by)
    VALUES($1,$2,'internal_fleet','Frota própria','internal_fleet',true,ARRAY['manual_assignment']::text[],$3,$3)`, [companyId, providerId, userId]);
  await writeAudit(client, companyId, userId, 'logistics.provider.internal_initialized', providerId,
    { code: 'internal_fleet', capabilities: ['manual_assignment'], source: 'sync_projection' }, now);
  return providerId;
}

async function projectRestaurantDriverAssignment(client, { companyId, userId, deliveryId, previousDriverId, driverId, deliveryStatus, now }) {
  if (previousDriverId === driverId && !driverId && deliveryStatus !== 'CANCELLED') return;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,402420))', [`${companyId}:fulfillment:${deliveryId}`]);
  const latest = await client.query(`SELECT fulfillment_id,provider_id,mode,driver_id,status,revision
    FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
  [companyId, deliveryId]);
  const row = latest.rows[0] || null;
  if (deliveryStatus === 'CANCELLED' && row && ACTIVE_STATUSES.includes(row.status)) {
    if (row.mode === 'external') {
      const error = new Error('Cancele/reconcilie o despacho externo antes de cancelar a Delivery.'); error.code = 'FULFILLMENT_RECONCILIATION_REQUIRED'; throw error;
    }
    const revision = Number(row.revision) + 1;
    await client.query(`UPDATE rotamoto.delivery_fulfillments SET status='cancelled',revision=$3,updated_by=$4,updated_at=$5
      WHERE company_id=$1 AND fulfillment_id=$2`, [companyId,row.fulfillment_id,revision,userId,now]);
    await writeAudit(client,companyId,userId,'logistics.fulfillment.internal_cancelled',row.fulfillment_id,
      { deliveryId, revision, reason: 'delivery_cancelled' },now);
    return;
  }
  if (driverId && row?.mode === 'internal' && row.driver_id === driverId && ACTIVE_STATUSES.includes(row.status)) return;
  if (previousDriverId !== driverId && row?.mode === 'external' && ACTIVE_STATUSES.includes(row.status)) {
    const error = new Error('Reconcilie o provider externo antes de alterar o Driver.'); error.code = 'FULFILLMENT_RECONCILIATION_REQUIRED'; throw error;
  }
  const permission = await client.query(`SELECT 1 FROM rotamoto.memberships m
    JOIN rotamoto.role_permissions rp ON rp.company_id=m.company_id AND rp.role_id=m.role_id
    WHERE m.company_id=$1 AND m.user_id=$2 AND m.status='active'
      AND rp.catalog_version=1 AND rp.permission_key='orders.manage'`, [companyId,userId]);
  if (!permission.rowCount) { const error = new Error('A atribuição de motorista exige orders.manage.'); error.code = 'FORBIDDEN'; throw error; }
  let revision = Number(row?.revision || 0);
  if (row && ACTIVE_STATUSES.includes(row.status)) {
    const nextStatus = driverId ? 'superseded' : 'cancelled';
    revision += 1;
    await client.query(`UPDATE rotamoto.delivery_fulfillments SET status=$3,revision=$4,updated_by=$5,updated_at=$6
      WHERE company_id=$1 AND fulfillment_id=$2`, [companyId,row.fulfillment_id,nextStatus,revision,userId,now]);
  }
  if (!driverId) {
    if (row && ACTIVE_STATUSES.includes(row.status)) await writeAudit(client,companyId,userId,'logistics.fulfillment.driver_unassigned',row.fulfillment_id,
      { deliveryId, previousDriverId, revision },now);
    return;
  }
  const providerId = await ensureInternalProvider(client, companyId, userId, now);
  const fulfillmentId = uuidV7(now.getTime());
  revision += 1;
  await client.query(`INSERT INTO rotamoto.delivery_fulfillments(company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,status,
    selected_at,selected_by,updated_by,revision)
    VALUES($1,$2,$3,$4,'internal',$5,'selected',$6,$7,$7,$8)`,
  [companyId,fulfillmentId,deliveryId,providerId,driverId,now,userId,revision]);
  await writeAudit(client,companyId,userId,'logistics.fulfillment.internal_projected',fulfillmentId,
    { deliveryId, providerId, previousDriverId: previousDriverId || null, driverId, revision },now);
}

async function projectInternalExecution(client, { companyId, userId, deliveryId, deliveryStatus, now }) {
  const nextStatus = ({ ACCEPTED: 'accepted', PICKED_UP: 'in_progress', OUT_FOR_DELIVERY: 'in_progress',
    ARRIVED: 'arrived', DELIVERED: 'completed', FAILED: 'failed', RETURNED: 'failed' })[deliveryStatus];
  if (!nextStatus) return;
  const current = await client.query(`SELECT fulfillment_id,status,revision FROM rotamoto.delivery_fulfillments
    WHERE company_id=$1 AND delivery_id=$2 AND mode='internal'
      AND status IN ('selected','dispatch_requested','accepted','in_progress','arrived')
    ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [companyId,deliveryId]);
  if (!current.rowCount || current.rows[0].status === nextStatus) return;
  const fulfillmentId = current.rows[0].fulfillment_id;
  const revision = Number(current.rows[0].revision) + 1;
  await client.query(`UPDATE rotamoto.delivery_fulfillments SET status=$3,revision=$4,updated_by=$5,updated_at=$6
    WHERE company_id=$1 AND fulfillment_id=$2`, [companyId,fulfillmentId,nextStatus,revision,userId,now]);
  await writeAudit(client,companyId,userId,'logistics.fulfillment.internal_event_projected',fulfillmentId,
    { deliveryId, from: current.rows[0].status, to: nextStatus, revision },now);
}

module.exports = Object.freeze({ projectRestaurantDriverAssignment, projectInternalExecution });
