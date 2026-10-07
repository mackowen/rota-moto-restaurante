'use strict';

const crypto = require('node:crypto');
const { API, signRequest, canonicalJson } = require('./keeta-protocol');

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function normalizeKeetaOrder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !SAFE_ID.test(String(raw.id || '')) || !Array.isArray(raw.items)) throw new KeetaError('INVALID_PROVIDER_ORDER', 'permanent');
  const addr = raw.delivery?.deliveryAddress || {};
  const address = [addr.street, addr.number, addr.complement, addr.district, addr.city, addr.state, addr.postalCode]
    .filter(value => typeof value === 'string' && value.trim()).join(', ').slice(0, 800);
  const items = raw.items.map(item => {
    if (!item || typeof item.name !== 'string' || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) throw new KeetaError('INVALID_PROVIDER_ORDER', 'permanent');
    return Object.freeze({ name: item.name.slice(0, 240), quantity: Number(item.quantity) });
  });
  return Object.freeze({ source: 'keeta', externalId: String(raw.id), externalDisplayId: typeof raw.displayId === 'string' ? raw.displayId.slice(0, 64) : null,
    status: typeof raw.lastEvent === 'string' ? raw.lastEvent : null, orderType: ['DELIVERY','TAKEOUT','INDOOR'].includes(raw.type) ? raw.type : null,
    createdAt: raw.createdAt || null, customer: raw.customer && typeof raw.customer.name === 'string' ? Object.freeze({ name: raw.customer.name.slice(0, 160) }) : null,
    address, items: Object.freeze(items) });
}

class KeetaError extends Error {
  constructor(code, classification, status = null, retryAfterSeconds = null) {
    super('Falha na integração Keeta.'); this.name = 'KeetaError'; this.code = code;
    this.classification = classification; this.status = status; this.retryAfterSeconds = retryAfterSeconds;
  }
}

