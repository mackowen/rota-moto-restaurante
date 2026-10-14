'use strict';

// 99Food "99Food Protocol (Recommended)" contract. This module deliberately
// has no network or persistence side effects unless an adapter is constructed
// with an injected transport. Open Delivery is a separate protocol.
const crypto = require('node:crypto');

const API = 'https://openapi.99food.com';
const MAX_BODY = 256 * 1024;
const OPAQUE = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const SHOP_ID = /^[^\u0000-\u0020\u007f]{1,128}$/u;
const ORDER_STATUS = Object.freeze({
  100: 'placed', 200: 'confirmed', 400: 'dispatched', 500: 'arrived', 600: 'completed',
  901: 'cancelled', 902: 'cancelled', 903: 'cancelled', 921: 'cancelled', 922: 'cancelled',
  923: 'cancelled', 941: 'cancelled', 942: 'cancelled', 943: 'cancelled', 944: 'cancelled',
  945: 'cancelled', 946: 'cancelled', 961: 'cancelled', 971: 'cancelled', 981: 'cancelled'
});
const WEBHOOK_TYPES = new Set(['orderNew','orderCancel','orderFinish','deliveryStatus','orderCancelApply',
  'orderRefundApply','orderPartialCancel']);
const CURRENCY_BY_COUNTRY = Object.freeze({ BR:'BRL',MX:'MXN',CO:'COP',CR:'CRC',PE:'PEN' });

