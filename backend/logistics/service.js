'use strict';

const crypto = require('node:crypto');
const { uuidV7 } = require('../identity/service');
const D = require('./domain');
const { createProviderIntegrationService } = require('./provider-integration');

class LogisticsServiceError extends Error {
  constructor(code, message) { super(message); this.name = 'LogisticsServiceError'; this.code = code; }
}
function fail(code, message) { throw new LogisticsServiceError(code, message); }
function asProvider(row) {
  return { id: row.provider_id, companyId: row.company_id, code: row.code, displayName: row.display_name,
    class: row.provider_class, enabled: row.enabled, capabilities: row.capabilities,
    integrationMode: row.integration_mode || 'manual', apiEnabled: row.api_enabled === true,
    credentialConfigured: row.api_enabled === true, webhookConfigured: false,
    lastConnectionTestAt: row.last_connection_test_at || null, lastConnectionTestStatus: row.last_connection_test_status || 'not_configured',
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

function createLogisticsService({ clock = () => new Date(), providerIntegration = createProviderIntegrationService({ clock }) } = {}) {
  async function audit(client, principal, action, resource, id, details) {
    await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES($1,$2,$3,'user',$4,$5,$6,$7::jsonb)`,
    [uuidV7(clock().getTime()), principal.company_id, principal.user_id, action, resource, id, JSON.stringify(details)]);
  }
  async function ensureInternalProvider(client, principal) {
    const existing = await client.query(`SELECT provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at,integration_mode,api_enabled,last_connection_test_at,last_connection_test_status
      FROM rotamoto.logistics_providers WHERE company_id=$1 AND code='internal_fleet'`, [principal.company_id]);
    if (existing.rowCount) return asProvider(existing.rows[0]);
    const id = uuidV7(clock().getTime());
    const inserted = await client.query(`INSERT INTO rotamoto.logistics_providers
      (company_id,provider_id,code,display_name,provider_class,enabled,capabilities,created_by,updated_by)
      VALUES($1,$2,'internal_fleet','Frota própria','internal_fleet',true,ARRAY['manual_assignment']::text[],$3,$3)
      RETURNING provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at,integration_mode,api_enabled,last_connection_test_at,last_connection_test_status`,
    [principal.company_id, id, principal.user_id]);
    await audit(client, principal, 'logistics.provider.internal_initialized', 'logistics_provider', id,
      { code: 'internal_fleet', capabilities: ['manual_assignment'] });
    return asProvider(inserted.rows[0]);
  }
  async function listProviders(client, principal) {
    const result = await client.query(`SELECT provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at,integration_mode,api_enabled,last_connection_test_at,last_connection_test_status
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
    const allowed = new Set(['displayName', 'enabled', 'configuration', 'integrationMode', 'expectedVersion']);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.has(key)) ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail('INVALID_INPUT', 'Atualização de provider inválida.');
    const name = input.displayName === undefined ? null : D.validateName(input.displayName);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') fail('INVALID_INPUT', 'enabled inválido.');
    if (input.integrationMode !== undefined && !['manual','api'].includes(input.integrationMode)) fail('INVALID_INPUT', 'Modo de integração inválido.');
    const configuration = input.configuration === undefined ? null : D.validateConfiguration(input.configuration);
    const result = await client.query(`UPDATE rotamoto.logistics_providers SET
        display_name=COALESCE($4,display_name),enabled=COALESCE($5,enabled),configuration=COALESCE($6::jsonb,configuration),
        integration_mode=COALESCE($7,integration_mode),version=version+1,updated_by=$3,updated_at=now()
      WHERE company_id=$1 AND provider_id=$2 AND version=$8 AND provider_class<>'internal_fleet'
        AND (COALESCE($7,integration_mode)<>'api' OR code='ifood')
      RETURNING provider_id,company_id,code,display_name,provider_class,enabled,capabilities,configuration,version,created_at,updated_at,integration_mode,api_enabled,last_connection_test_at,last_connection_test_status`,
    [principal.company_id, id, principal.user_id, name, input.enabled ?? null, configuration === null ? null : JSON.stringify(configuration), input.integrationMode ?? null, input.expectedVersion]);
    if (!result.rowCount) fail('REVISION_CONFLICT', 'Provider inexistente ou alterado por outra sessão.');
    await audit(client, principal, 'logistics.provider.updated', 'logistics_provider', id,
      { version: result.rows[0].version, enabled: result.rows[0].enabled, integrationMode: result.rows[0].integration_mode });
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
    const tracking = await client.query(`SELECT s.fulfillment_id,s.provider_id,s.status,s.eta_at,s.provider_updated_at,s.provenance
      FROM rotamoto.provider_tracking_snapshots s WHERE s.company_id=$1 AND s.delivery_id=$2 ORDER BY s.provider_updated_at DESC NULLS LAST LIMIT 1`,
    [principal.company_id,deliveryId]);
    return { delivery: { id: deliveryId, status: delivery.rows[0].payload.status, version: delivery.rows[0].version,
      driverId: delivery.rows[0].payload.driverId || null, orderSource: order.rows[0]?.payload?.source ?? null }, fulfillments: rows.rows.map(asFulfillment), attempts: attempts.rows.map(row => ({
      id: row.attempt_id, fulfillmentId: row.fulfillment_id, providerId: row.provider_id, status: row.status,
      requestedAt: row.requested_at, respondedAt: row.responded_at, externalReference: row.external_reference,
      errorCode: row.error_code, retryCount: row.retry_count })), tracking: tracking.rows[0] ? { providerId: tracking.rows[0].provider_id,
        status: tracking.rows[0].status, etaAt: tracking.rows[0].eta_at, updatedAt: tracking.rows[0].provider_updated_at,
        provenance: tracking.rows[0].provenance } : null };
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
    const integration = await client.query(`WITH commands AS (
      SELECT c.provider_id,count(*) FILTER(WHERE operation='QUOTE_REQUEST')::int AS quote_requests,
        count(*) FILTER(WHERE operation='DISPATCH_REQUEST')::int AS dispatch_requested,
        count(*) FILTER(WHERE operation='DISPATCH_REQUEST' AND c.status='rejected')::int AS dispatch_failed,
        count(*) FILTER(WHERE operation='DISPATCH_REQUEST' AND c.status='unknown_outcome')::int AS dispatch_unknown,
        count(*) FILTER(WHERE operation='CANCEL_REQUEST')::int AS cancellation_requests,
        count(*) FILTER(WHERE operation='CANCEL_REQUEST' AND c.status='unknown_outcome')::int AS cancellation_unknown,
        count(*) FILTER(WHERE operation='RECONCILE')::int AS reconciliation_requests,
        count(*) FILTER(WHERE c.status='needs_review')::int AS operator_review,
        COALESCE(sum(GREATEST(attempts-1,0)),0)::int AS retries,
        count(a.attempt_id) FILTER(WHERE operation='DISPATCH_REQUEST' AND a.status IN ('accepted','completed'))::int AS dispatch_confirmed
      FROM rotamoto.provider_command_outbox c LEFT JOIN rotamoto.dispatch_attempts a
        ON a.company_id=c.company_id AND a.attempt_id=(c.payload->>'dispatchAttemptId')::uuid
      WHERE c.company_id=$1 GROUP BY c.provider_id
    ), quotes AS (
      SELECT provider_id,count(*)::int AS received,count(*) FILTER(WHERE status='selected')::int AS selected,
        count(*) FILTER(WHERE expires_at<=now() AND status<>'selected')::int AS expired
      FROM rotamoto.provider_quotes WHERE company_id=$1 GROUP BY provider_id
    ) SELECT p.provider_id,p.code,COALESCE(c.quote_requests,0)::int AS quote_requests,
      COALESCE(q.received,0)::int AS quotes_received,COALESCE(q.selected,0)::int AS quotes_selected,COALESCE(q.expired,0)::int AS quotes_expired,
      COALESCE(c.dispatch_requested,0)::int AS dispatch_requested,COALESCE(c.dispatch_confirmed,0)::int AS dispatch_confirmed,
      COALESCE(c.dispatch_failed,0)::int AS dispatch_failed,COALESCE(c.dispatch_unknown,0)::int AS dispatch_unknown,
      COALESCE(c.cancellation_requests,0)::int AS cancellation_requests,COALESCE(c.cancellation_unknown,0)::int AS cancellation_unknown,
      COALESCE(c.retries,0)::int AS retries,COALESCE(c.reconciliation_requests,0)::int AS reconciliation_requests,
      COALESCE(c.operator_review,0)::int AS operator_review
      FROM rotamoto.logistics_providers p LEFT JOIN commands c USING(provider_id) LEFT JOIN quotes q USING(provider_id)
      WHERE p.company_id=$1 ORDER BY p.code`, [principal.company_id]);
    return { providers: result.rows.map(row => ({ providerId: row.provider_id, code: row.code, displayName: row.display_name,
      class: row.provider_class, allocations: row.allocations, internal: row.internal_count, external: row.external_count,
      completed: row.completed_count, estimatedCostCount: row.estimated_cost_count, estimatedCostCoverage: row.allocations ? row.estimated_cost_count / row.allocations : null,
      estimatedCosts: row.estimated_costs, reconciledCostCount: row.reconciled_cost_count,
      reconciledCostCoverage: row.allocations ? row.reconciled_cost_count / row.allocations : null, reconciledCosts: row.reconciled_costs })),
      integrations: integration.rows.map(row => ({ providerId: row.provider_id, code: row.code, quoteRequests: row.quote_requests,
        quotesReceived: row.quotes_received, quotesSelected: row.quotes_selected, quotesExpired: row.quotes_expired,
        dispatchRequested: row.dispatch_requested, dispatchConfirmed: row.dispatch_confirmed, dispatchFailed: row.dispatch_failed,
        dispatchUnknown: row.dispatch_unknown, cancellationRequests: row.cancellation_requests,
        cancellationUnknown: row.cancellation_unknown, retries: row.retries, reconciliationRequests: row.reconciliation_requests,
        operatorReview: row.operator_review })) };
  }
  async function requestProviderQuote(client, principal, deliveryId, input) {
    D.uuid(deliveryId, 'deliveryId'); D.uuid(input?.providerId, 'providerId');
    if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) fail('INVALID_INPUT', 'Chave de cotação inválida.');
    const delivery = await client.query(`SELECT 1 FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' AND deleted_at IS NULL`, [principal.company_id, deliveryId]);
    if (!delivery.rowCount) fail('NOT_FOUND', 'Entrega não encontrada.');
    const queued = await providerIntegration.enqueue(client, principal, { providerId: input.providerId, deliveryId, operation: 'QUOTE_REQUEST', requestKey: input.idempotencyKey, payload: { deliveryId } });
    await audit(client, principal, 'logistics.provider.quote_requested', 'provider_command', queued.command.command_id,
      { deliveryId, providerId: input.providerId, duplicate: queued.duplicate });
    return { commandId: queued.command.command_id, status: queued.command.status, duplicate: queued.duplicate };
  }
  async function listProviderQuotes(client, principal, deliveryId) {
    D.uuid(deliveryId, 'deliveryId');
    const result = await client.query(`SELECT q.quote_id,q.provider_id,p.code,p.display_name,q.external_quote_id,q.status,q.currency,q.amount_minor,q.eta_at,q.issued_at,q.expires_at,q.selected_at,q.version
      FROM rotamoto.provider_quotes q JOIN rotamoto.logistics_providers p USING(company_id,provider_id)
      WHERE q.company_id=$1 AND q.delivery_id=$2 ORDER BY q.created_at DESC LIMIT 50`, [principal.company_id, deliveryId]);
    return { quotes: result.rows.map(row => ({ id: row.quote_id, providerId: row.provider_id, provider: row.code, providerName: row.display_name,
      status: row.status, currency: row.currency, amountMinor: Number(row.amount_minor), etaAt: row.eta_at, issuedAt: row.issued_at,
      expiresAt: row.expires_at, selectedAt: row.selected_at, version: row.version })) };
  }
  async function selectProviderQuote(client, principal, deliveryId, input) {
    D.uuid(deliveryId, 'deliveryId'); D.uuid(input?.quoteId, 'quoteId'); D.uuid(input?.fulfillmentId, 'fulfillmentId');
    if (!Number.isSafeInteger(input.expectedQuoteVersion) || !Number.isSafeInteger(input.expectedRevision)) fail('INVALID_INPUT', 'Revisão da cotação inválida.');
    const selected = await providerIntegration.selectQuote(client, principal, input.quoteId, input.expectedQuoteVersion);
    if (selected.delivery_id !== deliveryId) fail('NOT_FOUND', 'Cotação não encontrada para esta entrega.');
    const current = await client.query(`SELECT ${FIELDS} FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2
      AND mode='external' AND status IN ('selected','dispatch_requested') ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [principal.company_id,deliveryId]);
    let fulfillment;
    if (current.rowCount && current.rows[0].provider_id === selected.provider_id) {
      const row = current.rows[0];
      if (row.revision !== input.expectedRevision) fail('REVISION_CONFLICT', 'A alocação mudou. Atualize a tela.');
      const updated = await client.query(`UPDATE rotamoto.delivery_fulfillments SET quote_amount_minor=$3,quote_currency=$4,
        estimated_cost_minor=$3,estimated_cost_currency=$4,eta_at=$5,revision=revision+1,updated_by=$6,updated_at=now()
        WHERE company_id=$1 AND fulfillment_id=$2 RETURNING ${FIELDS}`,
      [principal.company_id,row.fulfillment_id,selected.amount_minor,selected.currency,selected.eta_at,principal.user_id]);
      fulfillment = { fulfillment: asFulfillment(updated.rows[0]), duplicate: false };
      await client.query(`UPDATE rotamoto.provider_quotes SET fulfillment_id=$3 WHERE company_id=$1 AND quote_id=$2`, [principal.company_id,input.quoteId,row.fulfillment_id]);
    } else {
      if (current.rowCount) fail('FULFILLMENT_RECONCILIATION_REQUIRED', 'Encerre o provider atual antes de selecionar outra cotação.');
      fulfillment = await selectFulfillment(client, principal, deliveryId, { providerId: selected.provider_id, mode: 'external', driverId: null,
        fulfillmentId: input.fulfillmentId, expectedRevision: input.expectedRevision, externalReference: null, etaAt: selected.eta_at?.toISOString?.() || null,
        estimatedCostMinor: Number(selected.amount_minor), estimatedCostCurrency: selected.currency });
      await client.query(`UPDATE rotamoto.delivery_fulfillments SET quote_amount_minor=$3,quote_currency=$4 WHERE company_id=$1 AND fulfillment_id=$2`,
        [principal.company_id,input.fulfillmentId,selected.amount_minor,selected.currency]);
      await client.query(`UPDATE rotamoto.provider_quotes SET fulfillment_id=$3 WHERE company_id=$1 AND quote_id=$2`, [principal.company_id,input.quoteId,input.fulfillmentId]);
    }
    await audit(client, principal, 'logistics.provider.quote_selected', 'provider_quote', input.quoteId,
      { deliveryId, providerId: selected.provider_id, fulfillmentId: input.fulfillmentId, currency: selected.currency, amountMinor: Number(selected.amount_minor) });
    return { quoteId: input.quoteId, fulfillment: fulfillment.fulfillment };
  }
  async function requestProviderDispatch(client, principal, deliveryId, input) {
    D.uuid(deliveryId, 'deliveryId'); D.uuid(input?.quoteId, 'quoteId');
    const quote = await client.query(`SELECT quote_id,provider_id,fulfillment_id,status,expires_at FROM rotamoto.provider_quotes WHERE company_id=$1 AND delivery_id=$2 AND quote_id=$3`, [principal.company_id, deliveryId, input.quoteId]);
    if (!quote.rowCount || quote.rows[0].status !== 'selected' || !quote.rows[0].fulfillment_id || quote.rows[0].expires_at <= clock()) fail('INVALID_STATE_TRANSITION', 'Selecione uma cotação válida antes do despacho.');
    const attempt = await requestDispatch(client, principal, deliveryId, { idempotencyKey: input.idempotencyKey });
    const queued = await providerIntegration.enqueue(client, principal, { providerId: quote.rows[0].provider_id, deliveryId,
      fulfillmentId: quote.rows[0].fulfillment_id, operation: 'DISPATCH_REQUEST', requestKey: input.idempotencyKey,
      payload: { deliveryId, fulfillmentId: quote.rows[0].fulfillment_id, quoteId: input.quoteId, dispatchAttemptId: attempt.attemptId } });
    return { ...attempt, commandId: queued.command.command_id, status: 'pending', duplicate: attempt.duplicate || queued.duplicate };
  }
  async function requestProviderOperation(client, principal, deliveryId, input, operation) {
    D.uuid(deliveryId, 'deliveryId');
    if (typeof input?.idempotencyKey !== 'string' || input.idempotencyKey.length < 16 || input.idempotencyKey.length > 128) fail('INVALID_INPUT', 'Chave de operação inválida.');
    const active = await client.query(`SELECT fulfillment_id,provider_id,status FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2
      AND mode='external' AND status IN ('selected','dispatch_requested','accepted','in_progress','arrived') ORDER BY revision DESC LIMIT 1`, [principal.company_id,deliveryId]);
    if (!active.rowCount) fail('INVALID_STATE_TRANSITION', 'Não há fulfillment externo ativo para esta operação.');
    const queued = await providerIntegration.enqueue(client, principal, { providerId: active.rows[0].provider_id, deliveryId,
      fulfillmentId: active.rows[0].fulfillment_id, operation, requestKey: input.idempotencyKey,
      payload: { deliveryId, fulfillmentId: active.rows[0].fulfillment_id, reason: operation === 'CANCEL_REQUEST' ? 'operator_request' : 'operator_reconcile' } });
    await audit(client, principal, `logistics.provider.${operation.toLowerCase()}`, 'provider_command', queued.command.command_id,
      { deliveryId, providerId: active.rows[0].provider_id, status: 'queued', duplicate: queued.duplicate });
    return { commandId: queued.command.command_id, status: queued.command.status, duplicate: queued.duplicate };
  }
  async function requestProviderCancel(client, principal, deliveryId, input) { return requestProviderOperation(client, principal, deliveryId, input, 'CANCEL_REQUEST'); }
  async function requestProviderTracking(client, principal, deliveryId, input) { return requestProviderOperation(client, principal, deliveryId, input, 'TRACKING_REFRESH'); }
  async function requestProviderReconciliation(client, principal, deliveryId, input) { return requestProviderOperation(client, principal, deliveryId, input, 'RECONCILE'); }
  async function getProviderCommands(client, principal, deliveryId) {
    D.uuid(deliveryId, 'deliveryId');
    const result = await client.query(`SELECT command_id,provider_id,operation,status,attempts,next_attempt_at,last_error_class,correlation_id,created_at,updated_at,completed_at
      FROM rotamoto.provider_command_outbox WHERE company_id=$1 AND delivery_id=$2 ORDER BY created_at DESC LIMIT 50`, [principal.company_id,deliveryId]);
    return { commands: result.rows };
  }
  return Object.freeze({ ensureInternalProvider, listProviders, createProvider, updateProvider, getFulfillment, selectFulfillment, requestDispatch, updateFulfillment, analytics,
    requestProviderQuote, listProviderQuotes, selectProviderQuote, requestProviderDispatch, requestProviderCancel, requestProviderTracking,
    requestProviderReconciliation, getProviderCommands });
}
module.exports = { LogisticsServiceError, createLogisticsService };