function createKeetaAdapter({ credentialResolver, fetchImpl = globalThis.fetch, timeoutMs = 8000, clock = () => Date.now(), persistToken = async () => {} } = {}) {
  if (typeof credentialResolver !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('Resolver de credenciais Keeta obrigatório.');
  const tokenCache = new Map();
  async function read(response) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 256 * 1024) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent');
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent'); }
  }
  async function fetchJson(url, options) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
      const data = await read(response);
      if (response.status === 401) throw new KeetaError('AUTH_EXPIRED', 'auth', 401);
      if (response.status === 403) throw new KeetaError('AUTH_FORBIDDEN', 'auth', 403);
      if (!response.ok) {
        const retryAfter = Number(response.headers?.get?.('retry-after'));
        const status = response.status;
        throw new KeetaError(RETRYABLE.has(status) ? 'PROVIDER_TRANSIENT' : 'PROVIDER_REJECTED', RETRYABLE.has(status) ? 'transient' : 'permanent', status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(3600, Math.ceil(retryAfter)) : null);
      }
      return { status: response.status, data };
    } catch (error) {
      if (error instanceof KeetaError) throw error;
      throw new KeetaError(error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', 'unknown');
    } finally { clearTimeout(timer); }
  }
  async function token(credentials, force = false) {
    const key = crypto.createHash('sha256').update(`${credentials.clientId}\0${credentials.clientSecret}\0${credentials.authId || ''}`).digest('hex');
    const cached = tokenCache.get(key);
    if (!force && cached && cached.expiresAt > clock() + 60_000) return cached.accessToken;
    let body;
    if (credentials.refreshToken) body = { client_id: credentials.clientId, grant_type: 'refresh_token', refresh_token: credentials.refreshToken };
    else if (credentials.authorizationCode) body = { client_id: credentials.clientId, grant_type: 'shop_level_authorization_code', code: credentials.authorizationCode };
    else body = { client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: 'app_level_token' };
    const result = await fetchJson(`${API}/oauth/token`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: canonicalJson(body) });
    if (typeof result.data?.access_token !== 'string' || !result.data.access_token || !Number.isInteger(result.data.expires_in) || result.data.expires_in < 30) throw new KeetaError('INVALID_AUTH_RESPONSE', 'auth');
    const value = { accessToken: result.data.access_token, refreshToken: result.data.refresh_token || credentials.refreshToken || null,
      expiresAt: clock() + result.data.expires_in * 1000 };
    tokenCache.set(key, value);
    await persistToken({ key, refreshToken: value.refreshToken, expiresAt: value.expiresAt });
    return value.accessToken;
  }
  async function call(companyId, path, { method = 'GET', query = {}, body, headers = {}, safeRetryAuth = true } = {}) {
    if (typeof companyId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(companyId)) throw new KeetaError('INVALID_TENANT', 'permanent');
    let credentials;
    try { credentials = await credentialResolver(companyId, 'keeta'); } catch (_) { throw new KeetaError('CREDENTIALS_UNAVAILABLE', 'auth'); }
    if (!credentials || typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string' || !credentials.clientId || !credentials.clientSecret) throw new KeetaError('CREDENTIALS_UNAVAILABLE', 'auth');
    const credentialKey = crypto.createHash('sha256').update(`${credentials.clientId}\0${credentials.clientSecret}\0${credentials.authId || ''}`).digest('hex');
    const queryText = Object.keys(query).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] == null ? '' : String(query[k]))}`).join('&');
    const requestUrl = `${API}${path}${queryText ? `?${queryText}` : ''}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await token(credentials, attempt > 0);
      const signature = signRequest(requestUrl, query, credentials.clientSecret, body);
      const requestHeaders = { Accept: 'application/json', Authorization: `Bearer ${accessToken}`, 'X-App-Signature': signature, ...headers };
      const request = { method, headers: requestHeaders, ...(body !== undefined ? { body: canonicalJson(body), headers: { ...requestHeaders, 'Content-Type': 'application/json' } } : {}) };
      try { return await fetchJson(requestUrl, request); }
      catch (error) {
        // A 401 is a definitive rejection (unlike a timeout), so refreshing once and
        // repeating the rejected operation cannot duplicate a provider-side effect.
        if (error.code === 'AUTH_EXPIRED' && attempt === 0) continue;
        if (error.code === 'AUTH_EXPIRED') { tokenCache.delete(credentialKey); await persistToken({ key: credentialKey, revoke: true }); }
        throw error;
      }
    }
    throw new KeetaError('AUTH_EXPIRED', 'auth', 401);
  }
  function orderId(id) { if (typeof id !== 'string' || !SAFE_ID.test(id)) throw new KeetaError('INVALID_ORDER_ID', 'permanent'); return encodeURIComponent(id); }
  return Object.freeze({ provider: 'keeta',
    async authorizationUrl({ companyId, redirectUri, state }) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/u.test(state)) throw new KeetaError('INVALID_OAUTH_STATE', 'permanent');
      let callback;
      try { callback = new URL(redirectUri); } catch (_) { throw new KeetaError('INVALID_CALLBACK_URL', 'permanent'); }
      if (callback.protocol !== 'https:' || callback.username || callback.password) throw new KeetaError('INVALID_CALLBACK_URL', 'permanent');
      callback.searchParams.set('state', state);
      const c = await credentialResolver(companyId, 'keeta'); const query = { clientId: c.clientId, redirectUri: callback.toString() };
      return (await call(companyId, '/oauth/authorization/url', { query })).data?.merchantAuthorizationUrl || null;
    },
    async merchantInfo({ companyId, authId }) { if (!SAFE_ID.test(authId || '')) throw new KeetaError('INVALID_AUTH_ID', 'permanent'); return (await call(companyId, `/oauth/authorized/${encodeURIComponent(authId)}/merchantInfo`)).data; },
    async pollEvents({ companyId, merchantIds, eventTypes }) {
      if (!Array.isArray(merchantIds) || !merchantIds.length || merchantIds.length > 100 || merchantIds.some(id => !SAFE_ID.test(id))) throw new KeetaError('INVALID_MERCHANTS', 'permanent');
      if (eventTypes && (!Array.isArray(eventTypes) || !eventTypes.length || eventTypes.length > 13)) throw new KeetaError('INVALID_EVENT_TYPES', 'permanent');
      const query = eventTypes ? { eventType: eventTypes.join(',') } : {};
      const result = await call(companyId, '/v1/events:polling', { query, headers: { 'x-polling-merchants': merchantIds.join(',') } });
      if (result.status === 204) return Object.freeze([]);
      if (!Array.isArray(result.data)) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent');
      return Object.freeze(result.data.map(event => {
        if (!SAFE_ID.test(String(event.eventId || '')) || !SAFE_ID.test(String(event.orderId || '')) || typeof event.eventType !== 'string') throw new KeetaError('INVALID_PROVIDER_EVENT', 'permanent');
        return Object.freeze({ id: String(event.eventId), orderId: String(event.orderId), eventType: event.eventType, createdAt: event.createdAt, orderURL: event.orderURL });
      }));
    },
    async acknowledgeEvents({ companyId, events }) {
      if (!Array.isArray(events) || !events.length || events.length > 100 || events.some(event => !SAFE_ID.test(event?.id || '') || !SAFE_ID.test(event?.orderId || '') || typeof event?.eventType !== 'string')) throw new KeetaError('INVALID_EVENT_IDS', 'permanent');
      const result = await call(companyId, '/v1/events/acknowledgment', { method: 'POST', body: events.map(({ id, orderId: oid, eventType }) => ({ id, orderId: oid, eventType })), safeRetryAuth: false });
      if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent');
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    },
    async order({ companyId, id }) { return normalizeKeetaOrder((await call(companyId, `/v1/orders/${orderId(id)}`)).data); },
    async confirm({ companyId, id, orderExternalCode, createdAt, preparationTime }) {
      const body = { orderExternalCode, createdAt, ...(Number.isInteger(preparationTime) ? { preparationTime } : {}) };
      const result = await call(companyId, `/v1/orders/${orderId(id)}/confirm`, { method: 'POST', body, safeRetryAuth: false });
      return Object.freeze({ accepted: result.status === 202, confirmation: 'pending' });
    },
    async readyForPickup({ companyId, id }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/readyForPickup`, { method: 'POST', safeRetryAuth: false }); return Object.freeze({ accepted: result.status === 202, confirmation: 'pending' }); },
    async requestCancellation({ companyId, id, reason, code, mode = 'MANUAL', outOfStockItems = [], invalidItems = [] }) {
      const allowed = new Set(['SYSTEMIC_ISSUES','DUPLICATE_APPLICATION','UNAVAILABLE_ITEM','RESTAURANT_WITHOUT_DELIVERY_PERSON','OUTDATED_MENU','ORDER_OUTSIDE_THE_DELIVERY_AREA','BLOCKED_CUSTOMER','OUTSIDE_DELIVERY_HOURS','INTERNAL_DIFFICULTIES_OF_THE_RESTAURANT','RISK_AREA']);
      if (typeof reason !== 'string' || !reason.trim() || !allowed.has(code) || !['AUTO','MANUAL'].includes(mode)) throw new KeetaError('INVALID_CANCELLATION', 'permanent');
      const result = await call(companyId, `/v1/orders/${orderId(id)}/requestCancellation`, { method: 'POST', body: { reason: reason.slice(0, 500), code, mode, outOfStockItems: outOfStockItems.slice(0, 100), invalidItems: invalidItems.slice(0, 100) }, safeRetryAuth: false });
      return Object.freeze({ accepted: result.status === 202, confirmation: 'pending' });
    },
    async dispatchSelfDelivery({ companyId, id, deliveryTrackingInfo }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/dispatch`, { method: 'POST', body: { deliveryTrackingInfo }, safeRetryAuth: false }); return Object.freeze({ accepted: result.status === 202, confirmation: 'pending' }); },
    async markDeliveredSelfDelivery({ companyId, id, body = {} }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/delivered`, { method: 'POST', body, safeRetryAuth: false }); return Object.freeze({ accepted: result.status === 202, confirmation: 'pending' }); },
    async sendSelfDeliveryTracking({ companyId, id, deliveryTrackingInfo }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/tracking`, { method: 'POST', body: { deliveryTrackingInfo }, safeRetryAuth: false }); return Object.freeze({ accepted: result.status === 202, confirmation: 'pending' }); }
  });
}

module.exports = { KeetaError, normalizeKeetaOrder, createKeetaAdapter };
