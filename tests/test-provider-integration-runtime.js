'use strict';

const assert = require('node:assert/strict');
const { deterministicKey, retryDelayMs, safePayload } = require('../backend/logistics/provider-integration');
const { createFakeLogisticsProvider } = require('./helpers/fake-logistics-provider');

const base = { companyId: 'tenant-a', providerId: 'provider-a', operation: 'DISPATCH_REQUEST', requestKey: 'delivery-1' };
const key = deterministicKey(base);
assert.equal(key, deterministicKey(base));
assert.notEqual(key, deterministicKey({ ...base, companyId: 'tenant-b' }));
assert.notEqual(key, deterministicKey({ ...base, providerId: 'provider-b' }));
assert.notEqual(key, deterministicKey({ ...base, operation: 'CANCEL_REQUEST' }));
assert.equal(retryDelayMs({ attempts: 1, classification: 'TRANSIENT', seed: 'cmd' }), retryDelayMs({ attempts: 1, classification: 'TRANSIENT', seed: 'cmd' }));
assert.equal(retryDelayMs({ attempts: 8, classification: 'TRANSIENT', seed: 'cmd' }), null);
assert.equal(retryDelayMs({ attempts: 1, classification: 'UNKNOWN_OUTCOME', seed: 'cmd' }), null);
assert.equal(retryDelayMs({ attempts: 1, classification: 'RATE_LIMIT', retryAfterSeconds: 7200, seed: 'cmd' }) <= 3600000, true);
assert.deepEqual(safePayload({ deliveryId: '00000000-0000-4000-8000-000000000001', reason: 'operator_request' }), { deliveryId: '00000000-0000-4000-8000-000000000001', reason: 'operator_request' });
assert.throws(() => safePayload({ address: 'PII' }), { code: 'INVALID_INPUT' });
assert.throws(() => safePayload({ reason: 'Bearer secret-token' }), { code: 'INVALID_INPUT' });
assert.throws(() => safePayload({ quoteId: 'not-a-uuid' }), { code: 'INVALID_INPUT' });
async function fakeAdapterChecks() {
  let now = Date.parse('2026-10-06T00:00:00Z');
  const fake = createFakeLogisticsProvider({ outcomes: ['pending','timeout','rate_limit'], clock: () => now });
  const quote = await fake.quote({ commandId: 'quote-command' });
  assert.equal(quote.currency, 'BRL');
  assert.equal(quote.amountMinor, 1290);
  assert.equal(quote.etaAt, null);
  assert.equal((await fake.dispatch({ commandId: 'pending-command' })).status, 'pending');
  await assert.rejects(fake.dispatch({ commandId: 'timeout-command' }), error => error.classification === 'UNKNOWN_OUTCOME');
  await assert.rejects(fake.dispatch({ commandId: 'rate-command' }), error => error.classification === 'RATE_LIMIT' && error.retryAfterSeconds === 3);
  assert.equal(fake.events.length, 0);
  now += 1000;
}
fakeAdapterChecks().then(() => process.stdout.write('Provider integration runtime tests passed.\n'));
