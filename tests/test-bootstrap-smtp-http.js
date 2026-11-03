'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { createIdentityHttpHandler } = require('../backend/identity/http');

async function main() {
  let tested = 0;
  let adminActive = true, mfaVerified = true;
  const smtpConfiguration = {
    async authorize(req, action) {
      if (req.headers['x-rotamoto-bootstrap-authorization'] !== 'A'.repeat(43) || action !== 'smtp.validate')
        throw Object.assign(new Error('unauthorized'), { code: 'PROVISIONER_UNAUTHORIZED' });
      return Buffer.alloc(32);
    },
    async validate() { return { valid: true, host: 'smtp.example.test', port: 587, tlsMode: 'starttls', authentication: 'password', oauthAvailable: false }; },
    async test(_settings, req, requestId) {
      if (req.headers['x-rotamoto-bootstrap-authorization'] !== 'A'.repeat(43)) throw Object.assign(new Error('unauthorized'), { code: 'PROVISIONER_UNAUTHORIZED' });
      tested++; return { submission: 'accepted_by_smtp', delivery: 'unconfirmed', configurationSaved: true, requestId };
    },
    async testAsAdmin(_settings, userId, requestId) { assert.equal(userId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'); tested++; return { submission: 'accepted_by_smtp', delivery: 'unconfirmed', configurationSaved: true, requestId }; },
    async status() { return { configured: true, credentialStored: true, username: 'must-not-be-returned' }; },
    async disable() { return { disabled: true, configured: false }; }
  };
  const handler = createIdentityHttpHandler({ identityService: { async getBootstrapStatus() {
    return { state: 'ready', checks: { schema: true, pricing: true } };
  }, async withAuthenticatedTenant(_token, operation, permission) {
    assert.equal(permission, 'company.manage');
    return operation({ async query() { return { rowCount: adminActive ? 1 : 0 }; } },
      { user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', mfa_verified_at: mfaVerified ? new Date() : null });
  }, async verifyCsrf() { return true; } }, smtpConfiguration,
  allowedOrigin: ['http://127.0.0.1:8083', 'http://localhost:8083'] });
  const server = http.createServer((req, res) => { req.clientIp = req.socket.remoteAddress; void handler(req, res); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, { method = 'POST', authorization = null, body = {}, requestOrigin = origin, requestHost = null, session = false, csrf = false } = {}) {
    return fetch(`${origin}${path}`, { method, headers: { Origin: requestOrigin, ...(requestHost ? { Host: requestHost } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      ...(authorization ? { 'X-RotaMoto-Bootstrap-Authorization': authorization } : {}), ...(session ? { Cookie: `__Host-rotamoto_session=${'S'.repeat(43)}` } : {}), ...(csrf ? { 'X-CSRF-Token': 'csrf-test-token' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
  }
  try {
    const validatePath = '/api/identity/bootstrap/smtp/validate';
    const statusPath = '/api/identity/bootstrap/smtp/status';
    const testPath = '/api/identity/bootstrap/smtp/test';
    const anon = await call(validatePath); assert.equal(anon.status, 403);
    assert.equal((await call(statusPath, { body: {} })).status, 403, 'legacy SMTP metadata also requires a live installation capability');
    const setupState = await call(statusPath, { authorization: 'A'.repeat(43), body: {} });
    assert.equal(setupState.status, 200); assert.equal((await setupState.text()).includes('must-not-be-returned'), false,
      'protected legacy setup status never discloses the SMTP login');
    assert.equal((await call(testPath, { body: { requestId: 'ee0c1383-9b9d-46e3-8677-c4a946f8a92f', settings: {} } })).status, 403);
    const crossOrigin = await call(validatePath, { authorization: 'A'.repeat(43), requestOrigin: 'https://attacker.example' });
    assert.equal(crossOrigin.status, 403);
    const proxiedLoopback = await call(validatePath, { authorization: 'A'.repeat(43), requestOrigin: 'http://127.0.0.1:8083',
      requestHost: '127.0.0.1', body: { provider: 'custom' } });
    assert.equal(proxiedLoopback.status, 200, 'the exact loopback origin works through nginx Host rewriting');
    const proxiedLocalhost = await call(validatePath, { authorization: 'A'.repeat(43), requestOrigin: 'http://localhost:8083',
      requestHost: '127.0.0.1', body: { provider: 'custom' } });
    assert.equal(proxiedLocalhost.status, 200, 'the explicit localhost origin works through the loopback proxy');
    const proxiedLan = await call(validatePath, { authorization: 'A'.repeat(43), requestOrigin: 'http://192.168.1.20:8083',
      requestHost: '127.0.0.1', body: { provider: 'custom' } });
    assert.equal(proxiedLan.status, 403);
    assert.equal((await proxiedLan.json()).error.code, 'ORIGIN_INVALID', 'LAN origins stay outside the exact allowlist');
    const config = { provider: 'custom', senderEmail: 'a@example.test', senderName: 'RotaMoto', host: 'smtp.example.test',
      port: 587, tlsMode: 'starttls', authMethod: 'password', username: 'smtp-user', password: 'must-not-echo',
      testRecipient: 'qa@example.test', publicBaseUrl: 'https://app.example.test/' };
    const valid = await call(validatePath, { authorization: 'A'.repeat(43), body: config });
    assert.equal(valid.status, 200); const validBody = await valid.json(); assert.equal(validBody.valid, true);
    assert.equal(JSON.stringify(validBody).includes('must-not-echo'), false);
    const requestId = 'bb17bccd-e8be-492c-9db4-df2958e8e1fa';
    const sent = await call(testPath, { authorization: 'A'.repeat(43), body: { requestId, settings: config } });
    assert.equal(sent.status, 200); const sentBody = await sent.json(); assert.equal(sentBody.submission, 'accepted_by_smtp');
    assert.equal(sentBody.delivery, 'unconfirmed'); assert.equal(JSON.stringify(sentBody).includes('must-not-echo'), false);
    assert.equal(tested, 1);
    assert.equal((await call(validatePath, { method: 'GET' })).status, 405);
    assert.equal((await call('/api/admin/smtp/config', { method: 'GET' })).status, 401, 'admin SMTP state requires a session');
    adminActive = false;
    assert.equal((await call('/api/admin/smtp/config', { method: 'GET', session: true })).status, 403, 'company-only user cannot read global SMTP settings');
    adminActive = true; mfaVerified = false;
    assert.equal((await call('/api/admin/smtp/config', { method: 'GET', session: true })).status, 403, 'global SMTP settings require verified MFA');
    mfaVerified = true;
    const adminState = await call('/api/admin/smtp/config', { method: 'GET', session: true }); assert.equal(adminState.status, 200);
    assert.equal((await adminState.text()).includes('must-not-be-returned'), false, 'admin read does not return credential values');
    const adminNoCsrf = await call('/api/admin/smtp/disable', { session: true, body: {} }); assert.equal(adminNoCsrf.status, 403);
    const adminTest = await call('/api/admin/smtp/test', { session: true, csrf: true, body: { requestId, settings: config } });
    assert.equal(adminTest.status, 200); assert.equal((await adminTest.json()).delivery, 'unconfirmed');
    assert.equal((await call('/api/admin/smtp/disable', { session: true, csrf: true, body: {} })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }

  const disabled = createIdentityHttpHandler({ identityService: { async getBootstrapStatus() { return { state: 'ready', checks: {} }; } } });
  const disabledServer = http.createServer((req, res) => { void disabled(req, res); });
  await new Promise(resolve => disabledServer.listen(0, '127.0.0.1', resolve));
  try {
    const result = await fetch(`http://127.0.0.1:${disabledServer.address().port}/api/identity/bootstrap/smtp/test`, {
      method: 'POST', headers: { Origin: `http://127.0.0.1:${disabledServer.address().port}`, 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(result.status, 404, 'the E2E handler without the official SMTP setup service has no SMTP route');
  } finally { await new Promise(resolve => disabledServer.close(resolve)); }
  console.log('Bootstrap SMTP HTTP authorization, origin, HTTP methods, safe responses, and E2E isolation: PASS');
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
