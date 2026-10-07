'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalJson, canonicalQuery, requestSigningString, signRequest, verifyWebhook, verifyWebhookAndParse, normalizeWebhook } = require('../backend/integrations/keeta-protocol');

const url = 'https://open.mykeeta.com/api/open/opendelivery/v1/orders';
const secret = 'test-secret-only';
assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
assert.equal(canonicalQuery({ z: '', a: 2 }), 'a=2&z=');
assert.equal(requestSigningString(`${url}?ignored=1`, { b: 2, a: 1 }, { z: 1, a: 2 }), `${url}&a=1&b=2&{"a":2,"z":1}`);
assert.throws(() => canonicalJson(Number.NaN), TypeError);
const signature = signRequest(url, { orderId: '42' }, secret, { status: 'CONFIRMED' });
assert.equal(signature, crypto.createHmac('sha256', secret).update(`${url}&orderId=42&{"status":"CONFIRMED"}`).digest('base64'));

const raw = Buffer.from(JSON.stringify({ eventId: 'evt-1', orderId: 'order-1', eventType: 'CREATED' }));
const webhookSignature = crypto.createHmac('sha256', secret).update(raw).digest('base64');
assert.equal(verifyWebhook(raw, webhookSignature, secret), true);
assert.equal(verifyWebhook(raw, webhookSignature, 'wrong'), false);
assert.equal(verifyWebhook(Buffer.alloc(256 * 1024 + 1), webhookSignature, secret), false);
assert.equal(verifyWebhookAndParse(raw, webhookSignature, secret, { 'x-app-id': 'app-1', 'x-app-merchantid': 'merchant-1' }).externalAccountId, 'merchant-1');
assert.equal(verifyWebhookAndParse(raw, webhookSignature, secret, {}), null);
assert.equal(verifyWebhookAndParse(Buffer.from('{'), webhookSignature, secret, { 'x-app-id': 'app', 'x-app-merchantid': 'merchant' }), null);
const event = normalizeWebhook({ externalEventId: 'evt-1', externalAccountId: 'merchant-1', externalOrderId: 'order-1', eventType: 'CREATED' });
assert.deepEqual({ id: event.externalEventId, account: event.externalAccountId, order: event.externalOrderId, status: event.status },
  { id: 'evt-1', account: 'merchant-1', order: 'order-1', status: 'placed' });
assert.equal(Object.hasOwn(event, 'customer'), false, 'event normalization excludes PII');
assert.throws(() => normalizeWebhook({ externalEventId: '../bad', externalAccountId: 'm', externalOrderId: 'o' }), { code: 'INVALID_PROVIDER_EVENT' });
process.stdout.write('Keeta RFC8785/HMAC request signing and raw-body webhook: PASS\n');