function fail(code, status = 400) { return Object.assign(new Error('99Food request rejected.'), { code, status }); }
function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function minor(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

function normalizeItem(item, depth=0) {
  if(!isRecord(item)||typeof item.name!=='string'||item.name.length>240||!Number.isSafeInteger(item.amount)||item.amount<1||item.amount>1_000_000||
    depth>5||!Array.isArray(item.sub_item_list)||item.sub_item_list.length>100)throw fail('INVALID_PROVIDER_RESPONSE',502);
  const skuPrice=minor(item.sku_price),lineTotal=minor(item.total_price),paid=minor(item.real_price);
  if(skuPrice===null||lineTotal===null)throw fail('INVALID_PROVIDER_RESPONSE',502);
  const options=item.sub_item_list.map(child=>normalizeItem(child,depth+1));
  const readPromotion=value=>{
    if(!isRecord(value)||!Number.isSafeInteger(value.promo_type)||minor(value.promo_discount)===null||minor(value.shop_subside_price)===null)
      throw fail('INVALID_PROVIDER_RESPONSE',502);
    return Object.freeze({type:value.promo_type,discountMinor:value.promo_discount,storeSubsidyMinor:value.shop_subside_price});
  };
  const summary=Array.isArray(item.promotion_detail)?item.promotion_detail.slice(0,100).map(readPromotion):
    isRecord(item.promotion_detail)?[readPromotion(item.promotion_detail)]:[];
  const promos=Array.isArray(item.promo_list)?item.promo_list.slice(0,100).map(readPromotion):[];
  return Object.freeze({name:item.name.slice(0,240),quantity:item.amount,unitPriceMinor:skuPrice,lineTotalMinor:lineTotal,
    ...(paid===null?{}:{paidMinor:paid}),...(typeof item.app_item_id==='string'?{providerItemId:item.app_item_id.slice(0,128)}:{}),
    ...(typeof item.remark==='string'&&item.remark?{notes:item.remark.slice(0,500)}:{}),options:Object.freeze(options),
    promotionSummary:Object.freeze(summary),promotions:Object.freeze(promos)});
}

function normalizeMoney(info, deliveryType, fulfillmentMode) {
  const price=info.price;
  if(!isRecord(price))return null;
  const currency=typeof info.currency==='string'&&/^[A-Z]{3}$/u.test(info.currency)?info.currency:
    typeof price.currency==='string'&&/^[A-Z]{3}$/u.test(price.currency)?price.currency:CURRENCY_BY_COUNTRY[info.country]||null;
  if(!currency)return null;
  const components={};
  const subtotal=minor(price.order_price);if(subtotal!==null)components.itemsSubtotalMinor=subtotal;
  const discount=minor(price.items_discount);if(discount!==null)components.discountMinor=discount;
  const delivery=minor(price.delivery_price)??minor(price.store_charged_delivery_price);if(delivery!==null)components.deliveryFeeMinor=delivery;
  const service=minor(price.service_price)??minor(price.others_fees?.service_price);if(service!==null)components.serviceFeeMinor=service;
  const fees=price.others_fees;
  if(isRecord(fees)){
    const small=minor(fees.small_order_price),tip=minor(fees.total_tip_money),topup=minor(fees.meal_top_up_price),coupon=minor(fees.coupon_discount);
    const totalFees=small+tip+topup;
    if(small!==null&&tip!==null&&topup!==null&&coupon!==null&&totalFees>=coupon&&Number.isSafeInteger(totalFees-coupon))components.otherFeeMinor=totalFees-coupon;
  }
  const total=minor(price.customer_need_paying_money)??minor(price.real_pay_price)??minor(price.real_price);
  if(total!==null)components.totalMinor=total;
  if(!Object.keys(components).length)return null;
  return Object.freeze({currency,completeness:'partial',provenance:Object.freeze({kind:'external',sourceId:'99food'}),components:Object.freeze(components)});
}

function normalizePriceBreakdown(info) {
  if(!isRecord(info.price))return null;
  const fields=['order_price','items_discount','delivery_discount','delivery_price','store_charged_delivery_price','real_price',
    'real_pay_price','refund_price','shop_paid_money','customer_need_paying_money','meal_top_up_price','service_price','in_sale_refund_to_c_fee','logistics_cost'];
  const result={};for(const field of fields){const value=minor(info.price[field]);if(value!==null)result[field]=value;}
  if(isRecord(info.price.others_fees)){
    const other={};for(const field of ['small_order_price','total_tip_money','service_price','coupon_discount','meal_top_up_price']){
      const value=minor(info.price.others_fees[field]);if(value!==null)other[field]=value;
    }
    if(Object.keys(other).length)result.others_fees=Object.freeze(other);
  }
  return Object.keys(result).length?Object.freeze(result):null;
}

// Preserve integers outside Number's safe range for documented Long IDs.
// Only integer values on *_id keys are converted; monetary/count fields remain numbers.
function parseLosslessJson(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_BODY) throw fail('INVALID_WEBHOOK');
  const text = raw.toString('utf8');
  const safe = text.replace(/("[A-Za-z][A-Za-z0-9_]*_id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/gu, (_m, prefix, number) =>
    BigInt(number) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(number) < BigInt(Number.MIN_SAFE_INTEGER)
      ? `${prefix}${JSON.stringify(number)}` : `${prefix}${number}`);
  try { return JSON.parse(safe); } catch (_) { throw fail('INVALID_WEBHOOK'); }
}

function md5(value) { return crypto.createHash('md5').update(value, 'utf8').digest(); }
function verifyWebhook(rawBody, signature, appSecret) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > MAX_BODY ||
      typeof signature !== 'string' || !/^[a-f0-9]{32}$/iu.test(signature) ||
      typeof appSecret !== 'string' || !appSecret) return false;
  const expected = crypto.createHash('md5').update(Buffer.concat([rawBody, Buffer.from(appSecret, 'utf8')])).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function signParams(params, appSecret) {
  if (!isRecord(params) || typeof appSecret !== 'string' || !appSecret) throw new TypeError('99Food signing credentials unavailable.');
  const pairs = Object.keys(params).filter(key => key !== 'sign' && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'ascii'), Buffer.from(b, 'ascii')))
    .map(key => `${key}=${Array.isArray(params[key]) || isRecord(params[key]) ? 'Array' : String(params[key])}`);
  return crypto.createHash('md5').update(`${pairs.join('&')}${appSecret}`, 'utf8').digest('hex');
}

