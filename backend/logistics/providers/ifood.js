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
  const surcharge = raw.quote.raise == null ? 0 : decimalToMinor(raw.quote.raise, 'raise');
  if (discount > gross) fail('INVALID_PROVIDER_RESPONSE');
  const amountMinor = raw.quote.netValue == null ? gross - discount + surcharge : decimalToMinor(raw.quote.netValue, 'net_value');
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw.id) ||
      typeof raw.orderId !== 'string' || !UUID.test(raw.orderId) || typeof raw.fullCode !== 'string' || raw.fullCode.length < 1 || raw.fullCode.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw.fullCode)) fail('INVALID_PROVIDER_EVENT');
  const allowed = new Map([
    ['REQUEST_DRIVER_SUCCESS', 'accepted'], ['ASSIGN_DRIVER', 'accepted'], ['DELIVERY_CANCELLATION_REQUEST_ACCEPTED', 'cancelled'],
    ['DELIVERY_CANCELLATION_REQUEST_REJECTED', 'cancel_rejected'], ['REQUEST_DRIVER_FAILED', 'failed'], ['DELIVERY_IN_TRANSIT', 'in_progress'],
    ['DELIVERY_CONCLUDED', 'completed'], ['DELIVERY_CANCELLED', 'cancelled']
  ]);
  return Object.freeze({ provider: 'ifood', externalEventId: raw.id, externalOrderId: raw.orderId,
    occurredAt: raw.createdAt ? timestamp(raw.createdAt, 'event_time') : null,
    status: allowed.get(raw.fullCode) || 'unmapped', externalStatus: raw.fullCode });
}

function normalizeOrder(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !UUID.test(raw.id || '') || !raw.customer || !raw.delivery || !Array.isArray(raw.items)) fail('INVALID_PROVIDER_ORDER');
  const address = raw.delivery.deliveryAddress || {};
  const items = raw.items.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name || !Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) fail('INVALID_PROVIDER_ORDER');
    return Object.freeze({ name: item.name.slice(0, 240), quantity: Number(item.quantity), ...(item.unitPrice?.value != null ? { unitPrice: item.unitPrice.value } : {}) });
  });
  const addressText = [address.streetName, address.streetNumber, address.complement, address.neighborhood, address.city, address.state, address.postalCode].filter(value => typeof value === 'string' && value.trim()).join(', ');
  const customer = Object.freeze({ name: typeof raw.customer.name === 'string' ? raw.customer.name.slice(0, 160) : '',
    phone: typeof raw.customer.phone?.number === 'string' ? raw.customer.phone.number.slice(0, 32) : '' });
  return Object.freeze({ source: 'ifood', externalId: raw.id, externalDisplayId: typeof raw.displayId === 'string' ? raw.displayId.slice(0, 64) : null,
    status: typeof raw.status === 'string' ? raw.status : null, customer, address: addressText.slice(0, 800), items: Object.freeze(items),
    orderType: raw.orderType === 'TAKEOUT' ? 'TAKEOUT' : 'DELIVERY', createdAt: raw.createdAt ? timestamp(raw.createdAt, 'order_created_at') : null });
}

function normalizeOrderEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string' || raw.id.length < 1 || raw.id.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw.id) ||
      typeof raw.orderId !== 'string' || !UUID.test(raw.orderId) || typeof raw.fullCode !== 'string' || raw.fullCode.length < 1 || raw.fullCode.length > 128 || /[\u0000-\u001f\u007f]/u.test(raw.fullCode)) fail('INVALID_PROVIDER_EVENT');
  const states = new Map([['PLACED','placed'],['ORDER_PLACED','placed'],['CONFIRMED','confirmed'],['ORDER_CONFIRMED','confirmed'],
    ['PREPARATION_STARTED','preparing'],['PREPARATION_ENDED','ready'],['SEPARATION_ENDED','ready'],['READY_TO_PICKUP','ready'],['ORDER_READY_TO_PICKUP','ready'],
    ['DISPATCHED','dispatched'],['ORDER_DISPATCHED','dispatched'],['CONCLUDED','completed'],['ORDER_CONCLUDED','completed'],
    ['CANCELLED','cancelled'],['ORDER_CANCELLED','cancelled'],['CANCELLATION_REQUESTED','cancellation_requested'],['ORDER_PATCHED','modified']]);
  return Object.freeze({ provider: 'ifood', externalEventId: raw.id, externalOrderId: raw.orderId,
    merchantId: typeof raw.merchantId === 'string' ? raw.merchantId : null,
    occurredAt: raw.createdAt ? timestamp(raw.createdAt, 'event_time') : null, status: states.get(raw.fullCode) || 'unmapped', externalStatus: raw.fullCode });
}

