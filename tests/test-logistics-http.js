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
    analytics: async () => { calls.push(['analytics']); return { providers: [] }; },
    getIntelligenceSettings: async () => ({ settings: { configured: false, version: 0 }, policies: ['lowest_cost'] }),
    updateIntelligenceSettings: async (_client, scope, body) => { calls.push(['intelligence-update', scope.company_id, body]); return { settings: { version: 1 } }; },
    logisticsEconomicAnalytics: async () => ({ ownFleet: {}, external: {} }),
    compareLogisticsAlternatives: async (_client, scope, id, policy) => ({ deliveryId: id, tenant: scope.company_id, policy, alternatives: [], recommendation: { status: 'insufficient_data' } })
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
    assert.equal((await fetch(`${base}/api/logistics/intelligence/settings`, { headers })).status, 200);
    assert.equal((await fetch(`${base}/api/logistics/intelligence/analytics`, { headers })).status, 200);
    const deliveryId = '00000000-0000-4000-8000-000000000001';
    const comparison = await fetch(`${base}/api/logistics/deliveries/${deliveryId}/comparison?policy=lowest_cost`, { headers });
    assert.equal(comparison.status, 200); assert.equal((await comparison.json()).deliveryId, deliveryId);
    const update = await fetch(`${base}/api/logistics/intelligence/settings`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test' }, body: JSON.stringify({ expectedVersion: 0 }) });
    assert.equal(update.status, 200);
    assert.deepEqual(calls.filter(row => row[0] === 'permission').map(row => row[1]), ['company.manage','company.manage','orders.read','orders.read','orders.read','orders.read','company.manage']);
    assert.equal(calls.find(row => row[0] === 'create')[1].code, 'partner_1');
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  console.log('Logistics authenticated HTTP, CSRF, RBAC, analytics scope and sanitized errors: OK');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
