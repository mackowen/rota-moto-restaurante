'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Client } = require('pg');
const { createIdentityService } = require('../backend/identity/service');
const { createEmailDeliveryProvider } = require('../backend/identity/email-provider');
const { createIdentityHttpHandler, createRateLimiter, COOKIE_NAME } = require('../backend/identity/http');

function savepointPool(client) {
  let counter = 0;
  const stack = [];
  return { async connect() {
    return {
      async query(sql, values) {
        const command = sql.trim().toUpperCase();
        if (command === 'BEGIN') {
          const name = `http_identity_${++counter}`;
          stack.push(name);
          return client.query(`SAVEPOINT ${name}`);
        }
        if (command === 'COMMIT' || command === 'ROLLBACK') {
          const name = stack.pop();
          if (!name) throw new Error('unexpected savepoint operation');
          if (command === 'ROLLBACK') await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          return client.query(`RELEASE SAVEPOINT ${name}`);
        }
        return client.query(sql, values);
      },
      release() {}
    };
  } };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL oficial via pgpass é obrigatório.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'rotamoto_app',
    'HTTP integration fixtures must use the restricted runtime role');
  await client.query('BEGIN');
  const pool = savepointPool(client);
  const delivered = [];
  const provider = createEmailDeliveryProvider(async message => { delivered.push(message); return { accepted: true }; });
  const logs = [];
  const service = createIdentityService({ pool, emailProvider: provider,
    authorizeProvisioner: async ({ context }) => {
      if (context?.request?.headers['x-synthetic-operator'] !== 'test-only') throw new Error('unauthorized');
      return { actorRef: 'test:synthetic-http-operator' };
    } });
  const app = createIdentityHttpHandler({ identityService: service, logger: event => logs.push(event), rateLimiter: createRateLimiter({ policies: {
    login: { limit: 100, windowMs: 60000 }, recovery: { limit: 100, windowMs: 60000 },
    invitation: { limit: 100, windowMs: 60000 }, provision: { limit: 100, windowMs: 60000 },
    default: { limit: 100, windowMs: 60000 }
  } }) });
  const host = await listen(app);
  const password = 'synthetic-http-password-900';
  const email = `identity-http-${crypto.randomUUID()}@example.invalid`;
  let companyId;
  const call = async (path, { method = 'GET', body, cookie, csrf, origin = host.base, extraHeaders = {} } = {}) => {
    const headers = { ...extraHeaders };
    if (origin) headers.Origin = origin;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; }
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`${host.base}${path}`, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };

  try {
    const provisionBody = { companyName: 'Synthetic HTTP Tenant', email, idempotencyKey: `http-${crypto.randomUUID()}` };
    const unauthorized = await call('/api/admin/tenants/provision', { method: 'POST', body: provisionBody });
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.body.error.code, 'PROVISIONER_UNAUTHORIZED');
    const provisioned = await call('/api/admin/tenants/provision', { method: 'POST', body: provisionBody,
      extraHeaders: { 'X-Synthetic-Operator': 'test-only' } });
    assert.equal(provisioned.status, 202);
    assert.equal(provisioned.body.delivery, 'sent');
    assert.equal(JSON.stringify(provisioned.body).includes(delivered[0].token), false);
    companyId = provisioned.body.companyId;

    const accepted = await call('/api/identity/invitations/accept', { method: 'POST',
      body: { token: delivered[0].token, password } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.mfaRequired, true);
    const acceptedAgain = await call('/api/identity/invitations/accept', { method: 'POST',
      body: { token: delivered[0].token, password } });
    assert.equal(acceptedAgain.status, 401, 'invite token is single-use');

    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query(`UPDATE rotamoto.credentials SET mfa_required=false WHERE user_id=$1`, [accepted.body.userId]);
    const wrong = await call('/api/identity/login', { method: 'POST', body: { email, password: 'synthetic-wrong-password' , companyId } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body.error, { code: 'INVALID_CREDENTIALS', message: 'Email ou senha inválidos.' });
    const login = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId } });
    assert.equal(login.status, 200);
    const cookieHeader = login.headers.get('set-cookie');
    assert.match(cookieHeader, /^__Host-rotamoto_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; Secure; HttpOnly; SameSite=Lax$/u);
    const sessionCookie = cookieHeader.split(';', 1)[0];
    assert.equal(Object.hasOwn(login.body, 'sessionToken'), false);
    assert.equal(JSON.stringify(login.body).includes(password), false);
    assert.equal(JSON.stringify(login.body).includes('password_phc'), false);

    const session = await call('/api/identity/session?companyId=00000000-0000-7000-8000-000000000000', { cookie: sessionCookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.activeCompanyId, companyId, 'tenant context comes from validated session');
    assert.equal(session.body.email, email);
    assert.equal(JSON.stringify(session.body).includes('password_phc'), false);
    const wrongMethod = await call('/api/identity/session', { method: 'POST', body: {} });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');

    const csrfMissing = await call('/api/identity/tenant', { method: 'POST', body: { companyId }, cookie: sessionCookie });
    assert.equal(csrfMissing.status, 403);
    assert.equal(csrfMissing.body.error.code, 'CSRF_INVALID');
    const csrfInvalid = await call('/api/identity/tenant', { method: 'POST', body: { companyId }, cookie: sessionCookie, csrf: 'invalid' });
    assert.equal(csrfInvalid.status, 403);
    const crossTenant = await call('/api/identity/tenant', { method: 'POST', body: { companyId: crypto.randomUUID() },
      cookie: sessionCookie, csrf: login.body.csrfToken });
    assert.equal(crossTenant.status, 403);
    assert.equal(crossTenant.body.error.code, 'FORBIDDEN');

    const forbiddenOrigin = await call('/api/identity/logout', { method: 'POST', cookie: sessionCookie,
      csrf: login.body.csrfToken, origin: 'https://attacker.invalid' });
    assert.equal(forbiddenOrigin.status, 403);
    assert.equal(forbiddenOrigin.body.error.code, 'ORIGIN_INVALID');
    const logoutMissingCsrf = await call('/api/identity/logout', { method: 'POST', cookie: sessionCookie });
    assert.equal(logoutMissingCsrf.status, 403);
    const logout = await call('/api/identity/logout', { method: 'POST', cookie: sessionCookie, csrf: login.body.csrfToken });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
    assert.equal((await call('/api/identity/session', { cookie: sessionCookie })).status, 401, 'logout revokes session');

    const loginAgain = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId } });
    const idleCookie = loginAgain.headers.get('set-cookie').split(';', 1)[0];
    const idleToken = idleCookie.slice(idleCookie.indexOf('=') + 1);
    await client.query(`UPDATE rotamoto.sessions SET created_at=now()-interval '3 seconds',last_seen_at=now()-interval '2 seconds',
      idle_expires_at=now()-interval '1 second'
      WHERE token_digest=$1`, [crypto.createHash('sha256').update(idleToken).digest()]);
    assert.equal((await call('/api/identity/session', { cookie: idleCookie })).status, 401, 'expired session is rejected');

    const recovery = await call('/api/identity/recovery', { method: 'POST', body: { email } });
    assert.equal(recovery.status, 202);
    assert.deepEqual(recovery.body, { accepted: true });
    const recoveryToken = delivered.at(-1).token;
    assert.equal(JSON.stringify(recovery.body).includes(recoveryToken), false);
    const consumedRecovery = await call('/api/identity/recovery/consume', { method: 'POST', body: { token: recoveryToken, password: 'synthetic-recovered-password-43' } });
    assert.equal(consumedRecovery.status, 204);
    const reusedRecovery = await call('/api/identity/recovery/consume', { method: 'POST', body: { token: recoveryToken, password } });
    assert.equal(reusedRecovery.status, 401, 'recovery token is single-use');
    const invalidNewPassword = await call('/api/identity/recovery/consume', { method: 'POST', body: { token: recoveryToken, password: 'short' } });
    assert.equal(invalidNewPassword.status, 400, 'weak password is reported as input error, not internal failure');

    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query(`UPDATE rotamoto.credentials SET failed_attempts=9,locked_until=NULL WHERE user_id=$1`, [accepted.body.userId]);
    const lockAttempt = await call('/api/identity/login', { method: 'POST', body: { email, password: 'synthetic-invalid-password-99', companyId } });
    assert.equal(lockAttempt.status, 401);
    const blockedLogin = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId } });
    assert.equal(blockedLogin.status, 401, 'account lock blocks correct password until expiry');

    const invalidPayload = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, tenantId: crypto.randomUUID() } });
    assert.equal(invalidPayload.status, 400, 'unknown authority-bearing fields are rejected');
    const tooLarge = await fetch(`${host.base}/api/identity/recovery`, { method: 'POST', headers: {
      Origin: host.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, padding: 'x'.repeat(17000) }) });
    assert.equal(tooLarge.status, 413);
    const invalidJson = await fetch(`${host.base}/api/identity/recovery`, { method: 'POST', headers: {
      Origin: host.base, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalidJson.status, 400);
    const wrongMedia = await fetch(`${host.base}/api/identity/login`, { method: 'POST', headers: { Origin: host.base,
      'Content-Type': 'text/plain' }, body: 'synthetic' });
    assert.equal(wrongMedia.status, 415);

    await client.query("SELECT set_config('app.tenant_id','',true)");
    assert.equal((await client.query('SELECT 1 FROM rotamoto.companies WHERE id=$1', [companyId])).rowCount, 0,
      'RLS default-deny hides tenant rows without a validated tenant context');
    assert.equal(JSON.stringify(logs).includes(password), false, 'request logs never contain credentials');
    assert.equal(JSON.stringify(logs).includes(recoveryToken), false, 'request logs never contain recovery tokens');

    const rateHost = await listen(createIdentityHttpHandler({ identityService: { authenticate: async () => ({}) },
      rateLimiter: createRateLimiter({ policies: { login: { limit: 1, windowMs: 60000 }, default: { limit: 10, windowMs: 60000 } } }) }));
    const rateCall = async () => fetch(`${rateHost.base}/api/identity/login`, { method: 'POST', headers: {
      Origin: rateHost.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, companyId }) });
    try {
      assert.equal((await rateCall()).status, 200);
      const limited = await rateCall();
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) > 0);
    } finally { await rateHost.close(); }

    console.log('identity HTTP API, session, CSRF, tenant/RLS, permission, recovery, invite, rate and error tests: OK');
  } finally {
    await host.close();
    await client.query('ROLLBACK').catch(() => {});
    const remaining = await client.query('SELECT count(*)::int AS count FROM rotamoto.users WHERE email=$1', [email]).catch(() => ({ rows: [{ count: -1 }] }));
    await client.end();
    assert.equal(remaining.rows[0].count, 0, 'all synthetic users, tenants and audit rows were rolled back');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
