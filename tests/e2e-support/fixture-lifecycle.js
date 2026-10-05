'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createE2eClients, assertConnectedIdentity } = require('./guards');
const { createIdentityService } = require('../../backend/identity/service');
const { createEmailDeliveryProvider } = require('../../backend/identity/email-provider');
const { createMfaProvider } = require('../../backend/identity/mfa-provider');
const { createIdentityHttpHandler, createRateLimiter } = require('../../backend/identity/http');
const { createAdminHttpHandler } = require('../../backend/admin/http');
const { createAdminRepository } = require('../../backend/admin/repository');
const { createAdminService } = require('../../backend/admin/service');
const { createSyncHttpHandler } = require('../../backend/domain/sync-http');
const { createSyncService } = require('../../backend/domain/sync-service');
const { createDomainQueryHttpHandler } = require('../../backend/domain/query-http');
const { createDomainQueryRepository } = require('../../backend/domain/query-repository');
const { createDomainQueryService } = require('../../backend/domain/query-service');
const { COOKIE_NAME } = require('../../backend/identity/http');

function savepointPool(client) {
  let sequence = 0;
  const stack = [];
  return { async connect() {
    return { async query(sql, values) {
      const command = sql.trim().toUpperCase();
      if (command === 'BEGIN') { const name = `fixture_${++sequence}`; stack.push(name); return client.query(`SAVEPOINT ${name}`); }
      if (command === 'COMMIT' || command === 'ROLLBACK') {
        const name = stack.pop();
        if (!name) throw new Error('Unexpected transaction boundary in fixture harness.');
        if (command === 'ROLLBACK') await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        return client.query(`RELEASE SAVEPOINT ${name}`);
      }
      return client.query(sql, values);
    }, release() {} };
  } };
}

function rateLimiter() {
  return createRateLimiter({ policies: { login: { limit: 50, windowMs: 60000 }, recovery: { limit: 50, windowMs: 60000 },
    invitation: { limit: 50, windowMs: 60000 }, provision: { limit: 50, windowMs: 60000 }, default: { limit: 1000, windowMs: 60000 } } });
}

