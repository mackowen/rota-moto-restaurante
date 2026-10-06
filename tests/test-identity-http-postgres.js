'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createClient } = require('../backend/postgres/connection');
const { createIdentityService } = require('../backend/identity/service');
const { createEmailDeliveryProvider } = require('../backend/identity/email-provider');
const { createMfaProvider } = require('../backend/identity/mfa-provider');
const { createIdentityHttpHandler, createRateLimiter, COOKIE_NAME } = require('../backend/identity/http');
const { createAdminHttpHandler } = require('../backend/admin/http');
const { createAdminRepository } = require('../backend/admin/repository');
const { createAdminService } = require('../backend/admin/service');

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
  const client = createClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'rotamoto_app',
    'HTTP integration fixtures must use the restricted runtime role');
  await client.query('BEGIN');
  const pool = savepointPool(client);
  const delivered = [];
  const provider = createEmailDeliveryProvider(async message => { delivered.push(message); return { accepted: true }; });
  const logs = [];
  const service = createIdentityService({ pool, emailProvider: provider, mfaProvider: createMfaProvider(async ({ code }) => code === '654321'),
    authorizeProvisioner: async ({ context }) => {
      if (context?.request?.headers['x-synthetic-operator'] !== 'test-only') throw new Error('unauthorized');
      return { actorRef: 'test:synthetic-http-operator' };
    } });
  const app = createIdentityHttpHandler({ identityService: service, logger: event => logs.push(event), rateLimiter: createRateLimiter({ policies: {
    login: { limit: 100, windowMs: 60000 }, recovery: { limit: 100, windowMs: 60000 },
    invitation: { limit: 100, windowMs: 60000 }, provision: { limit: 100, windowMs: 60000 },
    default: { limit: 100, windowMs: 60000 }
  } }) });
  const adminHttp = createAdminHttpHandler({ identityService: service,
    adminService: createAdminService({ repository: createAdminRepository() }), allowedOrigin: 'http://localhost' });
  const router = async (req, res) => { if (await app(req, res)) return; await adminHttp(req, res); };
  const host = await listen(router);
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
    const missingMfa = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId } });
    assert.equal(missingMfa.status, 403, 'administrative identities cannot establish sessions without verified MFA');
    assert.equal(missingMfa.body.error.code, 'MFA_REQUIRED');
    const rejectedMfa = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, mfaCode: '000000' } });
    assert.equal(rejectedMfa.status, 403, 'invalid MFA proof cannot establish a session');
    const wrong = await call('/api/identity/login', { method: 'POST', body: { email, password: 'synthetic-wrong-password' , companyId } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body.error, { code: 'INVALID_CREDENTIALS', message: 'Email ou senha inválidos.' });
    const login = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, mfaCode: '654321' } });
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
    assert.equal(session.body.mfaVerified, true);
    assert.notEqual(session.body.csrfToken, login.body.csrfToken, 'session bootstrap rotates CSRF for reload-safe in-memory use');
    assert.equal(JSON.stringify(session.body).includes('password_phc'), false);
    const csrfRotated = await call('/api/identity/tenant', { method: 'POST', body: { companyId }, cookie: sessionCookie, csrf: login.body.csrfToken });
    assert.equal(csrfRotated.status, 403);
    assert.equal(csrfRotated.body.error.code, 'CSRF_INVALID');
    const wrongMethod = await call('/api/identity/session', { method: 'POST', body: {} });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');

    const csrfMissing = await call('/api/identity/tenant', { method: 'POST', body: { companyId }, cookie: sessionCookie });
    assert.equal(csrfMissing.status, 403);
    assert.equal(csrfMissing.body.error.code, 'CSRF_INVALID');
    const csrfInvalid = await call('/api/identity/tenant', { method: 'POST', body: { companyId }, cookie: sessionCookie, csrf: 'invalid' });
    assert.equal(csrfInvalid.status, 403);
    const crossTenant = await call('/api/identity/tenant', { method: 'POST', body: { companyId: crypto.randomUUID() },
      cookie: sessionCookie, csrf: session.body.csrfToken });
    assert.equal(crossTenant.status, 403);
    assert.equal(crossTenant.body.error.code, 'FORBIDDEN');

    const roles = await call('/api/admin/roles', { cookie: sessionCookie });
    assert.equal(roles.status, 200);
    const ownerRole = roles.body.roles.find(role => role.key === 'owner');
    assert(ownerRole, 'owner role exists in the active tenant');
    const ownerPrincipal = await service.resolveSession(client, sessionCookie.slice(sessionCookie.indexOf('=') + 1));
    await client.query('UPDATE rotamoto.sessions SET mfa_verified_at=NULL WHERE id=$1', [ownerPrincipal.session_id]);
    const noProviderService = createIdentityService({ pool });
    await assert.rejects(noProviderService.inviteMembershipWithSession(sessionCookie.slice(sessionCookie.indexOf('=') + 1),
      session.body.csrfToken, { email: `mfa-gate-${crypto.randomUUID()}@example.invalid`, roleId: ownerRole.id }),
    error => error.code === 'MFA_REQUIRED', 'membership invitation cannot bypass session MFA when its provider is unavailable');
    await client.query('UPDATE rotamoto.sessions SET mfa_verified_at=now() WHERE id=$1', [ownerPrincipal.session_id]);
    const permissions = await call('/api/admin/permissions', { cookie: sessionCookie });
    assert.equal(permissions.status, 200);
    assert(permissions.body.permissions.some(permission => permission.key === 'orders.read'));
    const createdRole = await call('/api/admin/roles', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { key: 'qa_reader', name: 'Leitura QA', permissions: ['orders.read'] } });
    assert.equal(createdRole.status, 201);
    assert.match(createdRole.headers.get('x-request-id'), /^[0-9a-f-]{36}$/iu, 'administrative responses carry a correlation ID');
    const ownerMembers = await call('/api/admin/memberships?limit=100', { cookie: sessionCookie });
    const ownerMember = ownerMembers.body.members.find(member => member.userId === accepted.body.userId);
    assert(ownerMember);
    const selfChange = await call(`/api/admin/memberships/${ownerMember.membershipId}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { roleId: createdRole.body.id } });
    assert.equal(selfChange.status, 403, 'users cannot alter their own membership role');
    assert.equal(selfChange.body.error.code, 'FORBIDDEN');
    const systemRoleEdit = await call(`/api/admin/roles/${ownerRole.id}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { name: 'Owner', permissions: ['orders.read'] } });
    assert.equal(systemRoleEdit.status, 403, 'owner system role is immutable');
    const noAdminCsrf = await call('/api/admin/roles', { method: 'POST', cookie: sessionCookie,
      body: { key: 'no_csrf', name: 'Sem CSRF', permissions: [] } });
    assert.equal(noAdminCsrf.status, 403, 'administrative mutations require CSRF');

    const principal = await service.resolveSession(client, sessionCookie.slice(sessionCookie.indexOf('=') + 1));
    await assert.rejects(createAdminService({ repository: createAdminRepository() }).updateMembership(client,
      { ...principal, user_id: crypto.randomUUID() }, ownerMember.membershipId, { roleId: createdRole.body.id }),
    error => error.code === 'LAST_OWNER_REQUIRED', 'tenant must retain an active owner');
    const invitedEmail = `identity-invite-${crypto.randomUUID()}@example.invalid`;
    const invited = await call('/api/admin/invitations', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { email: invitedEmail, roleId: createdRole.body.id } });
    assert.equal(invited.status, 202);
    assert.equal(invited.body.delivery, 'sent');
    assert.equal(JSON.stringify(invited.body).includes(delivered.at(-1).token), false, 'raw invitation token is never returned');
    assert.equal(delivered.at(-1).kind, 'membership_invitation');
    const deliveryFailureEmail = `identity-delivery-failure-${crypto.randomUUID()}@example.invalid`;
    const failingDeliveryService = createIdentityService({ pool, emailProvider: createEmailDeliveryProvider(async () => { throw new Error('synthetic delivery failure'); }) });
    await assert.rejects(failingDeliveryService.inviteMembershipWithSession(sessionCookie.slice(sessionCookie.indexOf('=') + 1),
      session.body.csrfToken, { email: deliveryFailureEmail, roleId: createdRole.body.id }), error => error.code === 'EMAIL_DELIVERY_FAILED');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    const failedDeliveryState = await client.query(`SELECT m.status,t.consumed_at IS NOT NULL AS token_revoked
      FROM rotamoto.users u JOIN rotamoto.memberships m ON m.user_id=u.id
      JOIN rotamoto.identity_tokens t ON t.user_id=u.id AND t.company_id=m.company_id
      WHERE u.email=$1 AND t.purpose='membership_invitation'`, [deliveryFailureEmail]);
    assert.equal(failedDeliveryState.rows[0].status, 'invited');
    assert.equal(failedDeliveryState.rows[0].token_revoked, true, 'failed email delivery leaves no usable invitation token');
    const invitedPassword = 'synthetic-invited-password-991';
    const invitationAccepted = await call('/api/identity/membership-invitations/accept', { method: 'POST',
      body: { token: delivered.at(-1).token, password: invitedPassword } });
    assert.equal(invitationAccepted.status, 200);
    const invitedLogin = await call('/api/identity/login', { method: 'POST', body: { email: invitedEmail,
      password: invitedPassword, companyId } });
    assert.equal(invitedLogin.status, 200);
    const invitedCookie = invitedLogin.headers.get('set-cookie').split(';', 1)[0];
    const tenantSelection = await call('/api/identity/tenant', { method: 'POST', cookie: invitedCookie,
      csrf: invitedLogin.body.csrfToken, body: { companyId } });
    assert.equal(tenantSelection.status, 200, 'an active member can select a validated tenant without company.manage');
    const escalation = await call('/api/admin/invitations', { method: 'POST', cookie: invitedCookie,
      csrf: invitedLogin.body.csrfToken, body: { email: `denied-${crypto.randomUUID()}@example.invalid`, roleId: createdRole.body.id } });
    assert.equal(escalation.status, 403, 'ordinary member cannot create invitations');

    const adminRole = await call('/api/admin/roles', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { key: 'qa_manager', name: 'Gerência QA', permissions: ['company.manage', 'orders.read'] } });
    assert.equal(adminRole.status, 201);
    const adminEmail = `identity-manager-${crypto.randomUUID()}@example.invalid`;
    const adminInvite = await call('/api/admin/invitations', { method: 'POST', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { email: adminEmail, roleId: adminRole.body.id } });
    assert.equal(adminInvite.status, 202);
    const adminInviteToken = delivered.at(-1).token;
    const adminPassword = 'synthetic-manager-password-290';
    const adminAccepted = await call('/api/identity/membership-invitations/accept', { method: 'POST',
      body: { token: adminInviteToken, password: adminPassword } });
    assert.equal(adminAccepted.status, 200);
    await client.query('SELECT set_config(\'app.tenant_id\',$1,true)', [companyId]);
    const mfaState = await client.query('SELECT mfa_required FROM rotamoto.credentials WHERE user_id=$1', [adminAccepted.body.userId]);
    assert.equal(mfaState.rows[0].mfa_required, true, 'administrative role invitations require MFA before activation of a session');
    const noProvider = createIdentityService({ pool, emailProvider: provider });
    await assert.rejects(noProvider.authenticate(adminEmail, adminPassword, companyId), error => error.code === 'MFA_REQUIRED',
      'administrative login fails closed when there is no MFA provider');
    const adminLogin = await call('/api/identity/login', { method: 'POST', body: { email: adminEmail,
      password: adminPassword, companyId, mfaCode: '654321' } });
    assert.equal(adminLogin.status, 200);
    const adminCookie = adminLogin.headers.get('set-cookie').split(';', 1)[0];
    const adminSession = await call('/api/identity/session', { cookie: adminCookie });
    assert.equal(adminSession.body.mfaVerified, true);
    const authorizedAdminRead = await call('/api/admin/company', { cookie: adminCookie });
    assert.equal(authorizedAdminRead.status, 200, 'MFA-verified admin session can use tenant administration');

    const forbiddenOrigin = await call('/api/identity/logout', { method: 'POST', cookie: sessionCookie,
      csrf: session.body.csrfToken, origin: 'https://attacker.invalid' });
    assert.equal(forbiddenOrigin.status, 403);
    assert.equal(forbiddenOrigin.body.error.code, 'ORIGIN_INVALID');
    const logoutMissingCsrf = await call('/api/identity/logout', { method: 'POST', cookie: sessionCookie });
    assert.equal(logoutMissingCsrf.status, 403);
    const logout = await call('/api/identity/logout', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/u);
    assert.equal((await call('/api/identity/session', { cookie: sessionCookie })).status, 401, 'logout revokes session');

    const loginAgain = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, mfaCode: '654321' } });
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
