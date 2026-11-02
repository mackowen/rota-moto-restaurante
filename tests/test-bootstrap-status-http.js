'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { createIdentityHttpHandler } = require('../backend/identity/http');

async function main() {
  const statuses = ['ready', 'pending_owner_activation', 'pending_owner_mfa', 'complete', 'unavailable', 'not_ready'];
  let state = 'ready';
  const handler = createIdentityHttpHandler({ identityService: { async getBootstrapStatus() {
    return { state, checks: { schema: true, pricing: true } };
  } }, bootstrapReadiness: () => ({ mfaKeystoreConfigured: true, invitationDeliveryConfigured: true }) });
  const server = http.createServer(async (req, res) => { if (!await handler(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const candidate of statuses) {
      state = candidate;
      const response = await fetch(`${base}/api/identity/bootstrap/status`, { cache: 'no-store' });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.state, candidate);
      assert.deepEqual(body.checks, { databaseAndMigrations: true, pricingConfigurationAvailable: true,
        mfaKeystoreConfigured: true, invitationDeliveryConfigured: true });
      assert.equal(Object.keys(body).some(key => /secret|token|founderId|userId|companyId/iu.test(key)), false,
        'public readiness does not reveal secret or identity material');
    }
    const wrongMethod = await fetch(`${base}/api/identity/bootstrap/status`, { method: 'POST', headers: { Origin: base } });
    assert.equal(wrongMethod.status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('browser bootstrap public status endpoint: state and redaction contract PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
