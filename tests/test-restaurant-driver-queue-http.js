'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { COOKIE_NAME } = require('../backend/identity/http');
const { createRestaurantDriverQueueHttpHandler } = require('../backend/logistics/restaurant-driver-queue-http');
const { createRestaurantDriverQueueService } = require('../backend/logistics/restaurant-driver-queue');

async function withServer(handler, run) {
  const server = http.createServer((req, res) => { req.clientIp = '127.0.0.1'; void handler(req, res); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function main() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const companyId = '00000000-0000-4000-8000-000000000001';
  const userId = '00000000-0000-4000-8000-000000000002';
  const principal = { company_id: companyId, user_id: userId, role_id: 'role-e2e' };
  const service = createRestaurantDriverQueueService({
    qrKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), qrKid: 'test-qr'
  });
  const queries = [];
  const client = { async query(sql, values) { queries.push({ sql, values }); return { rowCount: 1, rows: [] }; } };
  const issued = await service.issueRestaurantQr(client, principal);
  assert.match(issued.token, /^rm-presence\.v1\./u);
  assert.equal(issued.expiresInSeconds, 60);
  assert.equal(queries.length, 2, 'issuing a QR checks permission and stores its tenant-scoped nonce without querying driver eligibility');
  assert.match(queries[1].sql, /restaurant_presence_qr_nonces/u);
  assert.equal(queries[1].values[0], companyId);

  const unavailable = createRestaurantDriverQueueService({
    qrKey: async () => { throw Object.assign(new Error('private key path must not escape'), { code: 'ENOENT' }); },
    qrKid: 'test-qr'
  });
  await assert.rejects(unavailable.issueRestaurantQr(client, principal), error => {
    assert.equal(error.code, 'PRESENCE_QR_UNAVAILABLE');
    assert.equal(error.causeCode, 'ENOENT');
    assert.doesNotMatch(error.message, /private key path/u);
    return true;
  });

  const requestLogs = [];
  const identityService = {
    async withAuthenticatedTenant(token, operation) {
      assert.match(token, /^[A-Za-z0-9_-]{43}$/u);
      return operation(client, principal);
    },
    async verifyCsrf(_client, _sessionId, token) { return token === 'csrf-test'; }
  };
  const headers = token => ({
    Cookie: `${COOKIE_NAME}=${'a'.repeat(43)}`,
    Origin: origin,
    'Content-Type': 'application/json',
    'X-CSRF-Token': 'csrf-test'
  });
  let origin;

  const mappedHandler = createRestaurantDriverQueueHttpHandler({ identityService, service: unavailable,
    logger: entry => requestLogs.push(entry) });
  await withServer(mappedHandler, async base => {
    origin = base;
    const response = await fetch(`${base}/api/restaurant-driver-queue/qr`, {
      method: 'POST', headers: headers(), body: '{}'
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'PRESENCE_QR_UNAVAILABLE');
    assert.equal(body.error.message, 'QR de presença temporariamente indisponível.');
    assert.match(body.requestId, /^[0-9a-f-]{36}$/iu);
    assert.equal(response.headers.get('x-request-id'), body.requestId);
  });
  assert.equal(requestLogs[0].status, 503);
  assert.equal(requestLogs[0].diagnosticCode, 'ENOENT');
  assert.equal(JSON.stringify(requestLogs).includes('private key path'), false);

  requestLogs.length = 0;
  const databaseFailure = Object.assign(new Error('database details must not escape'), { code: '42P01' });
  const failedHandler = createRestaurantDriverQueueHttpHandler({ identityService,
    service: { issueRestaurantQr: async () => { throw databaseFailure; } }, logger: entry => requestLogs.push(entry) });
  await withServer(failedHandler, async base => {
    origin = base;
    const response = await fetch(`${base}/api/restaurant-driver-queue/qr`, {
      method: 'POST', headers: headers(), body: '{}'
    });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, 'Falha interna ao processar a fila operacional.');
    assert.match(body.requestId, /^[0-9a-f-]{36}$/iu);
    assert.equal(JSON.stringify(body).includes('database details'), false);
  });
  assert.equal(requestLogs[0].diagnosticCode, '42P01');
  assert.equal(JSON.stringify(requestLogs).includes('database details'), false);

  console.log('Restaurant presence QR issuance, eligibility separation, temporary key failure and sanitized correlation diagnostics: OK');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
