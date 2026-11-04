'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createIdentityService } = require('../backend/identity/service');
const { createIdentityHttpHandler, createRateLimiter } = require('../backend/identity/http');
const { hashPassword } = require('../backend/identity/passwords');
const { createE2eClients, assertConnectedIdentity } = require('./e2e-support/guards');

function savepointPool(client) {
  let sequence = 0; const stack = [];
  return { async connect() { return { async query(sql, values) {
    const command = sql.trim().toUpperCase();
    if (command === 'BEGIN') { const name = `login_context_${++sequence}`; stack.push(name); return client.query(`SAVEPOINT ${name}`); }
    if (command === 'COMMIT') { const name = stack.pop(); if (!name) throw new Error('unexpected savepoint commit'); return client.query(`RELEASE SAVEPOINT ${name}`); }
    if (command === 'ROLLBACK') { const name = stack.pop(); if (!name) throw new Error('unexpected savepoint rollback'); await client.query(`ROLLBACK TO SAVEPOINT ${name}`); return client.query(`RELEASE SAVEPOINT ${name}`); }
    return client.query(sql, values);
  }, release() {} }; } };
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.ROTAMOTO_DISPOSABLE_CAMPAIGN, '0304B');
  const clients = createE2eClients(process.env), runtime = clients.runtime;
  await runtime.connect(); await clients.migrator.connect();
  await assertConnectedIdentity(runtime, { database: clients.database, role: 'rotamoto_app', env: process.env });
  await assertConnectedIdentity(clients.migrator, { database: clients.database, role: 'rotamoto_migrator', env: process.env });
  const tenantA = crypto.randomUUID(), tenantB = crypto.randomUUID(), tenantC = crypto.randomUUID();
  const roleA = crypto.randomUUID(), roleB = crypto.randomUUID(), roleC = crypto.randomUUID();
  const linkedUser = crypto.randomUUID(), singleUser = crypto.randomUUID(), outsiderUser = crypto.randomUUID();
  const linkedEmail = `shared-${crypto.randomUUID()}@example.invalid`;
  const singleEmail = `single-${crypto.randomUUID()}@example.invalid`;
  const outsiderEmail = `outsider-${crypto.randomUUID()}@example.invalid`;
  const password = 'synthetic-login-context-password-902';
  const passwordPhc = await hashPassword(password);
  await runtime.query('BEGIN');
  let host = null;
  try {
    await runtime.query(`INSERT INTO rotamoto.users(id,email,email_verified_at) VALUES
      ($1,$2,now()),($3,$4,now()),($5,$6,now())`, [linkedUser, linkedEmail, singleUser, singleEmail, outsiderUser, outsiderEmail]);
    await runtime.query(`INSERT INTO rotamoto.credentials(user_id,password_phc,mfa_required) VALUES
      ($1,$2,false),($3,$2,false),($4,$2,false)`, [linkedUser, passwordPhc, singleUser, outsiderUser]);
    for (const [companyId, roleId, userId] of [[tenantA, roleA, linkedUser], [tenantB, roleB, linkedUser], [tenantC, roleC, outsiderUser]]) {
      await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
      await runtime.query(`INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Mercado Vila','active')`, [companyId]);
      await runtime.query(`INSERT INTO rotamoto.roles(id,company_id,role_key,display_name,is_system_template)
        VALUES($1,$2,'qa_login_viewer','Leitura de teste',false)`, [roleId, companyId]);
      await runtime.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
        VALUES($1,$2,'orders.read',1)`, [companyId, roleId]);
      await runtime.query(`INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at)
        VALUES($1,$2,$3,$4,'active',now())`, [crypto.randomUUID(), companyId, userId, roleId]);
    }
    await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
    await runtime.query(`INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at)
      VALUES($1,$2,$3,$4,'active',now())`, [crypto.randomUUID(), tenantA, singleUser, roleA]);
    await runtime.query("SELECT set_config('app.tenant_id','',true)");
    assert.equal((await runtime.query('SELECT 1 FROM rotamoto.memberships WHERE user_id=$1', [linkedUser])).rowCount, 0,
      'RLS hides memberships before the password-verified identity context is set');
    assert.equal((await runtime.query('SELECT * FROM rotamoto.identity_login_company_options($1)', [linkedUser])).rowCount, 0,
      'login option function fails closed without the matching internal identity context');

    const service = createIdentityService({ pool: savepointPool(runtime), mfaProvider: { async verify() { return false; } } });
    const handler = createIdentityHttpHandler({ identityService: service, logger: () => {}, rateLimiter: createRateLimiter({ policies: {
      login: { limit: 30, windowMs: 60000 }, default: { limit: 60, windowMs: 60000 }
    } }) });
    host = await listen(handler);
    const call = async (path, { method = 'GET', body, cookie, csrf } = {}) => {
      const response = await fetch(`${host.base}${path}`, { method, headers: {
        Origin: host.base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {})
      }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text(); return { response, body: text ? JSON.parse(text) : null };
    };

    const badPassword = await call('/api/identity/login', { method: 'POST', body: { email: linkedEmail, password: 'wrong synthetic password' } });
    assert.equal(badPassword.response.status, 401);
    assert.deepEqual(badPassword.body.error, { code: 'INVALID_CREDENTIALS', message: 'Email ou senha inválidos.' });
    assert.equal(Object.hasOwn(badPassword.body, 'companies'), false);
    const unknownEmail = await call('/api/identity/login', { method: 'POST', body: { email: `missing-${crypto.randomUUID()}@example.invalid`, password } });
    assert.equal(unknownEmail.response.status, 401);
    assert.deepEqual(unknownEmail.body.error, badPassword.body.error, 'email-only lookups do not enumerate users or companies');
    assert.equal(Object.hasOwn(unknownEmail.body, 'companies'), false);

    const multi = await call('/api/identity/login', { method: 'POST', body: { email: linkedEmail, password } });
    assert.equal(multi.response.status, 200);
    assert.deepEqual(multi.body.companies.map(item => item.name), ['Mercado Vila', 'Mercado Vila']);
    assert.deepEqual(new Set(multi.body.companies.map(item => item.companyId)), new Set([tenantA, tenantB]),
      'shared email returns exactly the linked active memberships');
    assert.equal(multi.body.companyId, multi.body.companies[0].companyId,
      'server resolves a valid initial membership without trusting a browser tenant hint');
    const multiCookie = multi.response.headers.get('set-cookie').split(';', 1)[0];
    const otherTenant = multi.body.companies.find(item => item.companyId !== multi.body.companyId).companyId;
    const switchResult = await call('/api/identity/tenant', { method: 'POST', cookie: multiCookie, csrf: multi.body.csrfToken,
      body: { companyId: otherTenant } });
    assert.equal(switchResult.response.status, 200, 'tenant switch accepts only a server-verified active membership');
    const switchedSession = await call('/api/identity/session', { cookie: multiCookie });
    assert.equal(switchedSession.body.activeCompanyId, otherTenant, 'session context follows the authenticated server-side switch');
    const foreignChoice = await call('/api/identity/tenant', { method: 'POST', cookie: multiCookie, csrf: multi.body.csrfToken,
      body: { companyId: tenantC } });
    assert.equal(foreignChoice.response.status, 403, 'an unrelated tenant id cannot select another company');
    const logout = await call('/api/identity/logout', { method: 'POST', cookie: multiCookie, csrf: multi.body.csrfToken, body: {} });
    assert.equal(logout.response.status, 204);
    const expiredSession = await call('/api/identity/session', { cookie: multiCookie });
    assert.equal(expiredSession.response.status, 401, 'logout invalidates the old context');

    const single = await call('/api/identity/login', { method: 'POST', body: { email: singleEmail, password } });
    assert.equal(single.response.status, 200);
    assert.equal(single.body.companyId, tenantA);
    assert.deepEqual(single.body.companies, [{ companyId: tenantA, name: 'Mercado Vila' }],
      'one authorized company is selected automatically');
    assert.equal(Object.hasOwn(single.body, 'platformAdmin'), true);
    assert.equal(single.body.platformAdmin, false);
    process.stdout.write('Identity login context E2E: password-only lookup, non-enumeration, shared-email multi-tenant choices, single-tenant auto-selection, tenant switch and logout invalidation PASS (transaction rolled back)\n');
  } finally {
    if (host) await host.close();
    await runtime.query('ROLLBACK').catch(() => {});
    await runtime.end(); await clients.migrator.end();
  }
}

main().catch(error => { process.stderr.write(`Identity login context E2E failed: ${error.code || error.name}${process.env.DEBUG_LOGIN_CONTEXT === '1' ? `\n${error.stack}` : ''}\n`); process.exitCode = 1; });
