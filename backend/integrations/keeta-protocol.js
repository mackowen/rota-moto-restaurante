'use strict';

const crypto = require('node:crypto');

const API = 'https://open.mykeeta.com/api/open/opendelivery';
const MAX_BODY = 256 * 1024;

function opaqueId(value, min = 1, max = 128) {
  return typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

// Keeta Open Delivery uses the RFC 8785 JSON canonical form for request bodies.
// The accepted values here are JSON values only: rejecting non-finite numbers and
// exotic objects avoids signing a representation different from the transmitted one.
function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Número JSON inválido.');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError('Valor JSON inválido.');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function canonicalQuery(params = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new TypeError('Parâmetros Keeta inválidos.');
  return Object.keys(params).sort().map(key => {
    const value = params[key];
    // OpenAPI array query parameters use form style with explode=false here:
    // Keeta's polling reference serializes eventType as a comma-separated list.
    return `${key}=${value == null ? '' : Array.isArray(value) ? value.map(item => String(item)).join(',') : typeof value === 'object' ? canonicalJson(value) : String(value)}`;
  }).join('&');
}

function requestSigningString(url, params = {}, body = undefined) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new TypeError('URL Keeta inválida.');
  const path = `${parsed.origin}${parsed.pathname}`;
  const query = canonicalQuery(params);
  const bodyText = body == null || body === '' || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)
    ? '' : typeof body === 'string' ? body : canonicalJson(body);
  // The official examples omit separators for empty components: GET + query
  // signs `URL&query`; GET with no query/body signs only `URL`.
  return [path, query, bodyText].filter(component => component !== '').join('&');
}

function signRequest(url, params, appSecret, body = undefined) {
  if (typeof appSecret !== 'string' || !appSecret) throw new TypeError('Configuração de assinatura Keeta inválida.');
  return crypto.createHmac('sha256', appSecret).update(requestSigningString(url, params, body), 'utf8').digest('base64');
}

function verifyWebhook(rawBody, signature, appSecret) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_BODY || typeof signature !== 'string' || typeof appSecret !== 'string' || !appSecret) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  let supplied;
  try { supplied = Buffer.from(signature, 'base64'); } catch (_) { return false; }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function verifyWebhookAndParse(rawBody, signature, appSecret, headers = {}) {
  if (!verifyWebhook(rawBody, signature, appSecret)) return null;
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch (_) { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const headerAppId = headers['x-app-id'] ?? headers['X-App-Id'];
  const headerMerchantId = headers['x-app-merchantid'] ?? headers['X-App-MerchantId'];
  if (!opaqueId(headerAppId, 1, 128) || !opaqueId(headerMerchantId, 1, 128)) return null;
  if (!opaqueId(payload.eventId, 1, 128) || !opaqueId(payload.orderId, 1, 128) || typeof payload.eventType !== 'string' || !payload.eventType) return null;
  return Object.freeze({ provider: 'keeta', appId: headerAppId, externalAccountId: headerMerchantId,
    eventId: payload.eventId, externalEventId: payload.eventId, externalOrderId: payload.orderId,
    eventType: payload.eventType, occurredAt: typeof payload.createdAt === 'string' ? payload.createdAt : null });
}

function normalizeWebhook(envelope) {
  if (!envelope || typeof envelope !== 'object' || !opaqueId(envelope.externalEventId, 1, 128) ||
      !opaqueId(envelope.externalAccountId, 1, 128) || !opaqueId(envelope.externalOrderId, 1, 128)) {
    const error = new Error('Evento Keeta inválido.'); error.code = 'INVALID_PROVIDER_EVENT'; throw error;
  }
  const states = new Map([['CREATED','placed'],['CONFIRMED','confirmed'],['READY_FOR_PICKUP','ready'],['DISPATCHED','dispatched'],['PICKED_UP','picked_up'],['DELIVERED','delivered'],['CONCLUDED','completed'],['CANCELLATION_REQUESTED','cancellation_requested'],['CANCELLED','cancelled']]);
  return Object.freeze({ provider: 'keeta', externalEventId: envelope.externalEventId, externalAccountId: envelope.externalAccountId,
    externalOrderId: envelope.externalOrderId, occurredAt: envelope.occurredAt || null, status: states.get(envelope.eventType) || 'unmapped', externalStatus: envelope.eventType || envelope.eventId || 'unknown' });
}

module.exports = { API, canonicalJson, canonicalQuery, canonicalParams: canonicalQuery, requestSigningString, signRequest, verifyWebhook, verifyWebhookAndParse, normalizeWebhook, opaqueId };
