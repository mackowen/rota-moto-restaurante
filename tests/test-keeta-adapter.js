'use strict';
const assert = require('node:assert/strict');
const { createKeetaAdapter } = require('../backend/integrations/keeta-adapter');

const calls = [];
let now = 1_800_000_000_000;
const fetchImpl = async (url, options) => {
  calls.push({ url, options });
  if (url.endsWith('/oauth/token')) return response(200, { access_token: 'synthetic-token', token_type: 'bearer', expires_in: 3600, refresh_token: 'synthetic-refresh' });
  if (url.includes('/v1/events:polling')) return response(200, [{ eventId: 'e1', eventType: 'CREATED', orderId: 'o1', orderURL: 'https://provider.invalid/o1', createdAt: '2026-01-01T00:00:00Z' }]);
  if (url.includes('/v1/events/acknowledgment')) return response(202, null);
  if (url.includes('/v1/orders/o1/confirm')) return response(202, null);
  if (url.includes('/v1/orders/merchant%3A42%2Forder%3F1')) return response(200, { id: 'merchant:42/order?1', items: [{ name: 'Meal', quantity: 1 }] });
  if (url.includes('/v1/orders/o1')) return response(200, { id: 'o1', customer: { name: 'Client', phone: 'must-not-log', email: 'private' }, items: [{ name: 'Meal', quantity: 1 }] });
  return response(200, { merchantAuthorizationUrl: 'https://merchant.mykeeta.com/authorize' });
};
function response(status, data) { return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => data == null ? '' : JSON.stringify(data) }; }

