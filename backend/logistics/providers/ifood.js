'use strict';

const crypto = require('node:crypto');

const API = 'https://merchant-api.ifood.com.br';
const CAPABILITIES = Object.freeze(['quote', 'dispatch', 'cancel', 'tracking', 'webhook']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_RESPONSE_BYTES = 256 * 1024;

class ProviderError extends Error {
  constructor(code, classification, status = null, retryAfterSeconds = null) {
    super('Falha na integração logística iFood.');
    this.name = 'ProviderError';
    this.code = code;
    this.classification = classification;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function fail(code, classification = 'permanent', status = null, retryAfterSeconds = null) {
  throw new ProviderError(code, classification, status, retryAfterSeconds);
}

function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`INVALID_${field.toUpperCase()}`);
  return value;
}

function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) || !Number.isFinite(Date.parse(value))) fail(`INVALID_${field.toUpperCase()}`);
  return new Date(value).toISOString();
}

function decimalToMinor(value, field) {
  if (typeof value !== 'number' && typeof value !== 'string') fail(`INVALID_${field.toUpperCase()}`);
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/u.test(text)) fail(`INVALID_${field.toUpperCase()}`);
  const [whole, fraction = ''] = text.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) fail(`INVALID_${field.toUpperCase()}`);
  return amount;
}

function quoteFromResponse(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_PROVIDER_RESPONSE');
  const createdAt = timestamp(raw.createdAt, 'created_at');
  const expiresAt = timestamp(raw.expirationAt, 'expiration_at');
  if (Date.parse(expiresAt) <= now) fail('QUOTE_EXPIRED');
  if (!raw.quote || typeof raw.quote !== 'object' || Array.isArray(raw.quote)) fail('INVALID_PROVIDER_RESPONSE');
  const gross = decimalToMinor(raw.quote.grossValue, 'gross_value');
  const discount = decimalToMinor(raw.quote.discount, 'discount');
  const surcharge = decimalToMinor(raw.quote.raise, 'raise');
  if (discount > gross) fail('INVALID_PROVIDER_RESPONSE');
  const amountMinor = gross - discount + surcharge;
  if (!Number.isSafeInteger(amountMinor)) fail('INVALID_PROVIDER_RESPONSE');
  return Object.freeze({ provider: 'ifood', externalQuoteReference: uuid(raw.id, 'quote_id'), currency: 'BRL', amountMinor,
    createdAt, expiresAt, status: 'available', etaAt: null });
}

function trackingFromResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_PROVIDER_RESPONSE');
  const coordinate = (value, min, max, field) => {
    if (value == null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`INVALID_${field.toUpperCase()}`);
    return value;
  };
  const nullableTimestamp = raw.expectedDelivery == null ? null : timestamp(raw.expectedDelivery, 'expected_delivery');
  const trackDate = raw.trackDate == null ? null : timestamp(raw.trackDate, 'track_date');
  if ((raw.latitude == null) !== (raw.longitude == null)) fail('INVALID_PROVIDER_RESPONSE');
  for (const field of ['pickupEtaStart', 'deliveryEtaEnd']) if (raw[field] != null && (!Number.isInteger(raw[field]) || Math.abs(raw[field]) > 86400)) fail(`INVALID_${field.toUpperCase()}`);
  return Object.freeze({ provider: 'ifood', latitude: coordinate(raw.latitude, -90, 90, 'latitude'),
    longitude: coordinate(raw.longitude, -180, 180, 'longitude'), expectedDelivery: nullableTimestamp,
    pickupEtaStartSeconds: raw.pickupEtaStart ?? null, deliveryEtaEndSeconds: raw.deliveryEtaEnd ?? null, trackedAt: trackDate });
}

function verifyWebhookSignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_RESPONSE_BYTES || typeof signature !== 'string' || !/^[0-9a-f]{64}$/iu.test(signature) || typeof secret !== 'string' || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function normalizeDeliveryEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(raw.id) ||
      typeof raw.orderId !== 'string' || !UUID.test(raw.orderId) || typeof raw.fullCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(raw.fullCode)) fail('INVALID_PROVIDER_EVENT');
  const allowed = new Map([
    ['REQUEST_DRIVER_SUCCESS', 'accepted'], ['ASSIGN_DRIVER', 'accepted'], ['DELIVERY_CANCELLATION_REQUEST_ACCEPTED', 'cancelled'],
    ['DELIVERY_CANCELLATION_REQUEST_REJECTED', 'cancel_rejected'], ['REQUEST_DRIVER_FAILED', 'failed'], ['DELIVERY_IN_TRANSIT', 'in_progress'],
    ['DELIVERY_CONCLUDED', 'completed'], ['DELIVERY_CANCELLED', 'cancelled']
  ]);
  return Object.freeze({ provider: 'ifood', externalEventId: raw.id, externalOrderId: raw.orderId,
    occurredAt: raw.createdAt ? timestamp(raw.createdAt, 'event_time') : null,
    status: allowed.get(raw.fullCode) || 'unmapped', externalStatus: raw.fullCode });
}

