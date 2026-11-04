'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createClient } = require('../backend/postgres/connection');
const { createIdentityService } = require('../backend/identity/service');
const { createEmailDeliveryProvider } = require('../backend/identity/email-provider');
const { createMfaProvider } = require('../backend/identity/mfa-provider');
const { createNativeMfaProvider } = require('../backend/identity/native-mfa-provider');
const { codeAt } = require('../backend/identity/totp');
const { createIdentityHttpHandler, createRateLimiter, COOKIE_NAME } = require('../backend/identity/http');
const { createAdminHttpHandler } = require('../backend/admin/http');
const { createAdminRepository } = require('../backend/admin/repository');
const { createAdminService } = require('../backend/admin/service');
const { createE2eClients, assertConnectedIdentity } = require('./e2e-support/guards');

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

async function readFounderBootstrapState(client, database = 'rotamoto_e2e') {
  await assertConnectedIdentity(client, { database, role: 'rotamoto_migrator', env: process.env });
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(`SELECT
      (SELECT count(*)::int FROM rotamoto.platform_administrators WHERE revoked_at IS NULL) AS active_admins,
      (SELECT founder_user_id FROM rotamoto.platform_admin_bootstrap_latch WHERE singleton=true) AS founder_user_id,
      EXISTS(SELECT 1 FROM rotamoto.platform_administrators pa
        JOIN rotamoto.platform_admin_bootstrap_latch latch ON latch.singleton=true AND latch.founder_user_id=pa.user_id
        WHERE pa.revoked_at IS NULL) AS active_grant_matches_founder,
      (SELECT count(*)::int FROM rotamoto.platform_administrators) AS admin_history,
      (SELECT completed_at IS NOT NULL FROM rotamoto.installation_bootstrap WHERE singleton=true) AS installation_complete`);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function main() {
  assert.equal(process.env.NODE_ENV,'test','HTTP PostgreSQL integration fixtures require NODE_ENV=test');
  const clients=createE2eClients(process.env);
  const client=clients.runtime;
  await client.connect();
  await clients.migrator.connect();
  await assertConnectedIdentity(client,{database:clients.database,role:'rotamoto_app',env:process.env});
  await client.query('BEGIN');
  const pool = savepointPool(client);
  const delivered = [];
  const activationNotices = [];
  const provider = createEmailDeliveryProvider(async message => {
    if (message.kind === 'account_activated') activationNotices.push(message);
    else delivered.push(message);
    return { accepted: true };
  });
  const logs = [];
  const syntheticSecrets=new Map();
  // Match the runtime contract: loadLocalSecretProvider is asynchronous and
  // resolves to the keystore interface after validating its private files.
  const secretProvider = Promise.resolve({async put({value}){const secretRef=`test:synthetic:${crypto.randomUUID()}`;syntheticSecrets.set(secretRef,value);return{secretRef};},
      async get(secretRef){if(!syntheticSecrets.has(secretRef))throw new Error('synthetic secret missing');return syntheticSecrets.get(secretRef);},
      async remove(secretRef){syntheticSecrets.delete(secretRef);}});
  const service = createIdentityService({ pool, emailProvider: provider, mfaProvider: createMfaProvider(async ({ code }) => code === '654321'),
    secretProvider,
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
    assert.equal(unauthorized.status, 403, `unauthorized synthetic provisioning status; events=${logs.map(event=>event.errorCode||event.code||event.event||'event').join(',')}`);
    assert.equal(unauthorized.body.error.code, 'PROVISIONER_UNAUTHORIZED');
    if (process.env.IDENTITY_HTTP_PREFLIGHT_ONLY === '1') {
      const authorizedButNotReady = await call('/api/admin/tenants/provision', { method: 'POST', body: provisionBody,
        extraHeaders: { 'X-Synthetic-Operator': 'test-only' } });
      assert.equal(authorizedButNotReady.status, 503, 'authorized installation still respects bootstrap readiness');
      assert.equal(authorizedButNotReady.body.error.code, 'BOOTSTRAP_NOT_READY');
      assert.equal(delivered.length, 0, 'bootstrap readiness failure sends no invitation');
      process.stdout.write('Identity HTTP provisioning authorization precedes readiness; authorized request remains blocked before tenant writes PASS (transaction rolled back)\n');
      return;
    }
    const provisioned = await call('/api/admin/tenants/provision', { method: 'POST', body: provisionBody,
      extraHeaders: { 'X-Synthetic-Operator': 'test-only' } });
    assert.equal(provisioned.status, 202, `synthetic bootstrap returned ${provisioned.body?.error?.code || 'unexpected-response'}; events=${logs.map(event=>event.errorCode||event.code||event.event||'event').join(',')}`);
    assert.equal(provisioned.body.delivery, 'sent');
    assert.equal(JSON.stringify(provisioned.body).includes(delivered[0].token), false);
    assert.equal(JSON.stringify(provisioned.body).includes(email), false, 'provision response does not reveal the recipient');
    companyId = provisioned.body.companyId;
    const firstDeliveryCount = delivered.length;
    const provisionReplay = await call('/api/admin/tenants/provision', { method: 'POST', body: provisionBody,
      extraHeaders: { 'X-Synthetic-Operator': 'test-only' } });
    assert.equal(provisionReplay.status, 202);
    assert.equal(provisionReplay.body.replayed, true, 'same idempotency key and request returns the existing operation');
    assert.equal(delivered.length, firstDeliveryCount, 'provision replay does not send another invitation');
    const provisionConflict = await call('/api/admin/tenants/provision', { method: 'POST',
      body: { ...provisionBody, companyName: 'Different tenant name' },
      extraHeaders: { 'X-Synthetic-Operator': 'test-only' } });
    assert.equal(provisionConflict.status, 409, 'idempotency key cannot be rebound to another request');
    assert.deepEqual(provisionConflict.body.error,
      { code: 'IDEMPOTENCY_CONFLICT', message: 'Chave idempotente já utilizada para outra solicitação.' });
    assert.equal(JSON.stringify(provisionConflict.body).includes(companyId), false, 'idempotency conflict does not leak tenant identifiers');

    const accepted = await call('/api/identity/invitations/accept', { method: 'POST',
      body: { token: delivered[0].token, password } });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.mfaRequired, true);
    assert.deepEqual(activationNotices, [{ to: email, kind: 'account_activated' }],
      'successful owner activation sends only the minimal confirmation notice');
    const acceptedAgain = await call('/api/identity/invitations/accept', { method: 'POST',
      body: { token: delivered[0].token, password } });
    assert.equal(acceptedAgain.status, 401, 'invite token is single-use');
    assert.equal(activationNotices.length, 1, 'consumed invite retry does not duplicate the activation notice');
    const invalidInvitation = await call('/api/identity/invitations/accept', { method: 'POST',
      body: { token: crypto.randomBytes(32).toString('base64url'), password } });
    assert.equal(invalidInvitation.status, 401);
    assert.deepEqual(invalidInvitation.body.error, acceptedAgain.body.error,
      'invalid and consumed invite tokens have indistinguishable public errors');
    const expiredInvitation = crypto.randomBytes(32).toString('base64url');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query(`INSERT INTO rotamoto.identity_tokens
      (id,company_id,user_id,purpose,token_digest,created_at,expires_at)
      VALUES ($1,$2,$3,'owner_invitation',$4,now()-interval '2 days',now()-interval '1 day')`,
    [crypto.randomUUID(), companyId, provisioned.body.userId, crypto.createHash('sha256').update(expiredInvitation).digest()]);
    const expiredInvitationResponse = await call('/api/identity/invitations/accept', { method: 'POST',
      body: { token: expiredInvitation, password } });
    assert.equal(expiredInvitationResponse.status, 401);
    assert.deepEqual(expiredInvitationResponse.body.error, acceptedAgain.body.error,
      'expired, invalid and consumed invite tokens share a generic error');

    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query(`UPDATE rotamoto.credentials SET mfa_required=false WHERE user_id=$1`, [accepted.body.userId]);
    const missingMfa = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId } });
    assert.equal(missingMfa.status, 200, 'an identity without an enrolled MFA secret receives only an enrollment-limited session');
    assert.equal(missingMfa.body.mfaEnrollmentRequired, true);
    const limitedCookie=missingMfa.headers.get('set-cookie').split(';',1)[0];
    const limitedSession=await call('/api/identity/session',{cookie:limitedCookie});
    assert.equal(limitedSession.status,200);assert.equal(limitedSession.body.mfaEnrollmentRequired,true);
    assert.equal(limitedSession.body.mfaVerified,false);
    assert.equal(limitedSession.body.mfaRequired,true);
    const limitedAdmin=await call('/api/admin/memberships?limit=100',{cookie:limitedCookie});
    assert.equal(limitedAdmin.status,403,'enrollment-limited session cannot access administrative data');
    assert.equal(limitedAdmin.body.error.code,'MFA_REQUIRED');
    const limitedRoles=await call('/api/admin/roles',{cookie:limitedCookie});
    assert.equal(limitedRoles.status,403,'enrollment-limited session cannot read role configuration directly through the API');
    const limitedRoleWrite=await call('/api/admin/roles',{method:'POST',cookie:limitedCookie,csrf:missingMfa.body.csrfToken,
      body:{key:'pre_mfa_write',name:'Pre MFA Write',permissions:['orders.read']}});
    assert.equal(limitedRoleWrite.status,403,'enrollment-limited session cannot write role configuration through a direct API request');
    assert.equal(limitedRoleWrite.body.error.code,'MFA_REQUIRED');
    const limitedPasswordChange=await call('/api/identity/password/change',{method:'POST',cookie:limitedCookie,csrf:missingMfa.body.csrfToken,
      body:{currentPassword:password,newPassword:'synthetic-new-password-990'}});
    assert.equal(limitedPasswordChange.status,403,'password changes remain blocked until required MFA is verified');
    assert.equal(limitedPasswordChange.body.error.code,'MFA_REQUIRED');
    let preMfaCallbackInvoked=false;
    await assert.rejects(service.withAuthenticatedTenant(limitedCookie.slice(limitedCookie.indexOf('=')+1),async()=>{
      preMfaCallbackInvoked=true;return true;
    }),error=>error.code==='MFA_REQUIRED','the central tenant guard blocks protected operations even when a caller omits a permission key');
    assert.equal(preMfaCallbackInvoked,false,'the protected operation callback is never invoked before MFA');
    await client.query('SAVEPOINT mfa_enrollment_http');
    const cancelledEnrollment=await call('/api/identity/mfa/enrollment',{method:'POST',body:{},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(cancelledEnrollment.status,200,'a limited account can begin its required MFA setup');
    const cancelledMfaSetup=await call('/api/identity/mfa/enrollment/cancel',{method:'POST',body:{},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(cancelledMfaSetup.status,200);assert.deepEqual(cancelledMfaSetup.body,{cancelled:true},'cancelling setup removes only the pending factor');
    assert.equal(syntheticSecrets.size,0,'cancelled setup removes its temporary secret from the test provider');
    const enrollment=await call('/api/identity/mfa/enrollment',{method:'POST',body:{},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(enrollment.status,200,'enrollment start remains available to the limited session');
    assert.equal(typeof enrollment.body.secret,'string');
    assert.match(enrollment.body.otpauthUri,/^otpauth:\/\/totp\//u);
    const enrollmentCode=codeAt(enrollment.body.secret,Math.floor(Date.now()/30000));
    const confirmation=await call('/api/identity/mfa/enrollment/confirm',{method:'POST',body:{code:enrollmentCode},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(confirmation.status,200,'valid TOTP confirmation upgrades the session');
    assert.equal(Array.isArray(confirmation.body.recoveryCodes),true);
    const afterMfa=await call('/api/admin/roles',{cookie:limitedCookie});
    assert.equal(afterMfa.status,200,'protected administrative reads become available after valid MFA confirmation');
    const replacementWithoutProof=await call('/api/identity/mfa/enrollment',{method:'POST',body:{},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(replacementWithoutProof.status,403,'replacing an existing factor requires fresh identity proof');
    assert.equal(replacementWithoutProof.body.error.code,'MFA_REQUIRED');
    const replacementWithWrongPassword=await call('/api/identity/mfa/enrollment',{method:'POST',body:{currentPassword:'synthetic-wrong-password',currentMfaCode:'654321'},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(replacementWithWrongPassword.status,400);assert.equal(replacementWithWrongPassword.body.error.code,'CURRENT_PASSWORD_INVALID');
    const replacement=await call('/api/identity/mfa/enrollment',{method:'POST',body:{currentPassword:password,currentMfaCode:'654321'},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(replacement.status,200,'replacing a factor verifies the current password, MFA code and session');
    assert.notEqual(replacement.body.secret,enrollment.body.secret,'the old secret is never returned as the replacement secret');
    const cancelledReplacement=await call('/api/identity/mfa/enrollment/cancel',{method:'POST',body:{},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.deepEqual(cancelledReplacement.body,{cancelled:true});
    assert.equal(syntheticSecrets.size,1,'cancelling factor replacement preserves the currently active secret');
    assert.equal((await call('/api/identity/session',{cookie:limitedCookie})).body.mfaConfigured,true,'cancelled replacement leaves the current MFA factor active');
    await client.query('ROLLBACK TO SAVEPOINT mfa_enrollment_http');
    await client.query('RELEASE SAVEPOINT mfa_enrollment_http');
    syntheticSecrets.clear();
    const pendingLogout=await call('/api/identity/logout',{method:'POST',body:{},cookie:limitedCookie,csrf:missingMfa.body.csrfToken});
    assert.equal(pendingLogout.status,204,'logout remains available before MFA confirmation');
    assert.equal((await call('/api/admin/roles',{cookie:limitedCookie})).status,401,'logout immediately removes access to protected API reads');
    await client.query(`UPDATE rotamoto.credentials SET mfa_secret_ref='local-v1:synthetic-test-reference' WHERE user_id=$1`, [accepted.body.userId]);
    const rejectedMfa = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, mfaCode: '000000' } });
    assert.equal(rejectedMfa.status, 403, 'invalid MFA proof cannot establish a session');
    const wrong = await call('/api/identity/login', { method: 'POST', body: { email, password: 'synthetic-wrong-password' , companyId } });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body.error, { code: 'INVALID_CREDENTIALS', message: 'Email ou senha inválidos.' });
    const login = await call('/api/identity/login', { method: 'POST', body: { email, password, mfaCode: '654321' } });
    assert.equal(login.status, 200);
    assert.deepEqual(login.body.companies, [{ companyId, name: provisionBody.companyName }],
      'single active membership is resolved automatically without a browser-supplied tenant identifier');
    const cookieHeader = login.headers.get('set-cookie');
    assert.match(cookieHeader, /^__Host-rotamoto_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=43200; Secure; HttpOnly; SameSite=Lax$/u);
    const sessionCookie = cookieHeader.split(';', 1)[0];
    assert.equal(Object.hasOwn(login.body, 'sessionToken'), false);
    assert.equal(JSON.stringify(login.body).includes(password), false);
    assert.equal(JSON.stringify(login.body).includes('password_phc'), false);

    const session = await call('/api/identity/session?companyId=00000000-0000-7000-8000-000000000000', { cookie: sessionCookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.activeCompanyId, companyId, 'tenant context comes from validated session');
    assert.equal(session.body.activeCompanyName, provisionBody.companyName, 'account UI receives the canonical active company name from the authenticated tenant');
    assert.equal(session.body.email, email);
    assert.equal(session.body.mfaVerified, true);
    const linkedCompanies = await call('/api/identity/companies', { cookie: sessionCookie });
    assert.equal(linkedCompanies.status, 200);
    assert.deepEqual(linkedCompanies.body.companies, [{ companyId, name: provisionBody.companyName,
      membershipStatus: 'active', companyStatus: 'active', isActive: true, canSwitch: true }],
      'linked company options are derived from the authenticated user and include no other tenant');
    assert.equal(session.body.csrfToken, login.body.csrfToken, 'session bootstrap preserves a stable CSRF token for reload-safe in-memory use');
    assert.equal(JSON.stringify(session.body).includes('password_phc'), false);
    const parallelLogin=await call('/api/identity/login',{method:'POST',body:{email,password,companyId,mfaCode:'654321'}});
    assert.equal(parallelLogin.status,200,'a second authenticated session is available to verify session revocation');
    const parallelCookie=parallelLogin.headers.get('set-cookie').split(';',1)[0];
    const missingPasswordCsrf=await call('/api/identity/password/change',{method:'POST',cookie:sessionCookie,body:{currentPassword:password,newPassword:'synthetic-new-password-901'}});
    assert.equal(missingPasswordCsrf.status,403);assert.equal(missingPasswordCsrf.body.error.code,'CSRF_INVALID');
    const invalidPasswordChange=await call('/api/identity/password/change',{method:'POST',cookie:sessionCookie,csrf:session.body.csrfToken,
      body:{currentPassword:password,newPassword:'short'}});
    assert.equal(invalidPasswordChange.status,400,'weak new passwords are rejected at the HTTP boundary');
    const unchangedPassword=await call('/api/identity/password/change',{method:'POST',cookie:sessionCookie,csrf:session.body.csrfToken,
      body:{currentPassword:password,newPassword:password}});
    assert.equal(unchangedPassword.status,400);assert.equal(unchangedPassword.body.error.code,'PASSWORD_UNCHANGED');
    const wrongCurrentPassword=await call('/api/identity/password/change',{method:'POST',cookie:sessionCookie,csrf:session.body.csrfToken,
      body:{currentPassword:'synthetic-wrong-password',newPassword:'synthetic-new-password-901'}});
    assert.equal(wrongCurrentPassword.status,400);assert.equal(wrongCurrentPassword.body.error.code,'CURRENT_PASSWORD_INVALID');
    assert.equal((await call('/api/identity/session',{cookie:sessionCookie})).status,200,'a rejected current password does not destroy the valid session');
    const replacementPassword='synthetic-password-changed-902';
    const passwordChanged=await call('/api/identity/password/change',{method:'POST',cookie:sessionCookie,csrf:session.body.csrfToken,
      body:{currentPassword:password,newPassword:replacementPassword}});
    assert.equal(passwordChanged.status,200);assert.deepEqual(passwordChanged.body,{changed:true},'password success is returned only after the transaction commits');
    assert.equal((await call('/api/identity/session',{cookie:sessionCookie})).status,200,'the session that changed its password remains active');
    assert.equal((await call('/api/identity/session',{cookie:parallelCookie})).status,401,'other sessions are revoked after the password change');
    assert.equal((await call('/api/identity/login',{method:'POST',body:{email,password,companyId,mfaCode:'654321'}})).status,401,'the previous password stops authenticating');
    const replacementLogin=await call('/api/identity/login',{method:'POST',body:{email,password:replacementPassword,companyId,mfaCode:'654321'}});
    assert.equal(replacementLogin.status,200,'the new password authenticates after persistence');
    const restorePassword=await call('/api/identity/password/change',{method:'POST',cookie:sessionCookie,csrf:session.body.csrfToken,
      body:{currentPassword:replacementPassword,newPassword:password}});
    assert.equal(restorePassword.status,200,'the fixture password is restored through the same authenticated route before rollback');
    const restoredLogin=await call('/api/identity/login',{method:'POST',body:{email,password,companyId,mfaCode:'654321'}});
    assert.equal(restoredLogin.status,200,'password readback remains correct after restoration');
    const csrfStable = await call('/api/identity/tenant', { method: 'POST', body: { companyId }, cookie: sessionCookie, csrf: login.body.csrfToken });
    assert.equal(csrfStable.status, 200, 'stable CSRF remains valid after session bootstrap');
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
    assert(ownerRole.permissions.includes('finance.read') && ownerRole.permissions.includes('finance.manage'),
      'current bootstrap grants tenant finance access to the company owner explicitly');
    const companyBefore=await call('/api/admin/company',{cookie:sessionCookie});
    assert.equal(companyBefore.status,200,'authenticated company configuration reads the canonical tenant');
    assert.equal(companyBefore.body.deliveryPricing.configured,false,'legacy device pricing is not silently migrated to the company');
    const companyWrite={expectedVersion:companyBefore.body.settingsVersion,expectedLocationVersion:companyBefore.body.operationalLocationVersion,
      name:'Synthetic HTTP Tenant Updated',supportPhone:'11999990000',timeZone:'America/Sao_Paulo',routeGroupingPolicy:'nearest_origin_round_robin',
      operationalLocation:{address:'Rua Sintética, 10',latitude:-23.55,longitude:-46.63}};
    const companySaved=await call('/api/admin/company/settings',{method:'PUT',cookie:sessionCookie,csrf:login.body.csrfToken,body:companyWrite});
    assert.equal(companySaved.status,200,'the atomic company settings write is accepted through authenticated HTTP');
    const companyReadback=await call('/api/admin/company',{cookie:sessionCookie});
    assert.equal(companyReadback.body.name,companyWrite.name);assert.equal(companyReadback.body.supportPhone,companyWrite.supportPhone);
    assert.equal(companyReadback.body.timeZone,companyWrite.timeZone);assert.equal(companyReadback.body.routeGroupingPolicy,companyWrite.routeGroupingPolicy);
    assert.deepEqual(companyReadback.body.operationalLocation,{...companyWrite.operationalLocation,provenance:'operator_confirmed',version:companySaved.body.operationalLocationVersion});
    assert.equal(companyReadback.body.settingsVersion,companySaved.body.settingsVersion,'canonical readback observes the committed company revision');
    const staleCompany=await call('/api/admin/company/settings',{method:'PUT',cookie:sessionCookie,csrf:login.body.csrfToken,body:{...companyWrite,name:'Stale overwrite'}});
    assert.equal(staleCompany.status,409,'stale company revisions are rejected');
    assert.equal((await call('/api/admin/company',{cookie:sessionCookie})).body.name,companyWrite.name,'conflict does not overwrite canonical values');
    const pricing={model:'range',minFee:4.5,perKm:2.25,fixedFee:18,round:true,roundTo:0.5,
      ranges:[{from:0,to:3,value:7},{from:3,to:null,value:12}],repasseMode:'percentage',repassePercent:85};
    const pricingSaved=await call('/api/admin/company/delivery-pricing',{method:'PUT',cookie:sessionCookie,csrf:login.body.csrfToken,
      body:{expectedVersion:0,settings:pricing}});
    assert.equal(pricingSaved.status,200,'first reviewed pricing publication succeeds with MFA-authenticated company session');
    const pricingReadback=await call('/api/admin/company/delivery-pricing',{cookie:sessionCookie});
    assert.equal(pricingReadback.status,200);assert.equal(pricingReadback.body.configured,true);
    assert.equal(pricingReadback.body.version,pricingSaved.body.version);assert.deepEqual(pricingReadback.body.settings,pricing);
    const stalePricing=await call('/api/admin/company/delivery-pricing',{method:'PUT',cookie:sessionCookie,csrf:login.body.csrfToken,
      body:{expectedVersion:0,settings:{...pricing,model:'perKm',perKm:9}}});
    assert.equal(stalePricing.status,409,'concurrent pricing writes cannot overwrite the newer version');
    const badPricing=await call('/api/admin/company/delivery-pricing',{method:'PUT',cookie:sessionCookie,csrf:login.body.csrfToken,
      body:{expectedVersion:1,settings:{...pricing,ranges:[null]}}});
    assert.equal(badPricing.status,400,'malformed range data is rejected by the API');
    const missingCsrf=await call('/api/admin/company/delivery-pricing',{method:'PUT',cookie:sessionCookie,
      body:{expectedVersion:1,settings:pricing}});assert.equal(missingCsrf.status,403,'pricing write still requires CSRF');
    assert.equal((await call('/api/admin/company/delivery-pricing',{cookie:sessionCookie})).body.version,1,'negative requests leave persisted pricing unchanged');
    const ownerPrincipal = await service.resolveSession(client, sessionCookie.slice(sessionCookie.indexOf('=') + 1));
    await client.query(`DELETE FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2
      AND permission_key=ANY($3::text[])`, [companyId, ownerRole.id, ['finance.read','finance.manage']]);
    const ownerBeforeFinanceRestore = await call('/api/identity/session', { cookie: sessionCookie });
    assert.equal(ownerBeforeFinanceRestore.body.permissions.includes('finance.read'), false, 'tenant owner does not inherit financial access from platform or owner label');
    assert.equal(ownerBeforeFinanceRestore.body.platformAdmin, false, 'tenant owner is distinct from platform administration');
    await assert.rejects(service.withAuthenticatedTenant(sessionCookie.slice(sessionCookie.indexOf('=') + 1), async () => true, 'finance.read'),
      error => error.code === 'FORBIDDEN', 'finance.read requires an explicit tenant role grant');
    await client.query('UPDATE rotamoto.sessions SET mfa_verified_at=NULL WHERE id=$1', [ownerPrincipal.session_id]);
    const pendingAdminRead=await call('/api/admin/roles',{cookie:sessionCookie});
    assert.equal(pendingAdminRead.status,403,'a stale session with configured MFA but no verified MFA marker cannot read protected administration data');
    await assert.rejects(service.withAuthenticatedTenant(sessionCookie.slice(sessionCookie.indexOf('=') + 1), async () => true, 'finance.manage'),
      error => error.code === 'MFA_REQUIRED', 'finance.manage remains unavailable when the session MFA proof is not verified');
    const pendingAdminWrite=await call('/api/admin/roles',{method:'POST',cookie:sessionCookie,csrf:session.body.csrfToken,
      body:{key:'pending_mfa_write',name:'Pending MFA Write',permissions:['orders.read']}});
    assert.equal(pendingAdminWrite.status,403,'a stale session with no MFA marker cannot write protected administration data');
    const restoreWhileMfaPending = await call('/api/admin/roles/owner/restore-finance', { method: 'POST', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: {} });
    assert.equal(restoreWhileMfaPending.body.error.code, 'MFA_REQUIRED', 'financial permission restoration remains MFA-gated');
    const noProviderService = createIdentityService({ pool });
    await assert.rejects(noProviderService.inviteMembershipWithSession(sessionCookie.slice(sessionCookie.indexOf('=') + 1),
      session.body.csrfToken, { email: `mfa-gate-${crypto.randomUUID()}@example.invalid`, roleId: ownerRole.id }),
    error => error.code === 'MFA_REQUIRED', 'membership invitation cannot bypass session MFA when its provider is unavailable');
    await client.query('UPDATE rotamoto.sessions SET mfa_verified_at=now() WHERE id=$1', [ownerPrincipal.session_id]);
    const restoreFinance = await call('/api/admin/roles/owner/restore-finance', { method: 'POST', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: {} });
    assert.equal(restoreFinance.status, 200, 'active tenant owner can explicitly restore only its canonical finance permissions after MFA');
    assert.deepEqual(restoreFinance.body.permissions, ['finance.manage','finance.read']);
    assert.equal(restoreFinance.body.addedPermissionCount, 2);
    assert.equal((await call('/api/admin/roles/owner/restore-finance', { method: 'POST', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: {} })).body.addedPermissionCount, 0, 'restoration is idempotent');
    const ownerAfterFinanceRestore = await call('/api/identity/session', { cookie: sessionCookie });
    assert.equal(ownerAfterFinanceRestore.body.permissions.includes('finance.read'), true);
    assert.equal(ownerAfterFinanceRestore.body.permissions.includes('finance.manage'), true);
    await service.withAuthenticatedTenant(sessionCookie.slice(sessionCookie.indexOf('=') + 1), async () => true, 'finance.read');
    await service.withAuthenticatedTenant(sessionCookie.slice(sessionCookie.indexOf('=') + 1), async () => true, 'finance.manage');
    const permissions = await call('/api/admin/permissions', { cookie: sessionCookie });
    assert.equal(permissions.status, 200);
    assert(permissions.body.permissions.some(permission => permission.key === 'orders.read'));
    const createdRole = await call('/api/admin/roles', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { key: 'qa_reader', name: 'Leitura QA', permissions: ['orders.read'] } });
    assert.equal(createdRole.status, 201);
    await assert.rejects(createAdminRepository().restoreOwnerFinancePermissions(client,
      { ...ownerPrincipal, role_id: createdRole.body.id }), error => error.code === 'FORBIDDEN',
    'a non-owner role cannot use the owner-only finance restoration');
    assert.match(createdRole.headers.get('x-request-id'), /^[0-9a-f-]{36}$/iu, 'administrative responses carry a correlation ID');
    const ownerMembers = await call('/api/admin/memberships?limit=100', { cookie: sessionCookie });
    const ownerMember = ownerMembers.body.members.find(member => member.userId === accepted.body.userId);
    assert(ownerMember);
    assert.equal(ownerMember.status, 'active', 'company membership stays active independently of an operational Driver association');
    assert.equal(ownerMember.roleKey, 'owner', 'the first provisioned identity is a company owner');
    assert.equal(ownerMember.driverId, null, 'owner identity is not a Motoboy Driver association by default');
    assert(ownerMember.permissions.includes('sync.pull') && ownerMember.permissions.includes('sync.push'),
      'sync permissions do not themselves imply a Motoboy Driver link');
    const selfChange = await call(`/api/admin/memberships/${ownerMember.membershipId}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { roleId: createdRole.body.id } });
    assert.equal(selfChange.status, 403, 'users cannot alter their own membership role');
    assert.equal(selfChange.body.error.code, 'FORBIDDEN');
    const systemRoleEdit = await call(`/api/admin/roles/${ownerRole.id}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { name: 'Owner', permissions: ['orders.read'] } });
    assert.equal(systemRoleEdit.status, 403, 'owner system role is immutable');
    const restoreWithoutCsrf = await call('/api/admin/roles/owner/restore-finance', { method: 'POST', cookie: sessionCookie, body: {} });
    assert.equal(restoreWithoutCsrf.body.error.code, 'CSRF_INVALID');
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
    const invitedMembershipToken = delivered.at(-1).token;
    const resent = await call('/api/admin/invitations', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { email: invitedEmail, roleId: createdRole.body.id } });
    assert.equal(resent.status, 202, 'an invited membership can be resent through the authorized invite flow');
    const resentMembershipToken = delivered.at(-1).token;
    assert.notEqual(resentMembershipToken, invitedMembershipToken, 'resend rotates the invitation token');
    const supersededToken = await call('/api/identity/membership-invitations/accept', { method: 'POST',
      body: { token: invitedMembershipToken, password: 'synthetic-invited-password-991' } });
    assert.equal(supersededToken.status, 401, 'a resent invitation invalidates the prior token');
    const secondCompanyEmail = `identity-second-owner-${crypto.randomUUID()}@example.invalid`;
    const secondCompanyPassword = 'synthetic-second-owner-password-748';
    const secondProvision = await call('/api/admin/tenants/provision', { method: 'POST',
      body: { companyName: 'Second Synthetic Tenant', email: secondCompanyEmail, idempotencyKey: `http-${crypto.randomUUID()}` },
      extraHeaders: { 'X-Synthetic-Operator': 'test-only' } });
    assert.equal(secondProvision.status, 202);
    const secondOwnerAccepted = await call('/api/identity/invitations/accept', { method: 'POST',
      body: { token: delivered.at(-1).token, password: secondCompanyPassword } });
    assert.equal(secondOwnerAccepted.status, 200);
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [secondProvision.body.companyId]);
    await client.query(`UPDATE rotamoto.credentials SET mfa_required=false,
      mfa_secret_ref='local-v1:synthetic-test-reference' WHERE user_id=$1`, [secondOwnerAccepted.body.userId]);
    const secondOwnerLogin = await call('/api/identity/login', { method: 'POST', body: {
      email: secondCompanyEmail, password: secondCompanyPassword, companyId: secondProvision.body.companyId, mfaCode: '654321' } });
    assert.equal(secondOwnerLogin.status, 200);
    const secondOwnerCookie = secondOwnerLogin.headers.get('set-cookie').split(';', 1)[0];
    const secondTenantRole = await call('/api/admin/roles', { method: 'POST', cookie: secondOwnerCookie, csrf: secondOwnerLogin.body.csrfToken,
      body: { key: 'qa_existing_user', name: 'Leitura multiempresa', permissions: ['orders.read'] } });
    assert.equal(secondTenantRole.status, 201);
    const existingIdentityInvite = await call('/api/admin/invitations', { method: 'POST', cookie: secondOwnerCookie,
      csrf: secondOwnerLogin.body.csrfToken, body: { email, roleId: secondTenantRole.body.id } });
    assert.equal(existingIdentityInvite.status, 202, 'another tenant can invite an already existing identity without creating a duplicate User');
    const existingIdentityToken = delivered.at(-1).token;
    const missingAcceptCsrf = await call('/api/identity/membership-invitations/accept-authenticated', { method: 'POST',
      body: { token: existingIdentityToken }, cookie: sessionCookie });
    assert.equal(missingAcceptCsrf.status, 403, 'accepting an existing identity invitation requires CSRF');
    const acceptedExistingIdentity = await call('/api/identity/membership-invitations/accept-authenticated', { method: 'POST',
      body: { token: existingIdentityToken }, cookie: sessionCookie, csrf: session.body.csrfToken });
    assert.equal(acceptedExistingIdentity.status, 200, 'existing signed-in User can accept a second-company membership');
    assert.equal(acceptedExistingIdentity.body.companyId, secondProvision.body.companyId);
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [secondProvision.body.companyId]);
    const existingIdentityMembership = await client.query(`SELECT u.id::text AS user_id,count(m.id)::int AS memberships,
      min(m.status) AS status FROM rotamoto.users u JOIN rotamoto.memberships m ON m.user_id=u.id
      WHERE u.email=$1 AND m.company_id=$2 GROUP BY u.id`, [email, secondProvision.body.companyId]);
    assert.equal(existingIdentityMembership.rowCount, 1);
    assert.equal(existingIdentityMembership.rows[0].user_id, accepted.body.userId, 'multi-company invite reuses the existing canonical User');
    assert.equal(existingIdentityMembership.rows[0].memberships, 1);
    assert.equal(existingIdentityMembership.rows[0].status, 'active');
    const multiCompanyLogin = await call('/api/identity/login', { method: 'POST', body: { email, password, mfaCode: '654321' } });
    assert.equal(multiCompanyLogin.status, 200, 'email/password plus MFA authenticates without a technical company identifier');
    assert.deepEqual(multiCompanyLogin.body.companies.map(company => company.name),
      ['Second Synthetic Tenant', 'Synthetic HTTP Tenant'], 'only companies linked to the authenticated identity are returned after valid MFA');
    assert.equal(multiCompanyLogin.body.companyId, multiCompanyLogin.body.companies[0].companyId,
      'a multi-company session starts in a backend-resolved authorized context while the UI gates operational startup for selection');
    const unknownEmailLogin = await call('/api/identity/login', { method: 'POST', body: {
      email: `unknown-${crypto.randomUUID()}@example.invalid`, password, mfaCode: '654321' } });
    assert.equal(unknownEmailLogin.status, 401);
    assert.deepEqual(unknownEmailLogin.body.error, { code: 'INVALID_CREDENTIALS', message: 'Email ou senha inválidos.' },
      'email-only lookup does not disclose account or company existence');
    assert.equal(Object.hasOwn(unknownEmailLogin.body, 'companies'), false);
    const wrongTenantUser = await call('/api/identity/membership-invitations/accept-authenticated', { method: 'POST',
      body: { token: invitedMembershipToken }, cookie: secondOwnerCookie, csrf: secondOwnerLogin.body.csrfToken });
    assert.equal(wrongTenantUser.status, 401, 'a session from another tenant cannot consume a token addressed to a different user');
    assert.deepEqual(wrongTenantUser.body.error,
      { code: 'INVALID_TOKEN', message: 'Token inválido ou expirado.' }, 'cross-tenant token failure does not reveal its owner');
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
    const revokeEmail = `identity-revoked-invite-${crypto.randomUUID()}@example.invalid`;
    const revokeInvite = await call('/api/admin/invitations', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { email: revokeEmail, roleId: createdRole.body.id } });
    assert.equal(revokeInvite.status, 202);
    const revokedToken = delivered.at(-1).token;
    const revoked = await call(`/api/admin/memberships/${revokeInvite.body.membershipId}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { status: 'revoked' } });
    assert.equal(revoked.status, 200, 'authorized manager can revoke an invited membership');
    const revokedAcceptance = await call('/api/identity/membership-invitations/accept', { method: 'POST',
      body: { token: revokedToken, password: 'synthetic-invited-password-991' } });
    assert.equal(revokedAcceptance.status, 401, 'revoked membership invitation cannot be accepted');
    const expiredEmail = `identity-expired-invite-${crypto.randomUUID()}@example.invalid`;
    const expiredInvite = await call('/api/admin/invitations', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { email: expiredEmail, roleId: createdRole.body.id } });
    assert.equal(expiredInvite.status, 202);
    const expiredMemberToken = delivered.at(-1).token;
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query(`UPDATE rotamoto.identity_tokens SET created_at=now()-interval '2 days',expires_at=now()-interval '1 second'
      WHERE token_digest=$1 AND purpose='membership_invitation'`, [crypto.createHash('sha256').update(expiredMemberToken).digest()]);
    const expiredAcceptance = await call('/api/identity/membership-invitations/accept', { method: 'POST',
      body: { token: expiredMemberToken, password: 'synthetic-invited-password-991' } });
    assert.equal(expiredAcceptance.status, 401, 'expired membership invitation cannot be accepted');
    const invitedPassword = 'synthetic-invited-password-991';
    const invitationAccepted = await call('/api/identity/membership-invitations/accept', { method: 'POST',
      body: { token: resentMembershipToken, password: invitedPassword } });
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
    const observerRole = await call('/api/admin/roles', { method: 'POST', cookie: sessionCookie, csrf: session.body.csrfToken,
      body: { key: 'qa_observer', name: 'Observação QA', permissions: [] } });
    assert.equal(observerRole.status, 201);
    const memberBeforeEdit = (await call('/api/admin/memberships?limit=100', { cookie: sessionCookie })).body.members
      .find(member => member.userId === invitationAccepted.body.userId);
    assert(memberBeforeEdit);
    const roleChanged = await call(`/api/admin/memberships/${memberBeforeEdit.membershipId}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { roleId: observerRole.body.id } });
    assert.equal(roleChanged.status, 200, 'authorized owner can change another member to a permitted company profile');
    assert.equal(roleChanged.body.roleId, observerRole.body.id);
    assert.equal((await call('/api/identity/session', { cookie: invitedCookie })).status, 401,
      'a role change revokes the member’s existing session');
    const memberAfterEdit = (await call('/api/admin/memberships?limit=100', { cookie: sessionCookie })).body.members
      .find(member => member.membershipId === memberBeforeEdit.membershipId);
    assert.equal(memberAfterEdit.roleId, observerRole.body.id, 'membership role change persists in the canonical admin read');
    const suspended = await call(`/api/admin/memberships/${memberBeforeEdit.membershipId}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { status: 'suspended' } });
    assert.equal(suspended.status, 200);
    assert.equal((await call('/api/identity/login', { method: 'POST', body: { email: invitedEmail, password: invitedPassword, companyId } })).status, 401,
      'a suspended membership cannot establish a new session');
    const reactivated = await call(`/api/admin/memberships/${memberBeforeEdit.membershipId}`, { method: 'PATCH', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { status: 'active' } });
    assert.equal(reactivated.status, 200, 'authorized owner can reactivate a suspended, verified membership');
    assert.equal((await call('/api/admin/memberships?limit=100', { cookie: sessionCookie })).body.members
      .find(member => member.membershipId === memberBeforeEdit.membershipId).status, 'active', 'membership status persists after readback');
    const duplicateActiveInvite = await call('/api/admin/invitations', { method: 'POST', cookie: sessionCookie,
      csrf: session.body.csrfToken, body: { email: invitedEmail, roleId: createdRole.body.id } });
    assert.equal(duplicateActiveInvite.status, 409, 'a second active membership is not created for the same tenant and identity');
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
    const adminEnrollment = await noProvider.authenticate(adminEmail, adminPassword, companyId);
    assert.equal(adminEnrollment.mfaEnrollmentRequired, true,
      'administrative identity without an enrolled secret receives only an enrollment-limited session');
    const missingManagerRef=`local-v1:${crypto.randomUUID()}`;
    await client.query('UPDATE rotamoto.credentials SET mfa_secret_ref=$2 WHERE user_id=$1', [adminAccepted.body.userId,missingManagerRef]);
    const missingSecretService=createIdentityService({pool,emailProvider:provider,
      mfaProvider:createNativeMfaProvider({secretProvider:await secretProvider}),secretProvider});
    const missingSecretLogs=[];
    const missingSecretHost=await listen(createIdentityHttpHandler({identityService:missingSecretService,logger:event=>missingSecretLogs.push(event)}));
    try {
      const beforeMissingFileLogin=await client.query('SELECT count(*)::int AS count FROM rotamoto.sessions WHERE user_id=$1 AND revoked_at IS NULL',[adminAccepted.body.userId]);
      const missingFileLogin=await fetch(`${missingSecretHost.base}/api/identity/login`,{method:'POST',headers:{Origin:missingSecretHost.base,'Content-Type':'application/json'},
        body:JSON.stringify({email:adminEmail,password:adminPassword,companyId,mfaCode:'654321'})});
      const missingFileBody=await missingFileLogin.json();
      assert.equal(missingFileLogin.status,503,'an enrolled factor with a missing keystore file fails closed through HTTP');
      assert.equal(missingFileBody.error.code,'MFA_PROVIDER_UNAVAILABLE');
      assert.equal(missingFileLogin.headers.get('set-cookie'),null,'missing MFA material never creates an authenticated session');
      const afterMissingFileLogin=await client.query('SELECT count(*)::int AS count FROM rotamoto.sessions WHERE user_id=$1 AND revoked_at IS NULL',[adminAccepted.body.userId]);
      assert.equal(afterMissingFileLogin.rows[0].count,beforeMissingFileLogin.rows[0].count,'failed keystore lookup creates no session');
      assert.equal(JSON.stringify(missingSecretLogs).includes(adminPassword),false,'missing factor diagnostics do not log passwords');
      assert.equal(JSON.stringify(missingSecretLogs).includes(missingManagerRef),false,'missing factor diagnostics do not log secret references');
    } finally { await missingSecretHost.close(); }
    await assert.rejects(noProvider.authenticate(adminEmail, adminPassword, companyId, '654321'), error => error.code === 'MFA_REQUIRED',
      'administrative login with an enrolled secret fails closed when the MFA provider is unavailable');
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
    assert.equal((await call('/api/admin/roles',{cookie:idleCookie})).status,401,'expired sessions cannot read protected API data');

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

    const recoveredPassword='synthetic-recovered-password-43';
    const mfaRequest=await call('/api/identity/mfa/recovery/request',{method:'POST',body:{email,password:recoveredPassword,companyId}});
    assert.equal(mfaRequest.status,202);assert.deepEqual(mfaRequest.body,{accepted:true},'MFA recovery request has a generic response');
    const mfaChallenge=delivered.at(-1);assert.equal(mfaChallenge.kind,'mfa_recovery');
    assert.equal(JSON.stringify(mfaRequest.body).includes(mfaChallenge.token),false,'email challenge token is never returned');
    const mfaConfirmation=await call('/api/identity/mfa/recovery/confirm',{method:'POST',body:{token:mfaChallenge.token}});
    assert.equal(mfaConfirmation.status,202);assert.equal(mfaConfirmation.body.accepted,true);
    assert.equal((await call('/api/identity/mfa/recovery/confirm',{method:'POST',body:{token:mfaChallenge.token}})).status,401,
      'email proof is single-use');
    const reauthenticated=await call('/api/identity/login',{method:'POST',body:{email,password:recoveredPassword,companyId,mfaCode:'654321'}});
    assert.equal(reauthenticated.status,200);
    const recoveryCookie=reauthenticated.headers.get('set-cookie').split(';',1)[0];
    const recoverySession=await call('/api/identity/session',{cookie:recoveryCookie});
    const pendingMfa=await call('/api/admin/mfa-recovery',{cookie:adminCookie});
    assert.equal(pendingMfa.status,200);assert.equal(pendingMfa.body.requests.length,1);
    const selfApproval=await call(`/api/admin/mfa-recovery/${pendingMfa.body.requests[0].id}/approve`,
      {method:'POST',body:{},cookie:recoveryCookie,csrf:recoverySession.body.csrfToken});
    assert.equal(selfApproval.status,403,'the requester cannot approve their own MFA recovery');
    const localOperatorService=createIdentityService({pool,secretProvider:{async remove(){},async get(){throw new Error('unused')}},
      authorizeMfaRecoveryOperator:async()=>({actorRef:'test:synthetic-local-operator'})});
    await assert.rejects(localOperatorService.approveSoleOwnerMfaRecoveryLocally(pendingMfa.body.requests[0].id),
      error=>error.code==='CONFLICT','local sole-owner recovery is denied when a second administrator is active');
    const independentApproval=await call(`/api/admin/mfa-recovery/${pendingMfa.body.requests[0].id}/approve`,
      {method:'POST',body:{},cookie:adminCookie,csrf:adminSession.body.csrfToken});
    assert.equal(independentApproval.status,200,'a different MFA-verified administrator can approve the request');
    assert.deepEqual(independentApproval.body,{completed:true,reenrollmentRequired:true});
    assert.equal((await call('/api/identity/session',{cookie:recoveryCookie})).status,401,'MFA recovery revokes every existing session');
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
    const recoveredFactor=await client.query('SELECT mfa_required,mfa_secret_ref,mfa_totp_last_counter FROM rotamoto.credentials WHERE user_id=$1',[accepted.body.userId]);
    assert.equal(recoveredFactor.rows[0].mfa_required,true);assert.equal(recoveredFactor.rows[0].mfa_secret_ref,null);
    assert.equal(recoveredFactor.rows[0].mfa_totp_last_counter,null,'the next login is limited to mandatory MFA re-enrollment');

    const postRecoveryLogin=await call('/api/identity/login',{method:'POST',body:{email,password:recoveredPassword,companyId}});
    assert.equal(postRecoveryLogin.status,200);assert.equal(postRecoveryLogin.body.mfaEnrollmentRequired,true,
      'a recovered identity can only enter the mandatory MFA enrollment flow');
    const postRecoveryCookie=postRecoveryLogin.headers.get('set-cookie').split(';',1)[0];
    const nativeSecrets=await secretProvider;
    const nativeRecoveryService=createIdentityService({pool,emailProvider:provider,
      mfaProvider:createNativeMfaProvider({secretProvider:nativeSecrets}),secretProvider});
    const nativeRecoveryHost=await listen(createIdentityHttpHandler({identityService:nativeRecoveryService}));
    const nativeRecoveryCall=async(path,{method='GET',body,cookie,csrf,origin=nativeRecoveryHost.base}={})=>{
      const headers={Origin:origin};if(body!==undefined)headers['Content-Type']='application/json';if(cookie)headers.Cookie=cookie;if(csrf)headers['X-CSRF-Token']=csrf;
      const response=await fetch(`${nativeRecoveryHost.base}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      const text=await response.text();return{status:response.status,headers:response.headers,body:text?JSON.parse(text):null};
    };
    try {
      const postRecoverySession=await nativeRecoveryCall('/api/identity/session',{cookie:postRecoveryCookie});
      assert.equal(postRecoverySession.status,200);assert.equal(postRecoverySession.body.mfaEnrollmentRequired,true);
      const newEnrollment=await nativeRecoveryCall('/api/identity/mfa/enrollment',{method:'POST',body:{},cookie:postRecoveryCookie,csrf:postRecoveryLogin.body.csrfToken});
      assert.equal(newEnrollment.status,200);
      const newTotp=codeAt(newEnrollment.body.secret,Math.floor(Date.now()/30000));
      const newEnrollmentConfirmed=await nativeRecoveryCall('/api/identity/mfa/enrollment/confirm',{method:'POST',body:{code:newTotp},cookie:postRecoveryCookie,csrf:postRecoveryLogin.body.csrfToken});
      assert.equal(newEnrollmentConfirmed.status,200);assert.equal(newEnrollmentConfirmed.body.recoveryCodes.length,10);
      const replacementLoginCode=codeAt(newEnrollment.body.secret,Math.floor(Date.now()/30000)+1);
      const postRecoveryAuthenticated=await nativeRecoveryCall('/api/identity/login',{method:'POST',body:{email,password:recoveredPassword,companyId,mfaCode:replacementLoginCode}});
      assert.equal(postRecoveryAuthenticated.status,200,'a newly enrolled TOTP factor authenticates through the native verifier');
      const postRecoveryAuthenticatedCookie=postRecoveryAuthenticated.headers.get('set-cookie').split(';',1)[0];
      const verifiedRecoverySession=await nativeRecoveryCall('/api/identity/session',{cookie:postRecoveryAuthenticatedCookie});
      assert.equal(verifiedRecoverySession.status,200);assert.equal(verifiedRecoverySession.body.mfaVerified,true);
      const oneTimeRecoveryCode=newEnrollmentConfirmed.body.recoveryCodes[0];
      const replacementStart=await nativeRecoveryCall('/api/identity/mfa/enrollment',{method:'POST',
        body:{currentPassword:recoveredPassword,currentMfaCode:oneTimeRecoveryCode},cookie:postRecoveryAuthenticatedCookie,csrf:verifiedRecoverySession.body.csrfToken});
      assert.equal(replacementStart.status,200,'a one-time recovery code can authorize replacement of a lost TOTP factor');
      const reusedRecoveryCode=await nativeRecoveryCall('/api/identity/mfa/enrollment',{method:'POST',
        body:{currentPassword:recoveredPassword,currentMfaCode:oneTimeRecoveryCode},cookie:postRecoveryAuthenticatedCookie,csrf:verifiedRecoverySession.body.csrfToken});
      assert.equal(reusedRecoveryCode.status,403);assert.equal(reusedRecoveryCode.body.error.code,'MFA_REQUIRED',
        'a recovery code consumed for replacement cannot be replayed');
      const replacementTotp=codeAt(replacementStart.body.secret,Math.floor(Date.now()/30000));
      const replacementConfirmed=await nativeRecoveryCall('/api/identity/mfa/enrollment/confirm',{method:'POST',body:{code:replacementTotp},
        cookie:postRecoveryAuthenticatedCookie,csrf:verifiedRecoverySession.body.csrfToken});
      assert.equal(replacementConfirmed.status,200,'the replacement factor is confirmed only after valid TOTP proof');
      const finalLoginCode=codeAt(replacementStart.body.secret,Math.floor(Date.now()/30000)+1);
      const finalLogin=await nativeRecoveryCall('/api/identity/login',{method:'POST',body:{email,password:recoveredPassword,companyId,mfaCode:finalLoginCode}});
      assert.equal(finalLogin.status,200,'the replacement authenticator works for a fresh login');
      const finalSession=await nativeRecoveryCall('/api/identity/session',{cookie:finalLogin.headers.get('set-cookie').split(';',1)[0]});
      assert.equal(finalSession.body.mfaVerified,true);
    } finally { await nativeRecoveryHost.close(); syntheticSecrets.clear(); }

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

    const bootstrapState = await readFounderBootstrapState(clients.migrator, clients.database);
    const bootstrapToken = crypto.randomBytes(32).toString('base64url');
    const bootstrapDigest = crypto.createHash('sha256').update(bootstrapToken).digest();
    assert.equal(bootstrapState.active_admins === 0, bootstrapState.founder_user_id === null,
      'active global administration and the founder latch must agree before bootstrap testing');
    if (bootstrapState.founder_user_id !== null) {
      assert.equal(bootstrapState.active_admins, 1, 'the persistent E2E founder is the only active global administrator');
      assert.equal(bootstrapState.active_grant_matches_founder, true, 'the active global grant belongs to the latched founder');
    }
    if (bootstrapState.founder_user_id === null && bootstrapState.admin_history > 0) {
      throw new Error('E2E founder history exists without a claimed founder; preserve state and investigate before testing bootstrap.');
    }
    if (bootstrapState.founder_user_id === null && bootstrapState.installation_complete) {
      throw new Error('E2E installation latch is already complete without a provable founder; preserve state and investigate before testing bootstrap.');
    }
    await client.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
      VALUES($1,'rotamoto',now()+interval '10 minutes')`, [bootstrapDigest]);
    const bootstrapProvider = createEmailDeliveryProvider(async message => { delivered.push(message); return { accepted: true }; });
    const bootstrapService = createIdentityService({ pool, emailProvider: bootstrapProvider, requireBootstrapAuthorization: true,
      authorizeProvisioner: async ({ context }) => {
        if (String(context?.request?.socket?.remoteAddress || '').replace(/^::ffff:/u, '') !== '127.0.0.1' ||
            context?.request?.headers['x-bootstrap-capability'] !== bootstrapToken) throw new Error('unauthorized');
        return { actorRef: 'test:local-bootstrap', bootstrapCapabilityDigest: crypto.createHash('sha256').update(bootstrapToken).digest() };
      } });
    const bootstrapHost = await listen(createIdentityHttpHandler({ identityService: bootstrapService }));
    const bootstrapCall = async (authorization, body) => {
      const response = await fetch(`${bootstrapHost.base}/api/admin/tenants/provision`, { method: 'POST', headers: {
        Origin: bootstrapHost.base, 'Content-Type': 'application/json', ...(authorization ? { 'X-Bootstrap-Capability': authorization } : {})
      }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    try {
      const browserBootstrapSchema = await client.query(`SELECT
        to_regprocedure('rotamoto.platform_admin_bootstrap_status()') IS NOT NULL AND
        to_regclass('rotamoto.company_delivery_pricing') IS NOT NULL AND
        EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('rotamoto.provisioning_requests')
          AND attname='bootstrap_capability_digest' AND NOT attisdropped) AS ready`);
      const browserBootstrapReady = browserBootstrapSchema.rows[0]?.ready === true;
      const initialStatus = await fetch(`${bootstrapHost.base}/api/identity/bootstrap/status`, { cache: 'no-store' });
      const initialStatusBody = await initialStatus.json();
      if (!browserBootstrapReady) assert.equal(initialStatusBody.state, 'not_ready', 'old persistent schema fails closed until the browser bootstrap migration is applied');
      else if (bootstrapState.founder_user_id === null) assert.equal(initialStatusBody.state, 'ready');
      else assert.equal(initialStatusBody.state, 'complete');
      const firstBootstrapRequest = { companyName: 'Empresa Bootstrap Sintética', email: `bootstrap-${crypto.randomUUID()}@example.invalid`,
        idempotencyKey: `bootstrap-${crypto.randomUUID()}` };
      assert.equal((await bootstrapCall(null, firstBootstrapRequest)).status, 403, 'bootstrap has no unauthenticated public path');
      if (!browserBootstrapReady) {
        assert.equal(initialStatusBody.state, 'not_ready');
      } else {
        const initialized = await bootstrapCall(bootstrapToken, firstBootstrapRequest);
        if (bootstrapState.founder_user_id !== null) {
          assert.equal(initialized.status, 403, 'a persistent founder latch rejects a new bootstrap without being reset');
          assert.equal(initialized.body?.error?.code, 'PROVISIONER_UNAUTHORIZED');
        } else {
          assert.equal(initialized.status, 202, 'only an actually empty installation accepts its first authorized bootstrap');
          assert.equal(initialized.body.setupState, 'awaiting_owner_activation_and_mfa');
          assert.equal((await bootstrapCall(bootstrapToken, firstBootstrapRequest)).body.replayed, true,
            'same idempotency key can safely recover delivery after single-use authorization');
          const pendingState = await fetch(`${bootstrapHost.base}/api/identity/bootstrap/status`, { cache: 'no-store' });
          assert.equal((await pendingState.json()).state, 'pending_owner_activation',
            'provisioning remains pending, with no founder grant, before owner activation and mandatory MFA');
          const secondToken = crypto.randomBytes(32).toString('base64url');
          await client.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
            VALUES($1,'rotamoto',now()+interval '10 minutes')`, [crypto.createHash('sha256').update(secondToken).digest()]);
          const secondBootstrap = await bootstrapCall(secondToken, { ...firstBootstrapRequest,
            email: `second-${crypto.randomUUID()}@example.invalid`, idempotencyKey: `bootstrap-${crypto.randomUUID()}` });
          assert.equal(secondBootstrap.status, 403, 'installation latch prevents a second initial owner');
        }
      }
    } finally {
      await bootstrapHost.close();
      bootstrapDigest.fill(0);
      if (bootstrapState.founder_user_id !== null) {
        const after = await readFounderBootstrapState(clients.migrator, clients.database);
        assert.equal(after.founder_user_id === bootstrapState.founder_user_id &&
          after.active_admins === bootstrapState.active_admins && after.admin_history === bootstrapState.admin_history &&
          after.active_grant_matches_founder === bootstrapState.active_grant_matches_founder &&
          after.installation_complete === bootstrapState.installation_complete, true,
        'failed bootstrap attempt leaves persistent founder, grant count and latches unchanged');
      }
    }

    console.log(`identity HTTP API, session, CSRF, tenant/RLS, MFA recovery, permission, invite, rate and error tests: PASS; first-install bootstrap/idempotency branch: ${bootstrapState.founder_user_id === null ? 'PASS' : 'NOT EXECUTED (persistent founder preserved)'}`);
  } finally {
    await host.close();
    await client.query('ROLLBACK').catch(() => {});
    const remaining = await client.query('SELECT count(*)::int AS count FROM rotamoto.users WHERE email=$1', [email]).catch(error => {
      if (error.code === '42501') return { rows: [{ count: null }], rlsProtected: true };
      throw error;
    });
    await client.end();
    await clients.migrator.end().catch(() => {});
    if (remaining.rlsProtected) {
      assert.equal(remaining.rows[0].count, null, 'global cleanup read remains blocked by FORCE RLS; the enclosing SQL transaction rollback is the cleanup guarantee');
    } else {
      assert.equal(remaining.rows[0].count, 0, 'all synthetic users, tenants and audit rows were rolled back');
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
