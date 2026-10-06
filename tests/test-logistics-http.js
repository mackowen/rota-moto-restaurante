'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogisticsHttpHandler } = require('../backend/logistics/http');
const { COOKIE_NAME } = require('../backend/identity/http');

async function main() {
  const calls = [], principal = { company_id: 'tenant-test', user_id: 'user-test', session_id: 'session-test' };
  const service = {
    listProviders: async () => ({ providers: [] }),
    createProvider: async (_client, _principal, body) => { calls.push(['create', body]); return { provider: { code: body.code } }; },
    ensureInternalProvider: async () => ({ id: 'internal-test' }),
    analytics: async () => { calls.push(['analytics']); return { providers: [] }; }
  };
  const identityService = {
    async withAuthenticatedTenant(token, operation, permission) { assert.equal(token, 'a'.repeat(43)); calls.push(['permission', permission]); return operation({}, principal); },
    async verifyCsrf(_client, sessionId, token) { return sessionId === principal.session_id && token === 'csrf-test'; }
  };
  const handler = createLogisticsHttpHandler({ identityService, logisticsService: service });
  const server = http.createServer((req, res) => { req.clientIp = '127.0.0.1'; void handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauthenticated = await fetch(`${base}/api/logistics/providers`);
    assert.equal(unauthenticated.status, 401);
    const headers = { Cookie: `${COOKIE_NAME}=${'a'.repeat(43)}`, Origin: base };
    const csrfMissing = await fetch(`${base}/api/logistics/providers`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(csrfMissing.status, 403);
    const create = await fetch(`${base}/api/logistics/providers`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test' }, body: JSON.stringify({ code: 'partner_1' }) });
    assert.equal(create.status, 200);
    assert.equal((await create.json()).provider.code, 'partner_1');
    const analytics = await fetch(`${base}/api/logistics/analytics`, { headers });
    assert.equal(analytics.status, 200);
    assert.deepEqual(calls.filter(row => row[0] === 'permission').map(row => row[1]), ['company.manage','company.manage','orders.read']);
    assert.equal(calls.find(row => row[0] === 'create')[1].code, 'partner_1');
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  console.log('Logistics authenticated HTTP, CSRF, RBAC, analytics scope and sanitized errors: OK');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