function createIfoodAdapter({ credentialResolver, persistToken = async () => {}, fetchImpl = globalThis.fetch, timeoutMs = 8000, clock = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), orderDetailRetryWindowMs = 10 * 60 * 1000 } = {}) {
  if (typeof credentialResolver !== 'function' || typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new TypeError('Configuração de adapter iFood inválida.');
  const tokens = new Map();
  const trackingRequests = new Map();
  async function request(path, { method = 'GET', body, credentials, authRetries = 0 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = { Accept: 'application/json' };
      if (credentials) {
        const credentialKey = crypto.createHash('sha256').update(`${credentials.clientId}\0${credentials.clientSecret}\0${credentials.accountScope || ''}`).digest('hex');
        let cached = tokens.get(credentialKey);
        if(!cached&&typeof credentials.accessToken==='string'&&credentials.accessToken){
          cached={value:credentials.accessToken,refreshToken:credentials.refreshToken||null,expiresAt:Number.isFinite(credentials.tokenExpiresAt)?credentials.tokenExpiresAt:clock()+60_000};
          tokens.set(credentialKey,cached);
        }
        if (!cached || cached.expiresAt <= clock() + 60000) {
          const refreshToken = cached?.refreshToken || credentials.refreshToken;
          const grantType = refreshToken ? 'refresh_token' : credentials.authorizationCode ? 'authorization_code' : 'client_credentials';
          if (grantType === 'authorization_code' && (typeof credentials.authorizationCodeVerifier !== 'string' || !credentials.authorizationCodeVerifier)) fail('AUTHORIZATION_VERIFIER_REQUIRED', 'auth');
          const fields = { grantType, clientId: credentials.clientId, clientSecret: credentials.clientSecret };
          if (grantType === 'refresh_token') fields.refreshToken = refreshToken;
          else if (grantType === 'authorization_code') { fields.authorizationCode = credentials.authorizationCode; fields.authorizationCodeVerifier = credentials.authorizationCodeVerifier; }
          const form = new URLSearchParams(fields);
          const auth = await fetchImpl(`${API}/authentication/v1.0/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, signal: controller.signal, redirect: 'error' });
          const authRaw = await readResponse(auth);
          if (auth.status === 401 || auth.status === 403) fail('AUTH_REJECTED', 'auth', auth.status);
          if (!auth.ok) fail('AUTH_SERVICE_ERROR', auth.status === 429 || auth.status >= 500 ? 'transient' : 'permanent', auth.status, retryAfter(auth));
          if (!authRaw || typeof authRaw.accessToken !== 'string' || authRaw.accessToken.length > 8000 || !Number.isInteger(authRaw.expiresIn) || authRaw.expiresIn < 60) fail('INVALID_AUTH_RESPONSE');
          cached={ value: authRaw.accessToken, refreshToken: authRaw.refreshToken || refreshToken || null, expiresAt: clock() + authRaw.expiresIn * 1000 };
          tokens.set(credentialKey,cached);
          await persistToken({companyId:credentials.companyId||null,accountScope:credentials.accountScope||null,
            accessToken:cached.value,refreshToken:cached.refreshToken,expiresAt:cached.expiresAt});
        }
        headers.Authorization = `Bearer ${tokens.get(credentialKey).value}`;
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetchImpl(`${API}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: 'error' });
      const data = response.status === 204 ? null : await readResponse(response);
      if (response.status === 401) {
        const credentialKey = crypto.createHash('sha256').update(`${credentials.clientId}\0${credentials.clientSecret}\0${credentials.accountScope || ''}`).digest('hex');
        const previous = tokens.get(credentialKey);
        if (previous?.refreshToken) credentials.refreshToken = previous.refreshToken;
        tokens.delete(credentialKey);
        if (authRetries < 1) return request(path, { method, body, credentials, authRetries: authRetries + 1 });
        fail('AUTH_EXPIRED', 'auth', 401);
      }
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
  async function invoke(companyId, method, suppliedCredentials) {
    if (typeof companyId !== 'string' || !UUID.test(companyId)) fail('INVALID_TENANT');
    let credentials = suppliedCredentials;
    if (!credentials) { try { credentials = await credentialResolver(companyId, 'ifood'); } catch (_) { fail('CREDENTIALS_UNAVAILABLE', 'auth'); } }
    if (!credentials || typeof credentials.clientId !== 'string' || !credentials.clientId || typeof credentials.clientSecret !== 'string' || !credentials.clientSecret) fail('CREDENTIALS_UNAVAILABLE', 'auth');
    // Marketplace credentials are scoped to the external account so refresh
    // rotation is persisted against the account that owns the grant. Legacy
    // logistics callers still fall back to their tenant scope.
    return method({ ...credentials, accountScope: credentials.accountScope || companyId });
  }
  return Object.freeze({ provider: 'ifood', capabilities: CAPABILITIES,
    async pollEvents({ companyId, credentials: supplied } = {}) { return invoke(companyId, async credentials => {
      const result = await request('/order/v1.0/orders:polling', { credentials });
      if (result.status === 204) return Object.freeze([]);
      if (!Array.isArray(result.data?.events)) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze(result.data.events.map(event => Object.freeze({ id: event.id, code: event.code, fullCode: event.fullCode,
        orderId: event.orderId, merchantId: event.merchantId, createdAt: event.createdAt })));
    }, supplied); },
    async requestUserCode({ companyId, credentials: supplied } = {}) { return invoke(companyId, async credentials => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(`${API}/authentication/v1.0/oauth/userCode`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams({ clientId: credentials.clientId }), signal: controller.signal, redirect: 'error'
        });
        const data = await readResponse(response);
        if (response.status === 401 || response.status === 403) fail('AUTH_REJECTED','auth',response.status);
        if (!response.ok) fail('AUTH_SERVICE_ERROR',response.status===429||response.status>=500?'transient':'permanent',response.status,retryAfter(response));
        const url = value => { try { const parsed=new URL(value); return parsed.protocol==='https:'&&parsed.hostname==='portal.ifood.com.br'&&!parsed.username&&!parsed.password ? parsed.toString():null; } catch (_) { return null; } };
        if (!data || typeof data.userCode!=='string' || data.userCode.length>32 || typeof data.authorizationCodeVerifier!=='string' ||
            data.authorizationCodeVerifier.length>512 || !Number.isInteger(data.expiresIn) || data.expiresIn<1 || data.expiresIn>600 ||
            !url(data.verificationUrl) || !url(data.verificationUrlComplete)) fail('INVALID_AUTH_RESPONSE','auth');
        return Object.freeze({ userCode:data.userCode, verificationUrl:url(data.verificationUrl),
          verificationUrlComplete:url(data.verificationUrlComplete), expiresIn:data.expiresIn,
          authorizationCodeVerifier:data.authorizationCodeVerifier });
      } catch(error) { if(error instanceof ProviderError)throw error; fail(error?.name==='AbortError'?'PROVIDER_TIMEOUT':'PROVIDER_UNAVAILABLE','unknown'); }
      finally { clearTimeout(timer); }
    },supplied); },
    async exchangeAuthorizationCode({ companyId, authorizationCode, authorizationCodeVerifier, credentials: supplied } = {}) { return invoke(companyId, async credentials => {
      if(typeof authorizationCode!=='string'||!authorizationCode.trim()||authorizationCode.length>512||typeof authorizationCodeVerifier!=='string'||!authorizationCodeVerifier) fail('INVALID_AUTHORIZATION_CODE','auth');
      const form=new URLSearchParams({grantType:'authorization_code',clientId:credentials.clientId,clientSecret:credentials.clientSecret,
        authorizationCode,authorizationCodeVerifier});
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try {
        const response=await fetchImpl(`${API}/authentication/v1.0/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:form,signal:controller.signal,redirect:'error'});
        const data=await readResponse(response);
        if(response.status===401||response.status===403)fail('AUTH_REJECTED','auth',response.status);
        if(!response.ok)fail('AUTH_SERVICE_ERROR',response.status===429||response.status>=500?'transient':'permanent',response.status,retryAfter(response));
        if(!data||typeof data.accessToken!=='string'||data.accessToken.length>8000||!Number.isInteger(data.expiresIn)||data.expiresIn<60||typeof data.refreshToken!=='string'||!data.refreshToken)fail('INVALID_AUTH_RESPONSE','auth');
        return Object.freeze({accessToken:data.accessToken,refreshToken:data.refreshToken,expiresIn:data.expiresIn});
      }catch(error){if(error instanceof ProviderError)throw error;fail(error?.name==='AbortError'?'PROVIDER_TIMEOUT':'PROVIDER_UNAVAILABLE','unknown');}
      finally{clearTimeout(timer);}
    },supplied); },
    async acknowledgeEvents({ companyId, eventIds, credentials: supplied } = {}) { return invoke(companyId, async credentials => {
      if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 100 || eventIds.some(id => typeof id !== 'string' || id.length < 1 || id.length > 128 || /[\u0000-\u001f\u007f]/u.test(id))) fail('INVALID_EVENT_IDS');
      const result = await request('/order/v1.0/orders:acknowledgment', { method: 'POST', body: { acknowledgedEventIds: eventIds }, credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ acknowledged: true, confirmation: 'pending' });
    }, supplied); },
    async confirmOrder({ companyId, orderId, credentials: supplied } = {}) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/order/v1.0/orders/${orderId}/confirm`, { method: 'POST', credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    }, supplied); },
    async startPreparation({ companyId, orderId, credentials: supplied } = {}) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/order/v1.0/orders/${orderId}/startPreparation`, { method: 'POST', credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    }, supplied); },
    async readyToPickup({ companyId, orderId, credentials: supplied } = {}) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/order/v1.0/orders/${orderId}/readyToPickup`, { method: 'POST', credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    }, supplied); },
    async dispatchMerchantDelivery({ companyId, orderId, credentials: supplied } = {}) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/order/v1.0/orders/${orderId}/dispatch`, { method: 'POST', body: { deliveredBy: 'MERCHANT' }, credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    }, supplied); },
    async cancellationReasons({ companyId, orderId, credentials: supplied } = {}) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/order/v1.0/orders/${orderId}/cancellationReasons`, { credentials });
      if (!Array.isArray(result.data?.reasons)) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze(result.data.reasons.map(item => {
        if (!item || typeof item.code !== 'string' || !item.code || typeof item.description !== 'string') fail('INVALID_PROVIDER_RESPONSE');
        return Object.freeze({ code: item.code, description: item.description.slice(0, 160) });
      }));
    }, supplied); },
    async requestOrderCancellation({ companyId, orderId, reason, credentials: supplied } = {}) { uuid(orderId, 'order_id'); if (typeof reason !== 'string' || !reason.trim() || reason.length > 64 || /[\u0000-\u001f\u007f]/u.test(reason)) fail('INVALID_CANCELLATION_REASON'); return invoke(companyId, async credentials => {
      const result = await request(`/order/v1.0/orders/${orderId}/requestCancellation`, { method: 'POST', body: { reason }, credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ accepted: true, confirmation: 'pending' });
    }, supplied); },
    async order({ companyId, orderId, credentials: supplied } = {}) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const started = clock(); let attempt = 0;
      while (true) {
        try { const result = await request(`/order/v1.0/orders/${orderId}`, { credentials }); return normalizeOrder(result.data); }
        catch (error) {
          // iFood documents temporary 404 while the order detail is still being made available.
          // Only this safe GET is retried, bounded to the documented ten-minute window.
          if (error?.status !== 404 || clock() - started >= orderDetailRetryWindowMs) throw error;
          const delay = Math.min(5000, 250 * (2 ** Math.min(attempt++, 4)), Math.max(0, orderDetailRetryWindowMs - (clock() - started)));
          if (!delay) throw error;
          await sleep(delay);
        }
      }
    }, supplied); },
    async merchants({ companyId, credentials: supplied } = {}) { return invoke(companyId, async credentials => {
      const result = await request('/merchant/v1.0/merchants', { credentials });
      if (!Array.isArray(result.data)) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze(result.data.map(merchant => Object.freeze({ id: uuid(merchant.id, 'merchant_id'), name: typeof merchant.name === 'string' ? merchant.name.slice(0, 160) : '' })));
    }, supplied); },
    async quote({ companyId, orderId, credentials: supplied }) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/shipping/v1.0/orders/${orderId}/deliveryAvailabilities`, { credentials });
      return quoteFromResponse(result.data, clock());
    }, supplied); },
    async dispatch({ companyId, orderId, quoteId, credentials: supplied }) { uuid(orderId, 'order_id'); uuid(quoteId, 'quote_id'); return invoke(companyId, async credentials => {
      const result = await request(`/shipping/v1.0/orders/${orderId}/requestDriver`, { method: 'POST', body: { quoteId }, credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ provider: 'ifood', status: 'requested', confirmation: 'pending' });
    }, supplied); },
    async cancel({ companyId, orderId, credentials: supplied }) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const result = await request(`/shipping/v1.0/orders/${orderId}/cancelRequestDriver`, { method: 'POST', body: {}, credentials });
      if (result.status !== 202) fail('INVALID_PROVIDER_RESPONSE');
      return Object.freeze({ provider: 'ifood', status: 'requested', confirmation: 'pending' });
    }, supplied); },
    async tracking({ companyId, orderId, credentials: supplied }) { uuid(orderId, 'order_id'); return invoke(companyId, async credentials => {
      const trackingKey = `${companyId}:${orderId}`;
      const previous = trackingRequests.get(trackingKey);
      const elapsed = previous == null ? Infinity : clock() - previous;
      if (elapsed < 30_000) fail('TRACKING_RATE_LIMITED', 'rate_limit', 429, Math.ceil((30_000 - elapsed) / 1000));
      trackingRequests.set(trackingKey, clock());
      const result = await request(`/shipping/v1.0/orders/${orderId}/tracking`, { credentials });
      return trackingFromResponse(result.data);
    }, supplied); },
    verifyWebhook: verifyWebhookSignature,
    normalizeDeliveryEvent, normalizeOrderEvent
  });
}

module.exports = { API, CAPABILITIES, ProviderError, decimalToMinor, quoteFromResponse, trackingFromResponse, verifyWebhookSignature, normalizeDeliveryEvent, normalizeOrderEvent, normalizeOrder, createIfoodAdapter };
