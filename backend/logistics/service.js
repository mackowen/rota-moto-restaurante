'use strict';

const crypto = require('node:crypto');
const { uuidV7 } = require('../identity/service');
const D = require('./domain');

class LogisticsServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'LogisticsServiceError'; this.code = code; }
}
function fail(code, message) { throw new LogisticsServiceError(code, message); }
function asProvider(row) {
  return { id: row.provider_id, companyId: row.company_id, code: row.code, displayName: row.display_name,
    class: row.provider_class, enabled: row.enabled, capabilities: row.capabilities,
    configuration: row.configuration, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function asFulfillment(row) {
  return { id: row.fulfillment_id, deliveryId: row.delivery_id, providerId: row.provider_id,
    mode: row.mode, driverId: row.driver_id, externalReference: row.external_reference,
    status: row.status, selectedAt: row.selected_at, selectedBy: row.selected_by,
    revision: row.revision, etaAt: row.eta_at,
    estimatedCost: row.estimated_cost_minor == null ? null : { amountMinor: Number(row.estimated_cost_minor), currency: row.estimated_cost_currency },
    finalCost: row.final_cost_minor == null ? null : { amountMinor: Number(row.final_cost_minor), currency: row.final_cost_currency },
    updatedAt: row.updated_at };
}
const FIELDS = `company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,external_reference,status,selected_at,
 selected_by,revision,eta_at,estimated_cost_minor,estimated_cost_currency,final_cost_minor,final_cost_currency,updated_at`;

function createLogisticsService({ clock = () => new Date() } = {}) {
  async function audit(client, principal, action, resource, id, details) {
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user',$4,$5,$6,$7::jsonb)`,
    [uuidV7(clock().getTime()), principal.company_id, principal.user_id, action, resource, id, JSON.stringify(details)]);
  }
  async function ensureInternalProvider(client, principal) {
    const existing = await client.query(`SELECT provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at
      FROM rotamoto.logistics_providers WHERE company_id=$1 AND code='internal_fleet'`, [principal.company_id]);
    if (existing.rowCount) return asProvider(existing.rows[0]);
    const id = uuidV7(clock().getTime());
    const inserted = await client.query(`INSERT INTO rotamoto.logistics_providers
      (company_id,provider_id,code,display_name,provider_class,enabled,capabilities,created_by,updated_by)
      VALUES($1,$2,'internal_fleet','Frota própria','internal_fleet',true,ARRAY['manual_assignment']::text[],$3,$3)
      RETURNING provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at`,
    [principal.company_id, id, principal.user_id]);
    await audit(client, principal, 'logistics.provider.internal_initialized', 'logistics_provider', id,
      { code: 'internal_fleet', capabilities: ['manual_assignment'] });
    return asProvider(inserted.rows[0]);
  }
  async function listProviders(client, principal) {
    const result = await client.query(`SELECT provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at
      FROM rotamoto.logistics_providers WHERE company_id=$1 ORDER BY provider_class,display_name,provider_id`, [principal.company_id]);
    return { providers: result.rows.map(asProvider) };
  }
  async function createProvider(client, principal, input) {
    await ensureInternalProvider(client, principal);
    const code = D.validateCode(input.code), displayName = D.validateName(input.displayName);
    if (!D.PROVIDER_CLASSES.includes(input.class)) fail('INVALID_INPUT', 'Classe de provider inválida.');
    if (typeof input.enabled !== 'boolean') fail('INVALID_INPUT', 'enabled inválido.');
    const configuration = D.validateConfiguration(input.configuration);
    const id = uuidV7(clock().getTime());
    let result;
    try {
      result = await client.query(`INSERT INTO rotamoto.logistics_providers
        (company_id,provider_id,code,display_name,provider_class,enabled,capabilities,configuration,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,ARRAY['manual_assignment']::text[],$7::jsonb,$8,$8)
        RETURNING provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at`,
      [principal.company_id, id, code, displayName, input.class, input.enabled, JSON.stringify(configuration), principal.user_id]);
    } catch (error) { if (error?.code === '23505') fail('PROVIDER_CODE_CONFLICT', 'Código de provider já cadastrado nesta empresa.'); throw error; }
    await audit(client, principal, 'logistics.provider.created', 'logistics_provider', id,
      { code, class: input.class, enabled: input.enabled, capabilities: ['manual_assignment'] });
    return { provider: asProvider(result.rows[0]) };
  }
  async function updateProvider(client, principal, id, input) {
    D.uuid(id, 'providerId');
    const allowed = new Set(['displayName', 'enabled', 'configuration', 'expectedVersion']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)) ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT', 'Atualização de provider inválida.');
    const name = input.displayName === undefined ? null : D.validateName(input.displayName);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('INVALID_INPUT', 'enabled inválido.');
    const configuration = input.configuration === undefined ? null : D.validateConfiguration(input.configuration);
    const result = await client.query(`UPDATE rotamoto.logistics_providers SET
        display_name=COALESCE($4,display_name),enabled=COALESCE($5,enabled),configuration=COALESCE($6::jsonb,configuration),
        version=version+1,updated_by=$3,updated_at=now()
      WHERE company_id=$1 AND provider_id=$2 AND version=$7 AND provider_class<>'internal_fleet'
      RETURNING provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at`,
    [principal.company_id, id, principal.user_id, name, input.enabled ?? null, configuration === null ? null : JSON.stringify(configuration), input.expectedVersion]);
    if (!result.rowCount) fail('REVISION_CONFLICT', 'Provider inexistente ou alterado por outra sessão.');
    await audit(client, principal, 'logistics.provider.updated', 'logistics_provider', id,
      { version: result.rows[0].version, enabled: result.rows[0].enabled });
    return { provider: asProvider(result.rows[0]) };
  }
  async function getFulfillment(client, principal, deliveryId) {
    D.uuid(deliveryId, 'deliveryId');
    const delivery = await client.query(`SELECT payload,version FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL`, [principal.company_id, deliveryId]);
    if (!delivery.rowCount) fail('NOT_FOUND', 'Entrega não encontrada.');
    const rows = await client.query(`SELECT ${FIELDS} FROM rotamoto.delivery_fulfillments
      WHERE company_id=$1 AND delivery_id=$2 ORDER BY revision DESC LIMIT 20`, [principal.company_id, deliveryId]);
    const attempts = rows.rowCount ? await client.query(`SELECT attempt_id,fulfillment_id,provider_id,status,requested_at,responded_at,
      external_reference,error_code,retry_count FROM rotamoto.dispatch_attempts WHERE company_id=$1 AND delivery_id=$2
      ORDER BY requested_at DESC LIMIT 20`, [principal.company_id, deliveryId]) : { rows: [] };
    const orderId = delivery.rows[0].payload.orderId;
    const order = orderId ? await client.query(`SELECT payload FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Order' AND deleted_at IS NULL`, [principal.company_id, orderId]) : { rows: [] };
    return { delivery: { id: deliveryId, status: delivery.rows[0].payload.status, version: delivery.rows[0].version,
      driverId: delivery.rows[0].payload.driverId || null, orderSource: order.rows[0]?.payload?.source ?? null }, fulfillments: rows.rows.map(asFulfillment), attempts: attempts.rows.map(row => ({
      id: row.attempt_id, fulfillmentId: row.fulfillment_id, providerId: row.provider_id, status: row.status,
      requestedAt: row.requested_at, respondedAt: row.responded_at, externalReference: row.external_reference,
      errorCode: row.error_code, retryCount: row.retry_count })) };
  }
  async function emitDelivery(client, principal, row, oldDriverId = null) {
    const installation = await client.query(`SELECT id FROM rotamoto.sync_installations
      WHERE company_id=$1 AND app_key='restaurante' ORDER BY last_seen_at DESC LIMIT 1`, [principal.company_id]);
    if (!installation.rowCount) fail('INSTALLATION_REQUIRED', 'Sincronize o painel Restaurante antes de alterar o fulfillment.');
    const installationId = installation.rows[0].id;
    const eventId = uuidV7(clock().getTime());
    const payload = { ...row.payload, id: row.record_id, companyId: principal.company_id,
      version: row.version, updatedAt: row.updated_at.toISOString() };
    const event = { eventId, type: 'CANONICAL_RECORD_UPSERTED', entity: 'Delivery', entityId: row.record_id,
      occurredAt: row.updated_at.toISOString(), actor: { type: 'user', id: principal.user_id }, payload, protocolVersion: 1 };
    await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,payload)
      VALUES($1,$2,'restaurante',$3,$4::jsonb)`, [principal.company_id, eventId, installationId, JSON.stringify(event)]);
    if (oldDriverId) {
      const revokeId = uuidV7(clock().getTime());
      const revoke = { eventId: revokeId, type: 'CANONICAL_ASSIGNMENT_REVOKED', entity: 'Delivery', entityId: row.record_id,
        occurredAt: row.updated_at.toISOString(), actor: { type: 'user', id: principal.user_id },
        payload: { id: row.record_id, companyId: principal.company_id, version: row.version, updatedAt: row.updated_at.toISOString() }, protocolVersion: 1 };
      await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,recipient_driver_id,payload)
        VALUES($1,$2,'restaurante',$3,$4,$5::jsonb)`, [principal.company_id, revokeId, installationId, oldDriverId, JSON.stringify(revoke)]);
    }
  }
  async function selectFulfillment(client, principal, deliveryId, input) {
    const allowed = new Set(['providerId','mode','driverId','fulfillmentId','expectedRevision','externalReference','etaAt','estimatedCostMinor','estimatedCostCurrency']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key))) fail('INVALID_INPUT', 'Seleção de fulfillment inválida.');
    D.uuid(deliveryId, 'deliveryId'); D.uuid(input.providerId, 'providerId'); D.uuid(input.fulfillmentId, 'fulfillmentId');
    if (!['internal','external'].includes(input.mode) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail('INVALID_INPUT', 'Modo/revisão inválidos.');
    if (input.mode === 'internal') D.uuid(input.driverId, 'driverId');
    else if (input.driverId != null) fail('INVALID_INPUT', 'Fulfillment externo não pode referenciar Driver.');
    if (input.externalReference != null && (typeof input.externalReference !== 'string' || !input.externalReference.trim() || Buffer.byteLength(input.externalReference.trim()) > 160 || /[\u0000-\u001f\u007f]/u.test(input.externalReference))) fail('INVALID_INPUT', 'Referência externa inválida.');
    if (input.etaAt != null && (typeof input.etaAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/u.test(input.etaAt) || !Number.isFinite(Date.parse(input.etaAt)))) fail('INVALID_INPUT', 'ETA inválido.');
    const estimated = input.estimatedCostMinor === undefined && input.estimatedCostCurrency === undefined ? null : D.safeMoney(input.estimatedCostMinor, input.estimatedCostCurrency, 'estimatedCost');
    const deliveryResult = await client.query(`SELECT record_id::text,payload,version,created_at FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL FOR UPDATE`, [principal.company_id, deliveryId]);
    if (!deliveryResult.rowCount) fail('NOT_FOUND', 'Entrega não encontrada.');
    const deliveryRow = deliveryResult.rows[0], status = deliveryRow.payload.status;
    if (!['CREATED','ASSIGNED','REDELIVERY'].includes(status)) fail('INVALID_STATE_TRANSITION', 'Entrega deve estar criada, atribuída ou em reentrega antes de trocar de provider.');
    const providerResult = await client.query(`SELECT provider_id,provider_class,enabled FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_id=$2 FOR UPDATE`, [principal.company_id, input.providerId]);
    if (!providerResult.rowCount || !providerResult.rows[0].enabled) fail('PROVIDER_UNAVAILABLE', 'Provider não encontrado ou desativado.');
    const provider = providerResult.rows[0];
    if ((input.mode === 'internal' && provider.provider_class !== 'internal_fleet') || (input.mode === 'external' && provider.provider_class === 'internal_fleet')) fail('INVALID_INPUT', 'Modo incompatível com provider.');
    if (input.mode === 'internal') {
      const driver = await client.query(`SELECT 1 FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Driver' AND deleted_at IS NULL`, [principal.company_id, input.driverId]);
      if (!driver.rowCount) fail('INVALID_DRIVER', 'Motoboy não pertence a esta empresa ou está removido.');
    } else {
      const route = await client.query(`SELECT 1 FROM rotamoto.domain_records r WHERE r.company_id=$1 AND r.entity_type='Route' AND r.deleted_at IS NULL
        AND r.payload->>'status' IN ('PLANNED','ACTIVE','IN_PROGRESS') AND jsonb_typeof(r.payload->'deliveryIds')='array'
        AND r.payload->'deliveryIds' ? $2 LIMIT 1`, [principal.company_id, deliveryId]);
      if (route.rowCount) fail('DELIVERY_IN_ACTIVE_ROUTE', 'Remova a entrega da rota da frota própria antes de selecionar um provider externo.');
    }
    const previous = await client.query(`SELECT ${FIELDS} FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2
      ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [principal.company_id, deliveryId]);
    const revision = previous.rowCount ? Number(previous.rows[0].revision) : 0;
    if (revision !== input.expectedRevision) fail('REVISION_CONFLICT', 'A alocação mudou. Atualize a tela e tente novamente.');
    if (previous.rowCount && previous.rows[0].mode === 'external' && D.ACTIVE_STATUSES.includes(previous.rows[0].status))
      fail('FULFILLMENT_RECONCILIATION_REQUIRED', 'Registre cancelamento/falha do provider atual antes de reatribuir a entrega.');
    const duplicate = await client.query(`SELECT ${FIELDS} FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND fulfillment_id=$2`, [principal.company_id, input.fulfillmentId]);
    if (duplicate.rowCount) {
      const existing = duplicate.rows[0];
      if (existing.delivery_id === deliveryId && existing.provider_id === input.providerId && existing.mode === input.mode &&
          existing.driver_id === (input.driverId || null) && existing.external_reference === (input.externalReference?.trim() || null) &&
          existing.revision === revision + (previous.rowCount && D.ACTIVE_STATUSES.includes(previous.rows[0].status) ? 2 : 1))
        return { fulfillment: asFulfillment(existing), duplicate: true };
      fail('IDEMPOTENCY_CONFLICT', 'Identificador de alocação já utilizado.');
    }
    const oldDriverId = deliveryRow.payload.driverId || null;
    if (previous.rowCount && D.ACTIVE_STATUSES.includes(previous.rows[0].status)) {
      await client.query(`UPDATE rotamoto.delivery_fulfillments SET status='superseded',revision=revision+1,updated_by=$3,updated_at=now()
        WHERE company_id=$1 AND fulfillment_id=$2`, [principal.company_id, previous.rows[0].fulfillment_id, principal.user_id]);
    }
    const nextRevision = revision + (previous.rowCount && D.ACTIVE_STATUSES.includes(previous.rows[0].status) ? 2 : 1);
    const now = clock();
    const result = await client.query(`INSERT INTO rotamoto.delivery_fulfillments
      (company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,external_reference,status,selected_at,selected_by,updated_by,revision,eta_at,
       estimated_cost_minor,estimated_cost_currency)
      VALUES($1,$2,$3,$4,$5,$6,$7,'selected',$8,$9,$9,$10,$11,$12,$13) RETURNING ${FIELDS}`,
    [principal.company_id, input.fulfillmentId, deliveryId, input.providerId, input.mode, input.mode === 'internal' ? input.driverId : null,
      input.mode === 'external' ? (input.externalReference?.trim() || null) : null, now, principal.user_id, nextRevision,
      input.etaAt || null, estimated?.amountMinor ?? null, estimated?.currency ?? null]);
    const nextStatus = 'ASSIGNED';
    const payload = { ...deliveryRow.payload, driverId: input.mode === 'internal' ? input.driverId : null,
      assignedAt: now.toISOString(), status: nextStatus, updatedAt: now.toISOString(), version: Number(deliveryRow.version) + 1 };
    const updated = await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' RETURNING record_id::text,payload,version,updated_at`,
    [principal.company_id, deliveryId, JSON.stringify(payload), payload.version, now]);
    await emitDelivery(client, principal, updated.rows[0], oldDriverId && oldDriverId !== payload.driverId ? oldDriverId : null);
    await audit(client, principal, 'logistics.fulfillment.selected', 'delivery_fulfillment', input.fulfillmentId,
      { deliveryId, providerId: input.providerId, mode: input.mode, status: 'selected', revision: nextRevision });
    return { fulfillment: asFulfillment(result.rows[0]), duplicate: false };
  }
  async function requestDispatch(client, principal, deliveryId, input) {
    D.uuid(deliveryId, 'deliveryId');
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['idempotencyKey','externalReference'].includes(k)) ||
        typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.idempotencyKey)) fail('INVALID_INPUT', 'Pedido manual de despacho inválido.');
    const fulfillment = await client.query(`SELECT ${FIELDS} FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2
      AND status IN ('selected','dispatch_requested') ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [principal.company_id, deliveryId]);
    if (!fulfillment.rowCount || fulfillment.rows[0].mode !== 'external') fail('INVALID_STATE_TRANSITION', 'Somente alocação externa selecionada pode receber pedido de despacho.');
    const row = fulfillment.rows[0], digest = D.requestDigest({ deliveryId, fulfillmentId: row.fulfillment_id, externalReference: input.externalReference || null });
    const prior = await client.query(`SELECT attempt_id,request_digest,status FROM rotamoto.dispatch_attempts
      WHERE company_id=$1 AND provider_id=$2 AND idempotency_key=$3`, [principal.company_id, row.provider_id, input.idempotencyKey]);
    if (prior.rowCount) {
      if (!Buffer.from(prior.rows[0].request_digest).equals(digest)) fail('IDEMPOTENCY_CONFLICT', 'Chave de idempotência reutilizada com outro pedido.');
      return { attemptId: prior.rows[0].attempt_id, status: prior.rows[0].status, duplicate: true };
    }
    const n = await client.query('SELECT COALESCE(max(attempt_number),0)::int+1 AS n FROM rotamoto.dispatch_attempts WHERE company_id=$1 AND fulfillment_id=$2', [principal.company_id, row.fulfillment_id]);
    const attemptId = uuidV7(clock().getTime());
    const ref = input.externalReference == null ? null : String(input.externalReference).trim();
    if (ref && (Buffer.byteLength(ref) > 160 || /[\u0000-\u001f\u007f]/u.test(ref))) fail('INVALID_INPUT', 'Referência externa inválida.');
    await client.query(`INSERT INTO rotamoto.dispatch_attempts(company_id,attempt_id,fulfillment_id,delivery_id,provider_id,idempotency_key,request_digest,attempt_number,status,
      external_reference,estimated_cost_minor,estimated_cost_currency,eta_at,requested_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'requested',$9,$10,$11,$12,$13)`,
    [principal.company_id, attemptId, row.fulfillment_id, deliveryId, row.provider_id, input.idempotencyKey, digest, n.rows[0].n,
      ref || row.external_reference, row.estimated_cost_minor, row.estimated_cost_currency, row.eta_at, principal.user_id]);
    await client.query(`UPDATE rotamoto.delivery_fulfillments SET status='dispatch_requested',revision=revision+1,external_reference=COALESCE($3,external_reference),updated_by=$4,updated_at=now()
      WHERE company_id=$1 AND fulfillment_id=$2`, [principal.company_id, row.fulfillment_id, ref || null, principal.user_id]);
    await audit(client, principal, 'logistics.dispatch.requested', 'dispatch_attempt', attemptId,
      { deliveryId, providerId: row.provider_id, status: 'requested', attempt: n.rows[0].n });
    return { attemptId, status: 'requested', duplicate: false };
  }
  async function updateFulfillment(client, principal, deliveryId, input) {
    const patch = D.validateFulfillmentPatch(input);
    const current = await client.query(`SELECT ${FIELDS} FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2
      AND status IN ('selected','dispatch_requested','accepted','in_progress','arrived','completed') ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [principal.company_id, deliveryId]);
    if (!current.rowCount) fail('NOT_FOUND', 'Alocação ativa não encontrada.');
    const row = current.rows[0];
    if (row.revision !== patch.expectedRevision) fail('REVISION_CONFLICT', 'A alocação mudou. Atualize a tela e tente novamente.');
    if (row.mode !== 'external') fail('INVALID_STATE_TRANSITION', 'Esta atualização manual é somente para provider externo.');
    if (row.status === 'completed' && patch.status !== undefined) fail('INVALID_STATE_TRANSITION', 'Uma entrega externa concluída só aceita reconciliação de metadados/custo.');
    if (patch.status !== undefined) D.assertFulfillmentTransition(row.status, patch.status);
    const status = patch.status ?? row.status;
    if (patch.finalCostMinor !== undefined && status !== 'completed') fail('INVALID_INPUT', 'Custo final só pode ser registrado ao concluir/reconciliar.');
    const next = await client.query(`UPDATE rotamoto.delivery_fulfillments SET status=$3,external_reference=CASE WHEN $4 THEN $5 ELSE external_reference END,eta_at=CASE WHEN $6 THEN $7::timestamptz ELSE eta_at END,
       estimated_cost_minor=CASE WHEN $8 THEN $9 ELSE estimated_cost_minor END,estimated_cost_currency=CASE WHEN $8 THEN $10 ELSE estimated_cost_currency END,
       final_cost_minor=CASE WHEN $11 THEN $12 ELSE final_cost_minor END,final_cost_currency=CASE WHEN $11 THEN $13 ELSE final_cost_currency END,
       revision=revision+1,updated_by=$14,updated_at=now() WHERE company_id=$1 AND fulfillment_id=$2 RETURNING ${FIELDS}`,
    [principal.company_id, row.fulfillment_id, status, Object.hasOwn(patch, 'externalReference'), patch.externalReference ?? null,
      Object.hasOwn(patch, 'etaAt'), patch.etaAt ?? null, Object.hasOwn(patch, 'estimatedCostMinor'), patch.estimatedCostMinor ?? null,
      patch.estimatedCostCurrency ?? null, Object.hasOwn(patch, 'finalCostMinor'), patch.finalCostMinor ?? null,
      patch.finalCostCurrency ?? null, principal.user_id]);
    const delivery = status === row.status ? { rowCount: 0, rows: [] } : await client.query(`SELECT payload,version,created_at FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL FOR UPDATE`, [principal.company_id, deliveryId]);
    if (status !== row.status && !delivery.rowCount) fail('NOT_FOUND', 'Entrega não encontrada.');
    const now = clock();
    if (status !== row.status) {
      const priorDeliveryStatus = delivery.rows[0].payload.status;
      let deliveryStatus = priorDeliveryStatus;
      if (status === 'completed') deliveryStatus = 'DELIVERED';
      else if (['failed','cancelled'].includes(status) && ['OUT_FOR_DELIVERY','ARRIVED'].includes(priorDeliveryStatus)) deliveryStatus = 'FAILED';
      else if (['failed','cancelled'].includes(status) && !['DELIVERED','CANCELLED'].includes(priorDeliveryStatus)) deliveryStatus = 'ASSIGNED';
      const payload = { ...delivery.rows[0].payload, driverId: null, status: deliveryStatus, updatedAt: now.toISOString(), version: Number(delivery.rows[0].version) + 1 };
      if (status === 'completed') payload.completedAt = now.toISOString();
      const updated = await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=$4,updated_at=$5 WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'
        RETURNING record_id::text,payload,version,updated_at`, [principal.company_id, deliveryId, JSON.stringify(payload), payload.version, now]);
      await emitDelivery(client, principal, updated.rows[0]);
    }
    await audit(client, principal, 'logistics.fulfillment.updated', 'delivery_fulfillment', row.fulfillment_id,
      { deliveryId, providerId: row.provider_id, from: row.status, to: status, revision: next.rows[0].revision,
        costReconciled: Object.hasOwn(patch, 'finalCostMinor') });
    const attemptStatus = ({ accepted: 'accepted', completed: 'completed', failed: 'failed', cancelled: 'cancelled' })[status];
    if (attemptStatus) await client.query(`UPDATE rotamoto.dispatch_attempts SET status=$3,responded_at=now()
      WHERE company_id=$1 AND attempt_id=(SELECT attempt_id FROM rotamoto.dispatch_attempts
        WHERE company_id=$1 AND fulfillment_id=$2 ORDER BY attempt_number DESC LIMIT 1)
        AND status IN ('requested','accepted')`, [principal.company_id, row.fulfillment_id, attemptStatus]);
    return { fulfillment: asFulfillment(next.rows[0]) };
  }
  async function analytics(client, principal) {
    const result = await client.query(`SELECT p.provider_class, f.provider_id, p.code, p.display_name,
      count(*)::int AS allocations, count(*) FILTER (WHERE f.mode='internal')::int AS internal_count,
      count(*) FILTER (WHERE f.mode='external')::int AS external_count,
      count(*) FILTER (WHERE f.status='completed')::int AS completed_count,
      count(*) FILTER (WHERE f.estimated_cost_minor IS NOT NULL)::int AS estimated_cost_count,
      count(*) FILTER (WHERE f.final_cost_minor IS NOT NULL)::int AS reconciled_cost_count,
      COALESCE(jsonb_agg(jsonb_build_object('currency',f.estimated_cost_currency,'amountMinor',f.estimated_cost_minor)
        ORDER BY f.estimated_cost_currency) FILTER (WHERE f.estimated_cost_minor IS NOT NULL),'[]'::jsonb) AS estimated_costs,
      COALESCE(jsonb_agg(jsonb_build_object('currency',f.final_cost_currency,'amountMinor',f.final_cost_minor)
        ORDER BY f.final_cost_currency) FILTER (WHERE f.final_cost_minor IS NOT NULL),'[]'::jsonb) AS reconciled_costs
      FROM rotamoto.delivery_fulfillments f JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
      WHERE f.company_id=$1 AND f.status<>'superseded' GROUP BY p.provider_class,f.provider_id,p.code,p.display_name ORDER BY p.provider_class,p.display_name`, [principal.company_id]);
    return { providers: result.rows.map(row => ({ providerId: row.provider_id, code: row.code, displayName: row.display_name,
      class: row.provider_class, allocations: row.allocations, internal: row.internal_count, external: row.external_count,
      completed: row.completed_count, estimatedCostCount: row.estimated_cost_count, estimatedCostCoverage: row.allocations ? row.estimated_cost_count / row.allocations : null,
      estimatedCosts: row.estimated_costs, reconciledCostCount: row.reconciled_cost_count,
      reconciledCostCoverage: row.allocations ? row.reconciled_cost_count / row.allocations : null, reconciledCosts: row.reconciled_costs })) };
  }
  return Object.freeze({ ensureInternalProvider, listProviders, createProvider, updateProvider, getFulfillment, selectFulfillment, requestDispatch, updateFulfillment, analytics });
}
module.exports = { LogisticsServiceError, createLogisticsService };
