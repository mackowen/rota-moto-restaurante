'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDeliveryQrService, verifyDeliveryQr } = require('../backend/domain/delivery-qr');
const { createDeliveryQrHttpHandler } = require('../backend/domain/delivery-qr-http');

const restaurantApp = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert.equal(restaurantApp.includes('rota-moto-order-qr'), false, 'emissão antiga com PII deve ser removida');
assert.match(restaurantApp, /delivery-qr\/deliveries/iu, 'preview deve buscar assinatura no endpoint autenticado');

const companyId = '11111111-1111-4111-8111-111111111111';
const deliveryId = '33333333-3333-4333-8333-333333333333';
const privatePair = crypto.generateKeyPairSync('ed25519');
const kid = 'qr-test-key';
const pem = privatePair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const delivery = { id: deliveryId, companyId, driverId: '44444444-4444-4444-8444-444444444444', status: 'ASSIGNED', version: 7 };
const secrets = { async get(ref, context) { assert.equal(ref, 'local-v1:test-key-ref'); assert.deepEqual(context, { name: `delivery/qr-signing-key/${kid}`, scope: 'installation' }); return pem; } };
const service = createDeliveryQrService({ secretProvider: secrets, keyRef: 'local-v1:test-key-ref', kid, clock: () => 1_800_000_000 });
const calls = [];
let currentDelivery = delivery, currentVersion = 7;
const identity = { async withAuthenticatedTenant(token, operation, permission) {
  if (token !== 's'.repeat(43)) throw Object.assign(new Error('unauthenticated'), { code: 'UNAUTHENTICATED' });
  calls.push(permission);
  return operation({ marker: 'tenant-transaction' }, { company_id: companyId, driver_id: null });
} };
const query = { async get(client, principal, collection, id) {
  assert.equal(client.marker, 'tenant-transaction'); assert.equal(principal.company_id, companyId);
  assert.equal(collection, 'deliveries'); assert.equal(id, deliveryId);
  return { id: deliveryId, record: currentDelivery, version: currentVersion };
} };

async function request(server, path, { method = 'GET', authenticated = true } = {}) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method,
    headers: authenticated ? { cookie: `__Host-rotamoto_session=${'s'.repeat(43)}` } : {} });
  let body = {}; try { body = await response.json(); } catch (_) {}
  return { status: response.status, body };
}

(async () => {
  const handler = createDeliveryQrHttpHandler({ identityService: identity, queryService: query, qrService: service });
  const server = http.createServer((req, res) => { req.clientIp = '127.0.0.1'; handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await request(server, '/api/delivery-qr/keys', { authenticated: false })).status, 401);
    const keyResult = await request(server, '/api/delivery-qr/keys');
    assert.equal(keyResult.status, 200);
    assert.equal(keyResult.body.keys.length, 1);
    assert.equal(keyResult.body.keys[0].algorithm, 'Ed25519');
    assert.equal(JSON.stringify(keyResult.body).includes('PRIVATE'), false);
    const issue = await request(server, `/api/delivery-qr/deliveries/${deliveryId}`);
    assert.equal(issue.status, 200);
    assert.equal(issue.body.expiresInSeconds, 43200);
    const claims = verifyDeliveryQr(issue.body.token, { publicKey: { ...keyResult.body.keys[0] }, nowSeconds: 1_800_000_000 });
    assert.deepEqual({ deliveryId: claims.d, companyId: claims.c, revision: claims.rev }, { deliveryId, companyId, revision: 7 });
    assert.equal(issue.body.token.includes('customer'), false);
    assert.ok(calls.every(permission => permission === 'sync.pull'), 'emissão e distribuição de chave exigem permissão autenticada');
    currentDelivery = { ...delivery, status: 'DELIVERED' };
    assert.equal((await request(server, `/api/delivery-qr/deliveries/${deliveryId}`)).status, 404, 'estado final não recebe QR operacional');
    currentDelivery = { ...delivery, companyId: '22222222-2222-4222-8222-222222222222' };
    assert.equal((await request(server, `/api/delivery-qr/deliveries/${deliveryId}`)).status, 404, 'registro de outro tenant não recebe QR');
    currentDelivery = delivery;
    currentVersion = 0;
    assert.equal((await request(server, `/api/delivery-qr/deliveries/${deliveryId}`)).status, 404, 'revisão inválida falha fechada');
    currentVersion = 7;
    const method = await request(server, '/api/delivery-qr/keys', { method: 'POST' });
    assert.equal(method.status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }

  const unavailable = createDeliveryQrHttpHandler({ identityService: identity, queryService: query });
  const unavailableServer = http.createServer((req, res) => { req.clientIp = '127.0.0.1'; unavailable(req, res); });
  await new Promise(resolve => unavailableServer.listen(0, '127.0.0.1', resolve));
  try { assert.equal((await request(unavailableServer, '/api/delivery-qr/keys')).status, 503); }
  finally { await new Promise(resolve => unavailableServer.close(resolve)); }
  console.log('Delivery QR server issuance, authenticated key distribution, tenant-scoped lookup and fail-closed tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
