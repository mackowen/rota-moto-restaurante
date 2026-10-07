'use strict';

const crypto = require('node:crypto');
const { API, signRequest, canonicalJson, opaqueId } = require('./keeta-protocol');
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

function normalizeKeetaOrder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !opaqueId(raw.id) || !Array.isArray(raw.items)) throw new KeetaError('INVALID_PROVIDER_ORDER', 'permanent');
  // Customer/address details may be encrypted or desensitized by Keeta. Keep the
  // adapter projection free of PII; a future fulfillment boundary must decrypt
  // only when contractually required and must not persist the result here.
  const items = raw.items.map(item => {
    if (!item || typeof item.name !== 'string' || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) throw new KeetaError('INVALID_PROVIDER_ORDER', 'permanent');
    return Object.freeze({ name: item.name.slice(0, 240), quantity: Number(item.quantity) });
  });
  return Object.freeze({ source: 'keeta', externalId: String(raw.id), externalDisplayId: typeof raw.displayId === 'string' ? raw.displayId.slice(0, 64) : null,
    status: typeof raw.lastEvent === 'string' ? raw.lastEvent : null, orderType: ['DELIVERY','TAKEOUT','INDOOR'].includes(raw.type) ? raw.type : null,
    createdAt: raw.createdAt || null, items: Object.freeze(items) });
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
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > 256 * 1024) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent');
    let text;
    if (response.body?.getReader) {
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) { await reader.cancel().catch(() => {}); throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock?.(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await response.text();
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
    if (credentials.refreshToken || credentials.authorizationCode) throw new KeetaError('SHOP_LEVEL_TOKEN_FIELDS_UNVERIFIED', 'auth');
    const body = { client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: 'app_level_token' };
    const result = await fetchJson(`${API}/oauth/token`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: canonicalJson(body) });
    if (typeof result.data?.access_token !== 'string' || !result.data.access_token || !Number.isInteger(result.data.expires_in) || result.data.expires_in < 30) throw new KeetaError('INVALID_AUTH_RESPONSE', 'auth');
    const value = { accessToken: result.data.access_token, expiresAt: clock() + result.data.expires_in * 1000 };
    tokenCache.set(key, value);
    await persistToken({ key, expiresAt: value.expiresAt });
    return value.accessToken;
  }
  async function call(companyId, path, { method = 'GET', query = {}, body, headers = {}, credentials: supplied = null } = {}) {
    if (typeof companyId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(companyId)) throw new KeetaError('INVALID_TENANT', 'permanent');
    let credentials=supplied;
    if(!credentials)try { credentials = await credentialResolver(companyId, 'keeta'); } catch (_) { throw new KeetaError('CREDENTIALS_UNAVAILABLE', 'auth'); }
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
  function orderId(id) { if (!opaqueId(id)) throw new KeetaError('INVALID_ORDER_ID', 'permanent'); return encodeURIComponent(id); }
  return Object.freeze({ provider: 'keeta',
    async onboardMerchant({ companyId, merchantId, keetaMerchantId, ordersWebhookURL, credentials: supplied }) {
      if (!opaqueId(merchantId) || !Number.isSafeInteger(keetaMerchantId) || keetaMerchantId < 1 || typeof ordersWebhookURL !== 'string')
        throw new KeetaError('INVALID_MERCHANT_BINDING','permanent');
      let url;try{url=new URL(ordersWebhookURL);}catch(_){throw new KeetaError('INVALID_WEBHOOK_URL','permanent');}
      if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new KeetaError('INVALID_WEBHOOK_URL','permanent');
      const result=await call(companyId,'/v1/merchantOnboarding',{method:'PUT',query:{merchantId},
        body:{ordersWebhookURL:url.toString(),keetaMerchantId},credentials:supplied});
      if(result.status!==201)throw new KeetaError('INVALID_PROVIDER_RESPONSE','permanent',result.status);
      return Object.freeze({registered:true});
    },
    async authorizationUrl({ companyId, redirectUri, state, credentials: supplied }) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{24,128}$/u.test(state)) throw new KeetaError('INVALID_OAUTH_STATE', 'permanent');
      let callback;
      try { callback = new URL(redirectUri); } catch (_) { throw new KeetaError('INVALID_CALLBACK_URL', 'permanent'); }
      if (callback.protocol !== 'https:' || callback.username || callback.password) throw new KeetaError('INVALID_CALLBACK_URL', 'permanent');
      callback.searchParams.set('state', state);
      let c=supplied;
      if(!c)try { c = await credentialResolver(companyId, 'keeta'); } catch (_) { throw new KeetaError('CREDENTIALS_UNAVAILABLE', 'auth'); }
      if (!c || typeof c.clientId !== 'string' || !c.clientId) throw new KeetaError('CREDENTIALS_UNAVAILABLE', 'auth');
      // The documented authorization URL is the bootstrap step and has no OAuth
      // security requirement. It must remain callable before any merchant has
      // authorized the app (when an app-level token may not yet be obtainable).
      const query = new URLSearchParams({ clientId: c.clientId, redirectUri: callback.toString() });
      const response = await fetchJson(`${API}/oauth/authorization/url?${query}`, { method: 'GET', headers: { Accept: 'application/json' } });
      const authorization = response.data?.merchantAuthorizationUrl;
      if (typeof authorization !== 'string') throw new KeetaError('INVALID_AUTH_RESPONSE', 'auth');
      let destination;
      try { destination = new URL(authorization); } catch (_) { throw new KeetaError('INVALID_AUTH_RESPONSE', 'auth'); }
      if (destination.protocol !== 'https:' || destination.hostname !== 'merchant.mykeeta.com') throw new KeetaError('INVALID_AUTH_RESPONSE', 'auth');
      return destination.toString();
    },
    async merchantInfo({ companyId, authId, credentials: supplied }) {
      if (!opaqueId(authId)) throw new KeetaError('INVALID_AUTH_ID', 'permanent');
      const authorizedShops=[]; let first=null; let totalPages=1;
      for(let pageNum=1;pageNum<=totalPages;pageNum++) {
        const result=(await call(companyId,`/oauth/authorized/${encodeURIComponent(authId)}/merchantInfo`,{query:{pageNum,pageSize:100},credentials:supplied})).data;
        if(!result||!Array.isArray(result.authorizedShops)||!result.page||!Number.isInteger(result.page.totalPage)||result.page.totalPage<1||result.page.totalPage>1000||result.page.pageNum!==pageNum)
          throw new KeetaError('INVALID_PROVIDER_RESPONSE','permanent');
        if(first===null)first={...result};
        totalPages=result.page.totalPage;
        authorizedShops.push(...result.authorizedShops);
        if(authorizedShops.length>100000)throw new KeetaError('INVALID_PROVIDER_RESPONSE','permanent');
      }
      return Object.freeze({...first,authorizedShops:Object.freeze(authorizedShops)});
    },
    async pollEvents({ companyId, serviceMerchantIds, eventTypes }) {
      // Keeta's contract expects IDs assigned by the Software Service for each
      // mapped store, not the Keeta merchant ID. The runtime must resolve these
      // from its trusted account binding before polling.
      if (!Array.isArray(serviceMerchantIds) || !serviceMerchantIds.length || serviceMerchantIds.length > 100 || serviceMerchantIds.some(id => !opaqueId(id) || id.includes(','))) throw new KeetaError('INVALID_MERCHANTS', 'permanent');
      if (eventTypes && (!Array.isArray(eventTypes) || !eventTypes.length || eventTypes.length > 13 || eventTypes.some(type => !opaqueId(type) || type.includes(',')))) throw new KeetaError('INVALID_EVENT_TYPES', 'permanent');
      const query = eventTypes ? { eventType: eventTypes.join(',') } : {};
      const result = await call(companyId, '/v1/events:polling', { query, headers: { 'x-polling-merchants': serviceMerchantIds.join(',') } });
      if (result.status === 204) return Object.freeze([]);
      if (!Array.isArray(result.data)) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent');
      return Object.freeze(result.data.map(event => {
        if (!opaqueId(event.eventId) || !opaqueId(event.orderId) || typeof event.eventType !== 'string' || !opaqueId(event.eventType)) throw new KeetaError('INVALID_PROVIDER_EVENT', 'permanent');
        return Object.freeze({ id: String(event.eventId), orderId: String(event.orderId), eventType: event.eventType, createdAt: event.createdAt });
      }));
    },
    async acknowledgeEvents({ companyId, events }) {
      if (!Array.isArray(events) || !events.length || events.length > 100 || events.some(event => !opaqueId(event?.id) || !opaqueId(event?.orderId) || !opaqueId(event?.eventType))) throw new KeetaError('INVALID_EVENT_IDS', 'permanent');
      const result = await call(companyId, '/v1/events/acknowledgment', { method: 'POST', body: events.map(({ id, orderId: oid, eventType }) => ({ id, orderId: oid, eventType })) });
      if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent');
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    },
    async order({ companyId, id }) { return normalizeKeetaOrder((await call(companyId, `/v1/orders/${orderId(id)}`)).data); },
    async confirm({ companyId, id, orderExternalCode, createdAt, preparationTime }) {
      const body = { orderExternalCode, createdAt, ...(Number.isInteger(preparationTime) ? { preparationTime } : {}) };
      const result = await call(companyId, `/v1/orders/${orderId(id)}/confirm`, { method: 'POST', body });
      if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent', result.status);
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    },
    async readyForPickup({ companyId, id }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/readyForPickup`, { method: 'POST' }); if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent', result.status); return Object.freeze({ accepted: true, confirmation: 'pending' }); },
    async requestCancellation({ companyId, id, reason, code, mode = 'MANUAL', outOfStockItems = [], invalidItems = [] }) {
      const allowed = new Set(['SYSTEMIC_ISSUES','DUPLICATE_APPLICATION','UNAVAILABLE_ITEM','RESTAURANT_WITHOUT_DELIVERY_PERSON','OUTDATED_MENU','ORDER_OUTSIDE_THE_DELIVERY_AREA','BLOCKED_CUSTOMER','OUTSIDE_DELIVERY_HOURS','INTERNAL_DIFFICULTIES_OF_THE_RESTAURANT','RISK_AREA','DELIVERY_PROBLEM']);
      if (typeof reason !== 'string' || !reason.trim() || !allowed.has(code) || !['AUTO','MANUAL'].includes(mode)) throw new KeetaError('INVALID_CANCELLATION', 'permanent');
      const result = await call(companyId, `/v1/orders/${orderId(id)}/requestCancellation`, { method: 'POST', body: { reason: reason.slice(0, 500), code, mode, outOfStockItems: outOfStockItems.slice(0, 100), invalidItems: invalidItems.slice(0, 100) } });
      if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent', result.status);
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    },
    async dispatchSelfDelivery({ companyId, id, deliveryTrackingInfo }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/dispatch`, { method: 'POST', body: { deliveryTrackingInfo } }); if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent', result.status); return Object.freeze({ accepted: true, confirmation: 'pending' }); },
    async markDeliveredSelfDelivery({ companyId, id, body = {} }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/delivered`, { method: 'POST', body }); if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent', result.status); return Object.freeze({ accepted: true, confirmation: 'pending' }); },
    async sendSelfDeliveryTracking({ companyId, id, deliveryTrackingInfo }) { const result = await call(companyId, `/v1/orders/${orderId(id)}/tracking`, { method: 'POST', body: { deliveryTrackingInfo } }); if (result.status !== 202) throw new KeetaError('INVALID_PROVIDER_RESPONSE', 'permanent', result.status); return Object.freeze({ accepted: true, confirmation: 'pending' }); }
  });
}

module.exports = { KeetaError, normalizeKeetaOrder, createKeetaAdapter };