function webhookEvent(rawBody, signature, appSecret) {
  if (!verifyWebhook(rawBody, signature, appSecret)) throw fail('INVALID_SIGNATURE', 401);
  const payload = parseLosslessJson(rawBody);
  if (!isRecord(payload) || typeof payload.app_shop_id !== 'string' || !SHOP_ID.test(payload.app_shop_id) ||
      !Number.isSafeInteger(payload.timestamp) || payload.timestamp <= 0 || payload.timestamp > 8_640_000_000 || typeof payload.type !== 'string' ||
      !WEBHOOK_TYPES.has(payload.type) || !isRecord(payload.data)) throw fail('INVALID_WEBHOOK');
  const info = isRecord(payload.data.order_info) ? payload.data.order_info : payload.data;
  const rawId = payload.data.order_id ?? info.order_id;
  const orderId = typeof rawId === 'string' ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : null;
  if (!orderId || !OPAQUE.test(orderId)) throw fail('INVALID_WEBHOOK');
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex');
  const applicationId=payload.data.apply_id===undefined?null:String(payload.data.apply_id);
  if(['orderCancelApply','orderRefundApply'].includes(payload.type)&&(!applicationId||!OPAQUE.test(applicationId)))throw fail('INVALID_WEBHOOK');
  const reasons=(values,key,label)=>Array.isArray(values)?Object.freeze(values.slice(0,30).flatMap(item=>{
    if(!isRecord(item)||typeof item[key]!=='string'||!item[key]||item[key].length>160||typeof item[label]!=='string'||!item[label]||item[label].length>240)return[];
    return [Object.freeze({id:item[key],label:item[label]})];
  })):Object.freeze([]);
  const application=applicationId?Object.freeze({id:applicationId,
    ...(payload.type==='orderCancelApply'?{reasons:reasons(payload.data.reason_list,'reason','reason')}:{baseReasons:reasons(payload.data.base_reason_list,'base_reason_id','base_reason')})}):null;
  const states = { orderNew: 'placed', orderCancel: 'cancelled', orderFinish: 'completed',
    orderCancelApply: 'cancellation_requested', orderRefundApply: 'refund_requested',
    orderPartialCancel: 'partial_cancelled', deliveryStatus: ORDER_STATUS[info.status] || 'unmapped' };
  return Object.freeze({ provider: '99food', externalAccountId: payload.app_shop_id,
    externalOrderId: orderId, externalEventId: `99f:${digest}`,
    eventType: payload.type, externalStatus: info.status == null ? payload.type : String(info.status),
    status: states[payload.type], occurredAt: new Date(payload.timestamp * 1000).toISOString(),...(application?{application}:{}),
    // An order notification is a trigger to fetch the complete authoritative order.
    requiresOrderFetch: ['orderNew','orderCancel','orderFinish','deliveryStatus','orderPartialCancel'].includes(payload.type) });
}

function normalizeOrder(response,{expectedAppShopId=null}={}) {
  const data = isRecord(response?.data) ? response.data : response;
  const info = isRecord(data?.order_info) ? data.order_info : data;
  const rawId = data?.order_id ?? info?.order_id;
  const externalId = typeof rawId === 'string' ? rawId : Number.isSafeInteger(rawId) ? String(rawId) : null;
  const orderItems=Array.isArray(data?.order_items)?data.order_items:info?.order_items;
  if (!externalId || !OPAQUE.test(externalId) || !Number.isInteger(info?.status) || !Array.isArray(orderItems))
    throw fail('INVALID_PROVIDER_RESPONSE', 502);
  const deliveryType = info.delivery_type;
  const fulfillmentMode = info.fulfillment_mode;
  const returnedShopId=info.shop?.app_shop_id??data.shop?.app_shop_id;
  if(expectedAppShopId!==null&&(typeof returnedShopId!=='string'||returnedShopId!==expectedAppShopId))throw fail('MERCHANT_ORDER_MISMATCH',502);
  if (![0,1,2].includes(deliveryType) || ![0,1].includes(fulfillmentMode)) throw fail('INVALID_PROVIDER_RESPONSE', 502);
  const state = ORDER_STATUS[info.status] || 'unmapped';
  if (state === 'unmapped' || (fulfillmentMode === 1 && deliveryType !== 0) || (fulfillmentMode === 0 && ![1,2].includes(deliveryType)) ||
      orderItems.length > 1000) throw fail('INVALID_PROVIDER_RESPONSE', 502);
  const items=orderItems.map(item=>normalizeItem(item));
  const created = Number(info.create_time);
  return Object.freeze({ provider: '99food', externalId, externalDisplayId: String(info.order_index ?? externalId),
    status: state, providerStatus: info.status, createdAt: Number.isSafeInteger(created) && created > 0 && created <= 8_640_000_000
      ? new Date(created * 1000).toISOString() : null,
    orderType: fulfillmentMode === 1 ? 'pickup' : 'delivery',
    fulfillment: fulfillmentMode === 1 ? 'customer_pickup' : deliveryType === 1 ? 'platform' : deliveryType === 2 ? 'merchant' : 'unknown',
    deliveryType, fulfillmentMode, money:normalizeMoney(info,deliveryType,fulfillmentMode),priceBreakdown:normalizePriceBreakdown(info),
    payment:Object.freeze({payType:Number.isInteger(info.pay_type)?info.pay_type:null,payChannel:Number.isInteger(info.pay_channel)?info.pay_channel:null,
      payMethod:Number.isInteger(info.pay_method)?info.pay_method:null}),
    items: Object.freeze(items) });
}