function createIfoodAdapter({ credentialResolver, fetchImpl = globalThis.fetch, timeoutMs = 8000, clock = () => Date.now() } = {}) {
  if (typeof credentialResolver !== 'function' || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('Configuração de adapter iFood inválida.');
  const tokens = new Map();
  async function request(path, { method = 'GET', body, credentials } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (credentials) {
        const credentialKey = crypto.createHash('sha256').update(`${credentials.clientId}\0${credentials.clientSecret}`).digest('hex');
        const cached = tokens.get(credentialKey);
        if (!cached || cached.expiresAt <= clock() + 60000) {
          const form = new URLSearchParams({ grantType: 'client_credentials', clientId: credentials.clientId, clientSecret: credentials.clientSecret });
          const auth = await fetchImpl(`${API}/authentication/v1.0/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, signal: controller.signal, redirect: 'error' });
          const authRaw = await readResponse(auth);
          if (auth.status === 401 || auth.status === 403) fail('AUTH_REJECTED', 'auth', auth.status);
          if (!auth.ok) fail('AUTH_SERVICE_ERROR', auth.status === 429 || auth.status >= 500 ? 'transient' : 'permanent', auth.status, retryAfter(auth));
          if (!authRaw || typeof authRaw.accessToken !== 'string' || authRaw.accessToken.length > 8000 || !Number.isInteger(authRaw.expiresIn) || authRaw.expiresIn < 60) fail('INVALID_AUTH_RESPONSE');
          tokens.set(credentialKey, { value: authRaw.accessToken, expiresAt: clock() + authRaw.expiresIn * 1000 });
        }
        headers.Authorization = `Bearer ${tokens.get(credentialKey).value}`;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(`${API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: 'error' });
      const data = response.status === 204 ? null : await readResponse(response);
      if (response.status === 401) { tokens.delete(crypto.createHash('sha256').update(`${credentials.clientId}\0${credentials.clientSecret}`).digest('hex')); fail('AUTH_EXPIRED', 'auth', 401); }
      if (response.status === 403) fail('AUTH_FORBIDDEN', 'auth', 403);
      if (response.status === 429) fail('RATE_LIMITED', 'rate_limit', 429, retryAfter(response));
      if (response.status === 408 || response.status >= 500) fail('PROVIDER_TRANSIENT', 'transient', response.status, retryAfter(response));
      if (!response.ok) fail('PROVIDER_REJECTED', 'permanent', response.status);
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      fail(error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', 'unknown');
    } finally { clearTimeout(timer); }
  }
  async function readResponse(response) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail('INVALID_PROVIDER_RESPONSE');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); fail('INVALID_PROVIDER_RESPONSE'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock?.(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) fail('INVALID_PROVIDER_RESPONSE');
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { fail('INVALID_PROVIDER_RESPONSE'); }
  }
  function retryAfter(response) {
    const raw = Number(response.headers?.get?.('retry-after'));
    return Number.isFinite(raw) && raw > 0 ? Math.min(3600, Math.ceil(raw)) : null;
  }
  async function invoke(companyId, method) {
    if (typeof companyId !== 'string' || !UUID.test(companyId)) fail('INVALID_TENANT');
    let credentials;
    try { credentials = await credentialResolver(companyId, 'ifood'); } catch (_) { fail('CREDENTIALS_UNAVAILABLE', 'auth'); }
    if (!credentials || typeof credentials.clientId !== 'string' || !credentials.clientId || typeof credentials.clientSecret !== 'string' || !credentials.clientSecret) fail('CREDENTIALS_UNAVAILABLE', 'auth');
    return method(credentials);
  }
  return Object.freeze({ provider: 'ifood', capabilities: CAPABILITIES,
    async quote({ companyId, orderId }) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/shipping/v1.0/orders/${orderId}/deliveryAvailabilities`, { credentials });
      return quoteFromResponse(result.data, clock());
    }); },
    async dispatch({ companyId, orderId, quoteId }) { uuid(orderId, 'order_id'); uuid(quoteId, 'quote_id'); return invoke(companyId, async credentials => {
      const result = await request(`/shipping/v1.0/orders/${orderId}/requestDriver`, { method: 'POST', body: { quoteId }, credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ provider: 'ifood', status: 'requested', confirmation: 'pending' });
    }); },
    async cancel({ companyId, orderId }) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/shipping/v1.0/orders/${orderId}/cancelRequestDriver`, { method: 'POST', body: {}, credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ provider: 'ifood', status: 'requested', confirmation: 'pending' });
    }); },
    async tracking({ companyId, orderId }) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/shipping/v1.0/orders/${orderId}/tracking`, { credentials });
      return trackingFromResponse(result.data);
    }); },
    verifyWebhook: verifyWebhookSignature,
    normalizeDeliveryEvent
  });
}

module.exports = { API, CAPABILITIES, ProviderError, decimalToMinor, quoteFromResponse, trackingFromResponse, verifyWebhookSignature, normalizeDeliveryEvent, createIfoodAdapter };