async function main() {
  const adapter = createKeetaAdapter({ credentialResolver: async tenant => {
    assert.equal(tenant, '00000000-0000-4000-8000-000000000001');
    return { clientId: 'client', clientSecret: 'secret' };
  }, fetchImpl, clock: () => now, persistToken: async () => {} });
  const events = await adapter.pollEvents({ companyId: '00000000-0000-4000-8000-000000000001', serviceMerchantIds: ['service-merchant-1'], eventTypes: ['CREATED'] });
  assert.equal(events[0].id, 'e1');
  assert.equal(calls[0].options.body, '{"client_id":"client","client_secret":"secret","grant_type":"app_level_token"}');
  assert.ok(calls[1].options.headers['X-App-Signature']);
  assert.equal(calls[1].options.headers['x-polling-merchants'], 'service-merchant-1');
  assert.ok(calls[1].url.includes('eventType=CREATED'));
  assert.deepEqual(await adapter.acknowledgeEvents({ companyId: '00000000-0000-4000-8000-000000000001', events }), { accepted: true, confirmation: 'pending' });
  const order = await adapter.order({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1' });
  assert.equal(order.externalId, 'o1');
  assert.equal((await adapter.order({ companyId: '00000000-0000-4000-8000-000000000001', id: 'merchant:42/order?1' })).externalId, 'merchant:42/order?1',
    'documented opaque string IDs are URI-encoded instead of restricted to an invented character set');
  assert.ok(calls.some(call => call.url.endsWith('/v1/orders/merchant%3A42%2Forder%3F1')));
  assert.equal(Object.hasOwn(order, 'customer'), false);
  assert.equal(Object.hasOwn(order, 'address'), false);
  assert.deepEqual(await adapter.confirm({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1', orderExternalCode: 'R1', createdAt: '2026-01-01T00:00:00Z' }), { accepted: true, confirmation: 'pending' });
  assert.equal(calls.some(call => JSON.stringify(call.options).includes('must-not-log')), false);
  let authorizationRequest;
  const bootstrap = createKeetaAdapter({ credentialResolver: async () => ({ clientId: 'client', clientSecret: 'secret' }),
    fetchImpl: async (url, options) => { authorizationRequest = { url, options }; return response(200, { merchantAuthorizationUrl: 'https://merchant.mykeeta.com/authorize?scope=all' }); } });
  assert.equal(await bootstrap.authorizationUrl({ companyId: '00000000-0000-4000-8000-000000000001',
    redirectUri: 'https://rotamoto.example/keeta/callback', state: 'state-token-which-is-long-enough-123456' }),
  'https://merchant.mykeeta.com/authorize?scope=all');
  assert.match(authorizationRequest.url, /\/oauth\/authorization\/url\?clientId=client&redirectUri=/u);
  assert.equal(Object.hasOwn(authorizationRequest.options.headers, 'Authorization'), false, 'authorization URL bootstrap does not require a token before merchant authorization');
  assert.equal(Object.hasOwn(authorizationRequest.options.headers, 'X-App-Signature'), false, 'authorization URL is called using the documented unsigned contract');
  const merchantPages=[];
  const paginated=createKeetaAdapter({credentialResolver:async()=>({clientId:'client',clientSecret:'secret'}),fetchImpl:async(url,options)=>{
    merchantPages.push({url,options});
    if(url.endsWith('/oauth/token'))return response(200,{access_token:'page-token',expires_in:3600});
    const pageNum=Number(new URL(url).searchParams.get('pageNum'));
    return response(200,{userId:1,brandId:2,brandName:'Synthetic',authorizedShops:[{shopId:pageNum,shopName:`Shop ${pageNum}`}],page:{pageNum,pageSize:100,totalPage:2,totalCount:2}});
  }});
  const shops=await paginated.merchantInfo({companyId:'00000000-0000-4000-8000-000000000001',authId:'auth-opaque'});
  assert.deepEqual(shops.authorizedShops.map(shop=>shop.shopId),[1,2]);
  assert.equal(merchantPages.filter(call=>call.url.includes('/merchantInfo')).length,2,'merchantInfo follows documented pageNum/pageSize pagination');
  assert.equal(merchantPages.some(call=>call.url.includes('pageSize=100')),true);
  const persisted = [];
  const selfDeliveryCalls = [];
  const appToken = createKeetaAdapter({ credentialResolver: async () => ({ clientId: 'client', clientSecret: 'secret' }),
    fetchImpl: async (url, options) => { selfDeliveryCalls.push({ url, options }); return url.endsWith('/oauth/token') ? response(200, { access_token: 'app-token', token_type: 'bearer', expires_in: 3600 }) : url.includes('/merchantOnboarding') ? response(201,{}) : response(202, null); },
    persistToken: async record => persisted.push(record) });
  await appToken.onboardMerchant({companyId:'00000000-0000-4000-8000-000000000001',merchantId:'00000000-0000-4000-8000-000000000002',
    keetaMerchantId:478268,ordersWebhookURL:'https://rotamoto.example/api/marketplace/keeta/webhooks/00000000-0000-4000-8000-000000000003'});
  const onboarding=selfDeliveryCalls.find(call=>call.url.includes('/merchantOnboarding'));
  assert.equal(new URL(onboarding.url).searchParams.get('merchantId'),'00000000-0000-4000-8000-000000000002');
  assert.equal(onboarding.options.method,'PUT');
  assert.deepEqual(JSON.parse(onboarding.options.body),{ordersWebhookURL:'https://rotamoto.example/api/marketplace/keeta/webhooks/00000000-0000-4000-8000-000000000003',keetaMerchantId:478268});
  assert.ok(onboarding.options.headers['X-App-Signature'],'merchant onboarding is signed with the documented request mechanism');
  await appToken.readyForPickup({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1' });
  assert.deepEqual(Object.keys(persisted[0]).sort(), ['expiresAt', 'key'], 'app-level token persistence never invents/persists a refresh token');
  await appToken.dispatchSelfDelivery({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1', deliveryTrackingInfo: { event: { type: 'DELIVERY_ONGOING' } } });
  await appToken.markDeliveredSelfDelivery({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1' });
  await appToken.sendSelfDeliveryTracking({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1', deliveryTrackingInfo: { event: { type: 'DELIVERY_ONGOING' } } });
  await appToken.requestCancellation({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1', reason: 'Store unavailable', code: 'SYSTEMIC_ISSUES' });
  assert(selfDeliveryCalls.some(call => call.url.endsWith('/v1/orders/o1/dispatch') && call.options.method === 'POST'));
  assert(selfDeliveryCalls.some(call => call.url.endsWith('/v1/orders/o1/delivered') && call.options.method === 'POST'));
  assert(selfDeliveryCalls.some(call => call.url.endsWith('/v1/orders/o1/tracking') && call.options.method === 'POST'));
  assert(selfDeliveryCalls.some(call => call.url.endsWith('/v1/orders/o1/requestCancellation') && call.options.method === 'POST'));
  const wrongAck = createKeetaAdapter({ credentialResolver: async () => ({ clientId: 'client', clientSecret: 'secret' }),
    fetchImpl: async url => url.endsWith('/oauth/token') ? response(200, { access_token: 'app-token', expires_in: 3600 }) : response(200, null) });
  await assert.rejects(wrongAck.readyForPickup({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1' }), { code: 'INVALID_PROVIDER_RESPONSE' });
  const oversized = createKeetaAdapter({ credentialResolver: async () => ({ clientId: 'client', clientSecret: 'secret' }),
    fetchImpl: async url => url.endsWith('/oauth/token') ? response(200, { access_token: 'app-token', expires_in: 3600 }) : ({
      status: 200, ok: true, headers: { get: name => name === 'content-length' ? null : null },
      body: { getReader: () => ({ read: async () => ({ done: false, value: Buffer.alloc(256 * 1024 + 1) }), cancel: async () => {}, releaseLock: () => {} }) }
    }) });
  await assert.rejects(oversized.readyForPickup({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1' }), { code: 'INVALID_PROVIDER_RESPONSE' },
    'provider response size is enforced while streaming, before full buffering');
  await assert.rejects(adapter.pollEvents({ companyId: '00000000-0000-4000-8000-000000000001', serviceMerchantIds: [] }), { code: 'INVALID_MERCHANTS' });
  const authCalls=[]; let tokenNumber=0;
  const expiring = createKeetaAdapter({ credentialResolver: async () => ({ clientId:'client', clientSecret:'secret' }),
    fetchImpl: async (url, options) => {
      authCalls.push(url);
      if (url.endsWith('/oauth/token')) return response(200, { access_token:`token-${++tokenNumber}`, expires_in:3600, refresh_token:'rotated-refresh-2' });
      return tokenNumber === 1 ? response(401, null) : response(200, { id:'o1', items:[{ name:'Meal', quantity:1 }] });
    }, persistToken: async () => {} });
  assert.equal((await expiring.order({ companyId:'00000000-0000-4000-8000-000000000001', id:'o1' })).externalId,'o1');
  assert.equal(authCalls.filter(url => url.endsWith('/oauth/token')).length,2,'expired/revoked access token is refreshed once after definitive 401');
  const unverifiedShopGrant = createKeetaAdapter({ credentialResolver: async () => ({ clientId:'client', clientSecret:'secret', authorizationCode:'synthetic-code' }), fetchImpl });
  await assert.rejects(unverifiedShopGrant.order({ companyId:'00000000-0000-4000-8000-000000000001', id:'o1' }), { code:'SHOP_LEVEL_TOKEN_FIELDS_UNVERIFIED' });
  now += 3600_000;
  process.stdout.write('Keeta OAuth, signing, polling, ack and order lifecycle adapter: PASS\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