async function start(handler) {
  // Browser requests can arrive concurrently while sharing the lifecycle's
  // single PostgreSQL connection. Serialize them so savepoints never overlap.
  let pending = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    req.clientIp = '127.0.0.1';
    req.requestId = crypto.randomUUID();
    const task = pending.then(async () => {
      for (const route of handler) if (await route(req, res)) return;
      if (!res.writableEnded) res.writeHead(404).end();
    });
    pending = task.catch(() => {});
    task.catch(error => {
      if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
      if (!res.writableEnded) res.end();
      // Keep the queue usable while surfacing the failure in the request log.
      console.error(`E2E fixture request ${req.requestId} failed: ${error.message}`);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function runFixtureLifecycle({ env = process.env, exercise = async () => {}, allowedOrigins = [] } = {}) {
  const clients = createE2eClients(env); // Validate both exact targets before a socket/client is opened.
  const { runtime, migrator } = clients;
  let connectedRuntime = false;
  let transactionOpen = false;
  let host;
  let companyId;
  let fixtureUserId;
  let fixtureEmail;
  try {
    await runtime.connect(); connectedRuntime = true;
    await assertConnectedIdentity(runtime, { role: 'rotamoto_app' });
    await runtime.query('BEGIN'); transactionOpen = true;
    const pool = savepointPool(runtime);
    const emails = [];
    const operatorMarker = crypto.randomBytes(32).toString('base64url');
    const mfaCode = String(crypto.randomInt(100000, 1000000));
    const password = `E2E-${crypto.randomBytes(30).toString('base64url')}`;
    const identityService = createIdentityService({ pool,
      authorizeProvisioner: async ({ context }) => {
        if (context?.request?.headers['x-e2e-operator'] !== operatorMarker) throw new Error('unauthorized');
        return { actorRef: 'test:e2e-fixture-operator' };
      },
      emailProvider: createEmailDeliveryProvider(async message => { emails.push(message); return { accepted: true }; }),
      mfaProvider: createMfaProvider(async ({ code }) => code === mfaCode) });
    const limiter = rateLimiter();
    const originConfig = allowedOrigins.length ? allowedOrigins : undefined;
    const identityHttp = createIdentityHttpHandler({ identityService, logger: () => {}, rateLimiter: limiter,
      allowedOrigin: originConfig });
    const adminHttp = createAdminHttpHandler({ identityService, adminService: createAdminService({ repository: createAdminRepository() }),
      logger: () => {}, rateLimiter: limiter, allowedOrigin: originConfig });
    const syncHttp = createSyncHttpHandler({ identityService, syncService: createSyncService(), logger: () => {}, rateLimiter: limiter,
      allowedOrigin: originConfig });
    const queryHttp = createDomainQueryHttpHandler({ identityService,
      queryService: createDomainQueryService({ repository: createDomainQueryRepository() }), logger: () => {}, rateLimiter: limiter });
    host = await start([identityHttp, adminHttp, syncHttp, queryHttp]);

    const call = async (path, { method = 'GET', body, cookie, csrf, headers = {} } = {}) => {
      const response = await fetch(`${host.base}${path}`, { method, headers: { Origin: allowedOrigins[0] || host.base,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    };
    const email = fixtureEmail = `e2e-${crypto.randomUUID()}@example.invalid`;
    const provisionInput = { companyName: 'E2E Fixture Tenant', email, idempotencyKey: `e2e-${crypto.randomUUID()}` };
    const denied = await call('/api/admin/tenants/provision', { method: 'POST', body: provisionInput });
    assert.equal(denied.status, 403, 'fixture operator provider rejects missing marker');
    const provisioned = await call('/api/admin/tenants/provision', { method: 'POST', body: provisionInput,
      headers: { 'X-E2E-Operator': operatorMarker } });
    assert.equal(provisioned.status, 202, JSON.stringify(provisioned.body));
    companyId = provisioned.body.companyId;
    assert.equal(emails.length, 1);
    assert.equal(emails[0].kind, 'owner_invitation');
    assert.equal(JSON.stringify(provisioned.body).includes(emails[0].token), false);

    const accepted = await call('/api/identity/invitations/accept', { method: 'POST', body: { token: emails[0].token, password } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    fixtureUserId = accepted.body.userId;
    const invalidMfa = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId,
      mfaCode: String((Number(mfaCode) + 1) % 1000000).padStart(6, '0') } });
    assert.equal(invalidMfa.status, 403, 'invalid test MFA proof cannot create an authenticated fixture');
    const login = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, mfaCode } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const sessionCookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert(sessionCookie.startsWith(`${COOKIE_NAME}=`));
    const session = await call('/api/identity/session', { cookie: sessionCookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.mfaVerified, true);
    const csrf = session.body.csrfToken;
    const membershipList = await call('/api/admin/memberships?limit=100', { cookie: sessionCookie });
    assert.equal(membershipList.status, 200);
    const membership = membershipList.body.members.find(row => row.userId === accepted.body.userId);
    assert(membership, 'provisioning service created owner membership');

    const restaurantDevice = `restaurant-${crypto.randomUUID()}`;
    const noCsrfRegistration = await call('/api/sync/installations/restaurante', { method: 'POST', cookie: sessionCookie,
      body: { deviceId: `denied-${crypto.randomUUID()}` } });
    assert.equal(noCsrfRegistration.status, 403, 'fixture lifecycle cannot bypass CSRF');
    const restaurantRegistration = await call('/api/sync/installations/restaurante', { method: 'POST', cookie: sessionCookie, csrf,
      body: { deviceId: restaurantDevice } });
    assert.equal(restaurantRegistration.status, 200, JSON.stringify(restaurantRegistration.body));
    const now = new Date().toISOString();
    const driverLocalId = `driver-${crypto.randomUUID()}`;
    const driverPush = await call('/api/sync/push', { method: 'POST', cookie: sessionCookie, csrf, body: {
      protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId: `pkt_${crypto.randomUUID()}`,
      deviceId: restaurantDevice, source: { deviceId: restaurantDevice }, createdAt: now,
      data: { drivers: [{ id: driverLocalId, name: 'Motorista E2E', status: 'active', createdAt: now, updatedAt: now, version: 1 }] }
    } });
    assert.equal(driverPush.status, 200, JSON.stringify(driverPush.body));
    assert.equal(driverPush.body.operationResults[0].status, 'accepted', JSON.stringify(driverPush.body.operationResults));
    const driverId = driverPush.body.aliases.find(row => row.entity === 'Driver').canonicalId;
    const binding = await call(`/api/admin/memberships/${membership.membershipId}/driver`, { method: 'PUT', cookie: sessionCookie,
      csrf, body: { driverId } });
    assert.equal(binding.status, 200, JSON.stringify(binding.body));
    const motoboyDevice = `motoboy-${crypto.randomUUID()}`;
    const motoboyRegistration = await call('/api/sync/installations/motoboy', { method: 'POST', cookie: sessionCookie, csrf,
      body: { deviceId: motoboyDevice } });
    assert.equal(motoboyRegistration.status, 200, JSON.stringify(motoboyRegistration.body));

    const orderLocalId = `order-${crypto.randomUUID()}`;
    const deliveryLocalId = `delivery-${crypto.randomUUID()}`;
    const orderDelivery = await call('/api/sync/push', { method: 'POST', cookie: sessionCookie, csrf, body: {
      protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId: `pkt_${crypto.randomUUID()}`,
      deviceId: restaurantDevice, source: { deviceId: restaurantDevice }, createdAt: now,
      data: { orders: [{ id: orderLocalId, customer: 'Cliente E2E', status: 'CREATED', createdAt: now, updatedAt: now, version: 1 }],
        deliveries: [{ id: deliveryLocalId, orderId: orderLocalId, driverId, status: 'ASSIGNED', createdAt: now, updatedAt: now, version: 1 }] }
    } });
    assert.equal(orderDelivery.status, 200, JSON.stringify(orderDelivery.body));
    assert(orderDelivery.body.operationResults.every(result => result.status === 'accepted'), JSON.stringify(orderDelivery.body.operationResults));
    const orderId = orderDelivery.body.aliases.find(row => row.entity === 'Order').canonicalId;
    const deliveryId = orderDelivery.body.aliases.find(row => row.entity === 'Delivery').canonicalId;
    const delivery = await call(`/api/domain/deliveries/${deliveryId}`, { cookie: sessionCookie });
    assert.equal(delivery.status, 200, JSON.stringify(delivery.body));
    assert.equal(delivery.body.record.orderId, orderId);

    const authenticatedCall = (path, options = {}) => call(path, { ...options,
      cookie: options.cookie || sessionCookie, csrf: options.csrf === undefined ? csrf : options.csrf });
    await exercise(Object.freeze({ companyId, userId: accepted.body.userId, membershipId: membership.membershipId,
      driverId, orderId, deliveryId, email, password, mfaCode, apiOrigin: host.base, runtime, call, authenticatedCall }));
    return Object.freeze({ companyId, userId: accepted.body.userId, membershipId: membership.membershipId,
      driverId, orderId, deliveryId, authenticated: true, mfaVerified: true });
  } finally {
    if (host) await new Promise(resolve => host.server.close(resolve));
    if (transactionOpen) {
      try { await runtime.query('ROLLBACK'); } catch (_) { /* retain original setup error */ }
    }
    if (connectedRuntime) await runtime.end();
    await migrator.connect();
    try {
      await assertConnectedIdentity(migrator, { role: 'rotamoto_migrator' });
      await migrator.query('BEGIN READ ONLY');
      try {
        await migrator.query("SELECT set_config('app.tenant_id',$1,true)", [companyId || '00000000-0000-7000-8000-000000000000']);
        const residual = await migrator.query(`SELECT
          (SELECT count(*) FROM rotamoto.companies WHERE id=$1) AS companies,
          (SELECT count(*) FROM rotamoto.users WHERE id=$2 AND email=$3) AS users,
          (SELECT count(*) FROM rotamoto.credentials WHERE user_id=$2) AS credentials,
          (SELECT count(*) FROM rotamoto.memberships WHERE company_id=$1 AND user_id=$2) AS memberships,
          (SELECT count(*) FROM rotamoto.roles WHERE company_id=$1) AS roles,
          (SELECT count(*) FROM rotamoto.provisioning_requests WHERE company_id=$1) AS provisioning_requests,
          (SELECT count(*) FROM rotamoto.identity_tokens WHERE company_id=$1) AS identity_tokens,
          (SELECT count(*) FROM rotamoto.sessions WHERE user_id=$2) AS sessions,
          (SELECT count(*) FROM rotamoto.domain_records WHERE company_id=$1) AS domain_records,
          (SELECT count(*) FROM rotamoto.sync_installations WHERE company_id=$1) AS installations,
          (SELECT count(*) FROM rotamoto.local_id_maps WHERE company_id=$1) AS aliases,
          (SELECT count(*) FROM rotamoto.sync_inbox WHERE company_id=$1) AS inbox,
          (SELECT count(*) FROM rotamoto.sync_outbox WHERE company_id=$1) AS outbox,
          (SELECT count(*) FROM rotamoto.audit_log WHERE company_id=$1) AS audit_rows`,
        [companyId || '00000000-0000-7000-8000-000000000000', fixtureUserId || '00000000-0000-7000-8000-000000000000', fixtureEmail || 'e2e-fixture-absent@example.invalid']);
        if (companyId) assert(Object.values(residual.rows[0]).every(value => value === '0'),
          'rollback teardown leaves no fixture residue across identity, audit and sync tables');
      } finally { await migrator.query('ROLLBACK'); }
    } finally { await migrator.end(); }
  }
}

module.exports = { runFixtureLifecycle, savepointPool };