function create99FoodAdapter({ fetchImpl = globalThis.fetch, clock = () => Date.now(), baseUrl = API } = {}) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch (_) { throw new TypeError('Invalid 99Food API URL.'); }
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'openapi.99food.com' || endpoint.username || endpoint.password)
    throw new TypeError('99Food API host must match the official HTTPS host.');
  if (typeof fetchImpl !== 'function') throw new TypeError('Fetch transport is unavailable.');

  async function request(path, { credentials, params = {}, method = 'GET' } = {}) {
    if (!credentials || typeof credentials.appId !== 'string' || !/^\d{1,20}$/u.test(credentials.appId) ||
        typeof credentials.appSecret !== 'string' || !credentials.appSecret || typeof credentials.appShopId !== 'string' || !credentials.appShopId)
      throw fail('CREDENTIALS_UNAVAILABLE', 503);
    const all = { app_id: credentials.appId, app_shop_id: credentials.appShopId,
      timestamp: Math.floor(clock()/1000), ...params };
    all.sign = signParams(all, credentials.appSecret);
    const url = new URL(path, endpoint);
    const headers = { Accept: 'application/json' };
    const init = { method, headers, signal: undefined };
    if (method === 'GET') {
      for (const key of Object.keys(all).sort()) url.searchParams.set(key, String(all[key]));
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(all);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    init.signal = controller.signal;
    try { response = await fetchImpl(url, init); }
    catch (error) { throw Object.assign(new Error('99Food provider request failed.'), { code: error?.name === 'AbortError' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR', classification: 'unknown' }); }
    finally { clearTimeout(timer); }
    if (response.status === 429 || response.status >= 500) throw Object.assign(new Error('99Food provider temporarily unavailable.'), {
      code: response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_UNAVAILABLE', status: response.status,
      retryAfterSeconds: Math.min(3600, Math.max(1, Number(response.headers?.get?.('retry-after')) || 30)) });
    let body;
    try {
      if(typeof response.text==='function')body=parseLosslessJson(Buffer.from(await response.text(),'utf8'));
      else body=await response.json();
    } catch (_) { throw fail('INVALID_PROVIDER_RESPONSE', 502); }
    if (!response.ok || !isRecord(body) || body.errno !== 0) {
      const providerCode=Number.isInteger(body?.errno)?body.errno:null;
      const cooldown=providerCode===10103;
      throw Object.assign(new Error('99Food rejected the operation.'), {
        code: providerCode===10102 ? 'PROVIDER_AUTH_EXPIRED' : cooldown ? 'PROVIDER_TOKEN_REFRESH_COOLDOWN' : 'PROVIDER_REJECTED',
        status: providerCode===10102 ? 401 : cooldown ? 429 : response.status || 502,
        ...(cooldown?{retryAfterSeconds:120}:{}),providerCode });
    }
    return body;
  }
  async function token({ credentials, appShopId = credentials?.appShopId, refresh = false }) {
    if (typeof appShopId !== 'string' || !appShopId) throw fail('INVALID_MERCHANT_BINDING');
    // The official token endpoint explicitly requires app_secret as a query parameter.
    const scopedCredentials = { ...credentials, appShopId };
    if (refresh) await request('/v1/auth/authtoken/refresh', { credentials: scopedCredentials, params: { app_secret: credentials.appSecret } });
    const result = await request('/v1/auth/authtoken/get', { credentials: scopedCredentials, params: { app_secret: credentials.appSecret } });
    const tokenData = result.data;
    if (!isRecord(tokenData) || typeof tokenData.auth_token !== 'string' || !Number.isSafeInteger(tokenData.token_expiration_time))
      throw fail('INVALID_PROVIDER_RESPONSE', 502);
    return Object.freeze({ authToken: tokenData.auth_token, expiresAt: tokenData.token_expiration_time * 1000,
      appShopId: String(tokenData.app_shop_id) });
  }
  async function order({ id, credentials }) {
    const authToken = credentials?.authToken;
    if (typeof id !== 'string' || !OPAQUE.test(id) || typeof authToken !== 'string' || !authToken) throw fail('CREDENTIALS_UNAVAILABLE', 503);
    return normalizeOrder(await request('/v1/order/order/detail', { credentials, params: { auth_token: authToken, order_id: id } }),
      {expectedAppShopId:credentials.appShopId});
  }
  async function command({ operation, id, credentials, reasonId, reason, applyId, agree, baseReasonId, baseReason, customReason }) {
    const authToken = credentials?.authToken;
    if (typeof id !== 'string' || !OPAQUE.test(id) || typeof authToken !== 'string' || !authToken) throw fail('CREDENTIALS_UNAVAILABLE', 503);
    const routes = { CONFIRM: '/v1/order/order/confirm', READY: '/v1/order/order/ready', CONFIRM_CASH_PAYMENT:'/v1/order/order/payConfirm',
      DELIVERED: '/v1/order/order/delivered', CANCEL_ORDER: '/v1/order/order/cancel',
      CANCEL_REQUEST: '/v1/order/apply/cancel', REFUND_REQUEST: '/v1/order/apply/refund' };
    const route = routes[operation]; if (!route) throw fail('UNSUPPORTED_OPERATION', 409);
    const params = { auth_token: authToken, order_id: id };
    if (operation === 'CANCEL_ORDER') {
      if (!Number.isInteger(reasonId) || ![1010,1020,1030,1040,1050,1060,1070,1071,1072,1073,1074,1080].includes(reasonId) ||
          [1060,1071,1072].includes(reasonId) && credentials.deliveryType !== 2) throw fail('INVALID_CANCELLATION');
      if (reasonId === 1080 && (typeof reason !== 'string' || !reason.trim())) throw fail('INVALID_CANCELLATION');
      params.reason_id = reasonId; if (typeof reason === 'string' && reason.trim()) params.reason = reason.trim().slice(0,500);
    }
    if (operation === 'CANCEL_REQUEST' || operation === 'REFUND_REQUEST') {
      if (!OPAQUE.test(String(applyId || '')) || typeof agree !== 'boolean') throw fail('INVALID_APPLICATION_RESPONSE');
      params.apply_id = String(applyId); params.agree = agree;
      if (typeof reason === 'string' && reason) params.reason = reason.slice(0,500);
      if (operation === 'CANCEL_REQUEST') {
        if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(reason))) throw fail('INVALID_APPLICATION_RESPONSE');
      } else {
        if (agree === false && (typeof baseReasonId !== 'string' || !baseReasonId || typeof baseReason !== 'string' || !baseReason)) throw fail('INVALID_APPLICATION_RESPONSE');
        if (baseReasonId !== undefined) params.base_reason_id = String(baseReasonId);
        if (baseReason !== undefined) params.base_reason = String(baseReason).slice(0,500);
        if (customReason !== undefined) {
          if (typeof customReason !== 'string' || customReason.length > 500 || /[\u0000-\u001f\u007f]/u.test(customReason)) throw fail('INVALID_APPLICATION_RESPONSE');
          params.custom_reason = customReason;
        }
      }
    }
    return request(route, { credentials, params, method: 'POST' });
  }
  return Object.freeze({ provider:'99food', request, token, order, command,
    verifyWebhook: (body, signature, secret) => verifyWebhook(body, signature, secret),
    normalizeWebhook: webhookEvent, normalizeOrder });
}

module.exports = { API, MAX_BODY, ORDER_STATUS, WEBHOOK_TYPES, parseLosslessJson, signParams,
  verifyWebhook, webhookEvent, normalizeOrder, create99FoodAdapter };
