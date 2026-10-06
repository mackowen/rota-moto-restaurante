'use strict';

const crypto = require('node:crypto');
const { uuidV7 } = require('../identity/service');

const OPERATIONS = new Set(['QUOTE_REQUEST','DISPATCH_REQUEST','CANCEL_REQUEST','TRACKING_REFRESH','RECONCILE']);
const TRANSIENT = new Set(['TRANSIENT','RATE_LIMIT']);
const ALLOWED_PAYLOAD_KEYS = new Set(['deliveryId','fulfillmentId','quoteId','dispatchAttemptId','reason']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TEST_CAPABILITIES = new Set(['quote','dispatch','cancel','tracking']);
function resolveTestProviderConfiguration(testProvider, companyId, providerId) {
  if (!testProvider) return null;
  if (process.env.NODE_ENV !== 'test' || typeof testProvider !== 'function') throw new Error('Test provider configuration is restricted to NODE_ENV=test.');
  const config = testProvider(companyId, providerId);
  if (config == null) return null;
  if (!config || config.companyId !== companyId || config.providerId !== providerId || config.providerCode !== 'ifood' || config.adapter !== 'fake' ||
      !Array.isArray(config.capabilities) || config.capabilities.some(value => !TEST_CAPABILITIES.has(value)) ||
      !config.capabilities.length) throw new Error('Test provider configuration is invalid or cross-tenant.');
  return Object.freeze({ ...config, capabilities: Object.freeze([...new Set(config.capabilities)]) });
}
function safePayload(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !ALLOWED_PAYLOAD_KEYS.has(key))) throw Object.assign(new Error('Payload de comando inválido.'), { code: 'INVALID_INPUT' });
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || !item || item.length > 160 || /[\u0000-\u001f\u007f]/u.test(item)) throw Object.assign(new Error('Payload de comando inválido.'), { code: 'INVALID_INPUT' });
    if (key === 'reason' && !/^[a-z0-9_-]{1,64}$/iu.test(item)) throw Object.assign(new Error('Payload de comando inválido.'), { code: 'INVALID_INPUT' });
    if (key !== 'reason' && !UUID.test(item)) throw Object.assign(new Error('Payload de comando inválido.'), { code: 'INVALID_INPUT' });
    result[key] = item;
  }
  return result;
}
function deterministicKey({ companyId, providerId, operation, requestKey }) {
  if (![companyId, providerId, requestKey].every(value => typeof value === 'string' && value.length > 0) || !OPERATIONS.has(operation)) throw new TypeError('Correlation data inválida.');
  return crypto.createHash('sha256').update(`rotamoto-provider-v1\0${companyId}\0${providerId}\0${operation}\0${requestKey}`).digest('hex');
}
function retryDelayMs({ attempts, classification, retryAfterSeconds = null, seed = '' }) {
  if (!TRANSIENT.has(classification) || attempts >= 8) return null;
  const base = Number.isFinite(retryAfterSeconds) ? Math.min(Math.max(retryAfterSeconds, 1) * 1000, 3600000) : Math.min(1000 * (2 ** Math.max(0, attempts - 1)), 900000);
  const jitter = crypto.createHash('sha256').update(String(seed)).digest().readUInt16BE(0) % Math.max(1, Math.floor(base / 4));
  return Math.min(base + jitter, 3600000);
}
function createProviderIntegrationService({ clock = () => new Date(), testProvider = null } = {}) {
  if (testProvider && (process.env.NODE_ENV !== 'test' || typeof testProvider !== 'function')) throw new Error('Test provider configuration is restricted to NODE_ENV=test.');
  async function enqueue(client, principal, input) {
    if (!input || !OPERATIONS.has(input.operation)) throw Object.assign(new Error('Operação externa inválida.'), { code: 'INVALID_INPUT' });
    const payload = safePayload(input.payload);
    const ids = { providerId: input.providerId, deliveryId: input.deliveryId, fulfillmentId: input.fulfillmentId || null };
    const commandId = input.commandId || uuidV7(clock().getTime());
    const correlationId = input.correlationId || commandId;
    const key = deterministicKey({ companyId: principal.company_id, providerId: ids.providerId, operation: input.operation, requestKey: input.requestKey });
    const provider = await client.query(`SELECT provider_id,code,enabled,integration_mode,api_enabled,capabilities FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_id=$2`, [principal.company_id, ids.providerId]);
    if (!provider.rowCount || !provider.rows[0].enabled) throw Object.assign(new Error('Provider indisponível.'), { code: 'PROVIDER_UNAVAILABLE' });
    const testConfig = resolveTestProviderConfiguration(testProvider, principal.company_id, ids.providerId);
    if (testConfig && provider.rows[0].code !== testConfig.providerCode) throw Object.assign(new Error('Test provider mapping does not match provider identity.'), { code: 'PROVIDER_UNAVAILABLE' });
    if (!testConfig && (provider.rows[0].integration_mode !== 'api' || !provider.rows[0].api_enabled)) throw Object.assign(new Error('API externa não configurada.'), { code: 'PROVIDER_NOT_CONFIGURED' });
    const capability = { QUOTE_REQUEST: 'quote', DISPATCH_REQUEST: 'dispatch', CANCEL_REQUEST: 'cancel', TRACKING_REFRESH: 'tracking', RECONCILE: 'tracking' }[input.operation];
    if (!(testConfig?.capabilities || provider.rows[0].capabilities).includes(capability)) throw Object.assign(new Error('Capability indisponível.'), { code: 'CAPABILITY_UNAVAILABLE' });
    const result = await client.query(`INSERT INTO rotamoto.provider_command_outbox
      (company_id,command_id,provider_id,delivery_id,fulfillment_id,operation,idempotency_key,payload,correlation_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
      ON CONFLICT(company_id,provider_id,operation,idempotency_key) DO NOTHING
      RETURNING command_id,status,attempts,created_at`,
    [principal.company_id, commandId, ids.providerId, ids.deliveryId, ids.fulfillmentId, input.operation, key, JSON.stringify(payload), correlationId, principal.user_id]);
    if (result.rowCount) return { command: result.rows[0], duplicate: false };
    const prior = await client.query(`SELECT command_id,status,attempts,created_at,payload,delivery_id,fulfillment_id FROM rotamoto.provider_command_outbox
      WHERE company_id=$1 AND provider_id=$2 AND operation=$3 AND idempotency_key=$4`, [principal.company_id, ids.providerId, input.operation, key]);
    if (!prior.rowCount || prior.rows[0].delivery_id !== ids.deliveryId || prior.rows[0].fulfillment_id !== ids.fulfillmentId || JSON.stringify(prior.rows[0].payload) !== JSON.stringify(payload))
      throw Object.assign(new Error('Chave de idempotência em conflito.'), { code: 'IDEMPOTENCY_CONFLICT' });
    return { command: prior.rows[0], duplicate: true };
  }
  async function saveQuote(client, companyId, providerId, deliveryId, quote, { fulfillmentId = null, quoteId = uuidV7(clock().getTime()) } = {}) {
    if (!quote || typeof quote.provider !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/u.test(quote.provider) || typeof quote.externalQuoteReference !== 'string' ||
        !/^[0-9a-f-]{36}$/iu.test(quote.externalQuoteReference) || !Number.isSafeInteger(quote.amountMinor) ||
        !/^[A-Z]{3}$/u.test(quote.currency) || !Number.isFinite(Date.parse(quote.createdAt)) || !Number.isFinite(Date.parse(quote.expiresAt)) ||
        Date.parse(quote.expiresAt) <= Date.parse(quote.createdAt)) throw Object.assign(new Error('Cotação normalizada inválida.'), { code: 'INVALID_PROVIDER_RESPONSE' });
    const eta = quote.etaAt == null ? null : new Date(quote.etaAt);
    const result = await client.query(`INSERT INTO rotamoto.provider_quotes
      (company_id,quote_id,delivery_id,fulfillment_id,provider_id,external_quote_id,status,currency,amount_minor,eta_at,issued_at,expires_at,provider_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,'available',$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT(company_id,provider_id,external_quote_id) DO NOTHING
      RETURNING quote_id,status,currency,amount_minor,eta_at,issued_at,expires_at,version`,
    [companyId,quoteId,deliveryId,fulfillmentId,providerId,quote.externalQuoteReference,quote.currency,quote.amountMinor,eta,quote.createdAt,quote.expiresAt,JSON.stringify({provider:quote.provider,status:'available'})]);
    if (result.rowCount) return result.rows[0];
    const prior = await client.query(`SELECT quote_id,status,currency,amount_minor,eta_at,issued_at,expires_at,version FROM rotamoto.provider_quotes WHERE company_id=$1 AND provider_id=$2 AND external_quote_id=$3`, [companyId,providerId,quote.externalQuoteReference]);
    return prior.rows[0] || null;
  }
  async function selectQuote(client, principal, quoteId, expectedVersion) {
    const result = await client.query(`UPDATE rotamoto.provider_quotes SET status='selected',selected_at=$4,version=version+1,updated_at=$4
      WHERE company_id=$1 AND quote_id=$2 AND version=$3 AND status='available' AND expires_at>$4 RETURNING quote_id,delivery_id,provider_id,currency,amount_minor,eta_at,expires_at,version`,
    [principal.company_id,quoteId,expectedVersion,clock()]);
    if (!result.rowCount) throw Object.assign(new Error('Cotação expirada ou alterada. Atualize a tela.'), { code: 'REVISION_CONFLICT' });
    return result.rows[0];
  }
  async function ingestEvent(client, { companyId, providerId, event, rawBody }) {
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 262144 || !event || typeof event.externalEventId !== 'string') throw Object.assign(new Error('Evento externo inválido.'), { code: 'INVALID_PROVIDER_EVENT' });
    const digest = crypto.createHash('sha256').update(rawBody).digest();
    const normalized = { status: event.status, externalOrderId: event.externalOrderId, occurredAt: event.occurredAt, externalStatus: event.externalStatus };
    const eventId = uuidV7(clock().getTime());
    const inserted = await client.query(`INSERT INTO rotamoto.provider_event_inbox(company_id,event_id,provider_id,external_event_id,body_digest,normalized_event,status)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(company_id,provider_id,external_event_id) DO NOTHING RETURNING event_id,status`,
    [companyId,eventId,providerId,event.externalEventId,digest,JSON.stringify(normalized),event.status === 'unmapped' ? 'unmapped' : 'received']);
    if (inserted.rowCount) return { ...inserted.rows[0], duplicate: false };
    const prior = await client.query(`SELECT event_id,body_digest,status FROM rotamoto.provider_event_inbox WHERE company_id=$1 AND provider_id=$2 AND external_event_id=$3`, [companyId,providerId,event.externalEventId]);
    if (!prior.rowCount || !Buffer.from(prior.rows[0].body_digest).equals(digest)) throw Object.assign(new Error('Identificador de evento reutilizado com conteúdo divergente.'), { code: 'IDEMPOTENCY_CONFLICT' });
    return { event_id: prior.rows[0].event_id, status: prior.rows[0].status, duplicate: true };
  }
  return Object.freeze({ enqueue, saveQuote, selectQuote, ingestEvent });
}
module.exports = { OPERATIONS, safePayload, deterministicKey, retryDelayMs, resolveTestProviderConfiguration, createProviderIntegrationService };
