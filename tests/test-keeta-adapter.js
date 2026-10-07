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
  if (url.includes('/v1/orders/o1')) return response(200, { id: 'o1', customer: { name: 'Client', phone: 'must-not-log', email: 'private' }, items: [{ name: 'Meal', quantity: 1 }] });
  return response(200, { merchantAuthorizationUrl: 'https://merchant.mykeeta.com/authorize' });
};
function response(status, data) { return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => data == null ? '' : JSON.stringify(data) }; }

async function main() {
  const adapter = createKeetaAdapter({ credentialResolver: async tenant => {
    assert.equal(tenant, '00000000-0000-4000-8000-000000000001');
    return { clientId: 'client', clientSecret: 'secret' };
  }, fetchImpl, clock: () => now, persistToken: async () => {} });
  const events = await adapter.pollEvents({ companyId: '00000000-0000-4000-8000-000000000001', merchantIds: ['merchant-1'], eventTypes: ['CREATED'] });
  assert.equal(events[0].id, 'e1');
  assert.equal(calls[0].options.body, '{"client_id":"client","client_secret":"secret","grant_type":"app_level_token"}');
  assert.ok(calls[1].options.headers['X-App-Signature']);
  assert.equal(calls[1].options.headers['x-polling-merchants'], 'merchant-1');
  assert.deepEqual(await adapter.acknowledgeEvents({ companyId: '00000000-0000-4000-8000-000000000001', events }), { accepted: true, confirmation: 'pending' });
  const order = await adapter.order({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1' });
  assert.equal(order.externalId, 'o1');
  assert.equal(Object.hasOwn(order.customer || {}, 'phone'), false);
  assert.deepEqual(await adapter.confirm({ companyId: '00000000-0000-4000-8000-000000000001', id: 'o1', orderExternalCode: 'R1', createdAt: '2026-01-01T00:00:00Z' }), { accepted: true, confirmation: 'pending' });
  assert.equal(calls.some(call => JSON.stringify(call.options).includes('must-not-log')), false);
  await assert.rejects(adapter.pollEvents({ companyId: '00000000-0000-4000-8000-000000000001', merchantIds: [] }), { code: 'INVALID_MERCHANTS' });
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
