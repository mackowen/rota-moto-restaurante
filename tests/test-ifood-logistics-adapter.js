'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createIfoodAdapter, ProviderError, quoteFromResponse, trackingFromResponse, verifyWebhookSignature, normalizeDeliveryEvent } = require('../backend/logistics/providers/ifood');

const tenant = '4ef6ac65-7abd-4a4c-9c57-0119d6abecb9';
const order = 'a3d1e832-b1bf-48b3-b832-59c9ebc9fb31';
const quote = 'b1dd02bb-588f-4b6e-a456-78f2f52a0942';
const future = new Date(Date.now() + 60000).toISOString();
function response(status, body, headers = {}) {
  const serialized = body == null ? '' : JSON.stringify(body);
  return { status, ok: status >= 200 && status < 300, headers: { get: key => headers[key.toLowerCase()] || null }, text: async () => serialized };
}
function adapterFor(queue, credentials = async () => ({ clientId: 'client-test', clientSecret: 'secret-test' })) {
  const requests = [];
  const adapter = createIfoodAdapter({ credentialResolver: credentials, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  } });
  return { adapter, requests };
}

assert.equal(quoteFromResponse({ id: quote, createdAt: new Date().toISOString(), expirationAt: future,
  quote: { grossValue: 12.5, discount: 1, raise: 0.5 }, preparationTime: 600 }).amountMinor, 1200);
assert.equal(quoteFromResponse({ id: quote, createdAt: new Date().toISOString(), expirationAt: future,
  quote: { grossValue: 12.5, discount: 1, raise: 0 }, preparationTime: 600 }).etaAt, null,
  'preparation time is not misrepresented as delivery ETA');
assert.throws(() => quoteFromResponse({ id: quote, createdAt: new Date().toISOString(), expirationAt: new Date(Date.now() - 1).toISOString(), quote: { grossValue: 5, discount: 0, raise: 0 } }), error => error.code === 'QUOTE_EXPIRED');
assert.throws(() => quoteFromResponse({ id: quote, createdAt: new Date().toISOString(), expirationAt: future, quote: { grossValue: 5, discount: 6, raise: 0 } }), error => error.code === 'INVALID_PROVIDER_RESPONSE');
assert.throws(() => trackingFromResponse({ latitude: 91, longitude: 0 }), error => error.code === 'INVALID_LATITUDE');
assert.throws(() => trackingFromResponse({ latitude: -23.5, longitude: null }), error => error.code === 'INVALID_PROVIDER_RESPONSE');
assert.equal(trackingFromResponse({ latitude: null, longitude: null, pickupEtaStart: -60, deliveryEtaEnd: null }).latitude, null);
assert.equal(normalizeDeliveryEvent({ id: 'evt-1', orderId: order, fullCode: 'ASSIGN_DRIVER' }).status, 'accepted');
assert.equal(normalizeDeliveryEvent({ id: 'evt-2', orderId: order, fullCode: 'NEW_UNMAPPED_EVENT' }).status, 'unmapped');
assert.throws(() => normalizeDeliveryEvent({ id: 'bad', orderId: 'not-uuid', fullCode: 'ASSIGN_DRIVER' }), error => error.code === 'INVALID_PROVIDER_EVENT');
const raw = Buffer.from('{"id":"event"}');
const sig = crypto.createHmac('sha256', 'webhook-secret').update(raw).digest('hex');
assert.equal(verifyWebhookSignature(raw, sig, 'webhook-secret'), true);
assert.equal(verifyWebhookSignature(raw, sig.toUpperCase(), 'webhook-secret'), true);
assert.equal(verifyWebhookSignature(Buffer.from('{ "id":"event"}'), sig, 'webhook-secret'), false);
assert.equal(verifyWebhookSignature(raw, sig, 'wrong-secret'), false);

(async () => {
  const { adapter, requests } = adapterFor([
    response(200, { accessToken: 'synthetic-token', expiresIn: 3600 }),
    response(200, { id: quote, createdAt: new Date().toISOString(), expirationAt: future, quote: { grossValue: 10, discount: 0, raise: 0 } }),
    response(202, null),
    response(200, { latitude: -23.5, longitude: -46.6, expectedDelivery: future, pickupEtaStart: -30, deliveryEtaEnd: 300, trackDate: new Date().toISOString() })
  ]);
  const priced = await adapter.quote({ companyId: tenant, orderId: order });
  assert.equal(priced.amountMinor, 1000);
  assert.equal(priced.currency, 'BRL');
  assert.equal((await adapter.dispatch({ companyId: tenant, orderId: order, quoteId: quote })).confirmation, 'pending');
  assert.equal((await adapter.tracking({ companyId: tenant, orderId: order })).deliveryEtaEndSeconds, 300);
  assert.equal(requests.filter(request => request.url.endsWith('/oauth/token')).length, 1, 'token is reused until near expiry');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(requests[2].options.body, JSON.stringify({ quoteId: quote }));
  assert.equal(requests.some(request => request.url.includes('secret-test')), false);
  await assert.rejects(adapter.dispatch({ companyId: tenant, orderId: order, quoteId: quote }), error => error instanceof ProviderError && error.code === 'PROVIDER_UNAVAILABLE');

  for (const [status, code, classification] of [[401, 'AUTH_EXPIRED', 'auth'], [403, 'AUTH_FORBIDDEN', 'auth'], [429, 'RATE_LIMITED', 'rate_limit'], [503, 'PROVIDER_TRANSIENT', 'transient'], [400, 'PROVIDER_REJECTED', 'permanent']]) {
    const test = adapterFor([response(200, { accessToken: 't', expiresIn: 3600 }), response(status, {}, { 'retry-after': '4' })]);
    await assert.rejects(test.adapter.quote({ companyId: tenant, orderId: order }), error => error.code === code && error.classification === classification && error.message.includes('Falha'));
  }
  const timeout = adapterFor([Object.assign(new Error('socket secret'), { name: 'AbortError' })]);
  await assert.rejects(timeout.adapter.quote({ companyId: tenant, orderId: order }), error => error.code === 'PROVIDER_TIMEOUT' && !error.message.includes('socket'));
  const invalid = adapterFor([response(200, { accessToken: 't', expiresIn: 3600 }), response(200, { unexpected: true })]);
  await assert.rejects(invalid.adapter.quote({ companyId: tenant, orderId: order }), error => error.code === 'INVALID_CREATED_AT');
  const missingCredentials = adapterFor([], async () => null);
  await assert.rejects(missingCredentials.adapter.quote({ companyId: tenant, orderId: order }), error => error.code === 'CREDENTIALS_UNAVAILABLE');
  const tenantCalls = [];
  const scoped = adapterFor([
    response(200, { accessToken: 'token-a', expiresIn: 3600 }), response(200, { id: quote, createdAt: new Date().toISOString(), expirationAt: future, quote: { grossValue: 1, discount: 0, raise: 0 } }),
    response(200, { accessToken: 'token-b', expiresIn: 3600 }), response(200, { id: quote, createdAt: new Date().toISOString(), expirationAt: future, quote: { grossValue: 1, discount: 0, raise: 0 } })
  ], async companyId => { tenantCalls.push(companyId); return { clientId: `client-${companyId}`, clientSecret: 'secret' }; });
  await scoped.adapter.quote({ companyId: tenant, orderId: order });
  const tenantB = '8eb0f612-e039-49a8-b621-a5d3f03b0953';
  await scoped.adapter.quote({ companyId: tenantB, orderId: order });
  assert.deepEqual(tenantCalls, [tenant, tenantB]);
  console.log('iFood logistics adapter contract tests: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
