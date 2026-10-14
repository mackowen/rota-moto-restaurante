'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createE2eClients, assertConnectedIdentity } = require('./guards');
const { createIdentityService } = require('../../backend/identity/service');
const { createEmailDeliveryProvider } = require('../../backend/identity/email-provider');
const { createNativeMfaProvider } = require('../../backend/identity/native-mfa-provider');
const { codeAt, recoveryDigest } = require('../../backend/identity/totp');
const { createIdentityHttpHandler, createRateLimiter } = require('../../backend/identity/http');
const { createAdminHttpHandler } = require('../../backend/admin/http');
const { createAdminRepository } = require('../../backend/admin/repository');
const { createAdminService } = require('../../backend/admin/service');
const { createSyncHttpHandler } = require('../../backend/domain/sync-http');
const { createSyncService } = require('../../backend/domain/sync-service');
const { createFilesystemObjectStore } = require('../../backend/domain/filesystem-object-store');
const { createMediaStorage } = require('../../backend/domain/media-storage');
const { createProofMediaHttpHandler } = require('../../backend/domain/proof-media-http');
const { runProofMediaGc } = require('../../backend/domain/proof-media-gc');
const { createDomainQueryHttpHandler } = require('../../backend/domain/query-http');
const { createDomainQueryRepository } = require('../../backend/domain/query-repository');
const { createDomainQueryService } = require('../../backend/domain/query-service');
const { createDriverAvailabilityService } = require('../../backend/logistics/driver-availability');
const { createDriverAvailabilityHttpHandler } = require('../../backend/logistics/driver-availability-http');
const { COOKIE_NAME } = require('../../backend/identity/http');
const { createPool } = require('../../backend/postgres/connection');
const { resolveE2eTargets, storedLoopbackCredential } = require('./guards');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createFixtureManifest, safeMetadata } = require('./fixture-manifest');

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
    invitation: { limit: 50, windowMs: 60000 }, provision: { limit: 50, windowMs: 60000 }, mfa: { limit: 50, windowMs: 60000 }, default: { limit: 1000, windowMs: 60000 } } });
}

async function start(handler, requestContext) {
  // The rollback fixture uses one PostgreSQL client and savepoints, so keep its
  // legacy serialized mode until it explicitly switches to independent pool
  // transactions. Concurrent mode is used only by the opt-in E2E scenario.
  let pending = Promise.resolve();
  const inFlight = new Set();
  let serialized = true;
  let paused = false;
  const server = http.createServer(async (req, res) => {
    req.clientIp = '127.0.0.1';
    const suppliedId = req.headers['x-campaign-0137-request-id'];
    req.requestId = typeof suppliedId === 'string' && /^[0-9a-f-]{36}$/iu.test(suppliedId) ? suppliedId : crypto.randomUUID();
    const execute = async () => requestContext.run({ requestId: req.requestId, path: req.url }, async () => {
      if (paused) { if (!res.writableEnded) res.writeHead(503, { 'Cache-Control': 'no-store' }).end(); return; }
      for (const route of handler) if (await route(req, res)) return;
      if (!res.writableEnded) res.writeHead(404).end();
    });
    const task = serialized ? pending.then(execute) : execute();
    if (serialized) pending = task.catch(() => {});
    const settled = task.catch(error => {
      if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
      if (!res.writableEnded) res.end();
      // Keep the queue usable while surfacing the failure in the request log.
      console.error(`E2E fixture request ${req.requestId} failed: ${error.message}`);
    });
    inFlight.add(settled);
    settled.finally(() => inFlight.delete(settled));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, base: `http://127.0.0.1:${server.address().port}`,
    async pauseAndDrain() { paused = true; await pending; await Promise.allSettled([...inFlight]); },
    resumeConcurrent() { serialized = false; paused = false; } };
}

async function runFixtureLifecycle({ env = process.env, exercise = async () => {}, allowedOrigins = [],
  persistDisposableFixture = false, mediaDirectory: requestedMediaDirectory, extraHttpHandlers = () => [], navigationFixture = false,
  businessFixture = true, onTestEmail = null, independentRequestTransactions = false, retainIndependentFixture = false,
  onIndependentFixtureRetained = null, onIndependentConnection = null, onIndependentTransaction = null } = {}) {
  if (env.NODE_ENV !== 'test' || typeof extraHttpHandlers !== 'function') throw new Error('Handlers extras do fixture só são aceitos no modo test.');
  if (onTestEmail !== null && typeof onTestEmail !== 'function') throw new Error('Observador de email E2E inválido.');
  const clients = createE2eClients(env); // Validate both exact targets before a socket/client is opened.
  const disposableCampaign = clients.migrator ? env.ROTAMOTO_DISPOSABLE_CAMPAIGN === '0068' : false;
  if (persistDisposableFixture && (!disposableCampaign || env.NODE_ENV !== 'test' ||
      requestedMediaDirectory !== path.resolve(requestedMediaDirectory || '') ||
      path.dirname(requestedMediaDirectory) !== os.tmpdir() ||
      !path.basename(requestedMediaDirectory).startsWith('rotamoto-disposable-source-media-'))) {
    throw new Error('Fixture persistente aceita somente diretório temporário e origem descartável da campanha 0068.');
  }
  const { runtime, migrator } = clients;
  if (independentRequestTransactions && (env.ROTAMOTO_DISPOSABLE_CAMPAIGN === '0068' || persistDisposableFixture)) {
    throw new Error('Transações independentes do fixture aceitas somente em rotamoto_e2e.');
  }
  if (independentRequestTransactions && !retainIndependentFixture) throw new Error('Transações independentes exigem retenção explícita e manifesto durável.');
  if (retainIndependentFixture && !independentRequestTransactions) throw new Error('Retenção de fixture exige transações independentes.');
  if (onIndependentFixtureRetained !== null && typeof onIndependentFixtureRetained !== 'function') throw new Error('Observador de fixture retida inválido.');
  if (onIndependentConnection !== null && typeof onIndependentConnection !== 'function') throw new Error('Observador de conexão independente inválido.');
  if (onIndependentTransaction !== null && typeof onIndependentTransaction !== 'function') throw new Error('Observador de transação independente inválido.');
  const fixtureManifest = disposableCampaign ? null : await createFixtureManifest({
    campaign: env.ROTAMOTO_E2E_CAMPAIGN || 'unassigned' });
  if (fixtureManifest) await fixtureManifest.update({ status: 'RUNNING' });
  let connectedRuntime = false;
  let transactionOpen = false;
  let committedForIndependentRequests = false;
  let independentPool = null;
  let activePool = null;
  const requestContext = new AsyncLocalStorage();
  const instrumentedIndependentClients = new WeakSet();
  const fixtureTenantIds = [];
  const fixtureUserIds = [];
  const fixtureSessionIds = [];
  const fixtureTrackedRecords = { authRecords: [], memberships: [], roles: [], drivers: [], orders: [], deliveries: [], routes: [], proofs: [] };
  const fixtureTrackedByTenant = new Map();
  const trackFixtureRecord = (tenantId, kind, ids) => {
    const values = Array.isArray(ids) ? ids : [ids];
    fixtureTrackedRecords[kind] ||= [];
    fixtureTrackedRecords[kind].push(...values.filter(value => !fixtureTrackedRecords[kind].includes(value)));
    const tenantRecords = fixtureTrackedByTenant.get(tenantId) || {};
    tenantRecords[kind] ||= [];
    tenantRecords[kind].push(...values.filter(value => !tenantRecords[kind].includes(value)));
    fixtureTrackedByTenant.set(tenantId, tenantRecords);
  };
  const fixtureTenantByUser = new Map();
  const fixtureTenantBySession = new Map();
  const syncFixtureManifest = async extra => {
    if (!fixtureManifest) return;
    await fixtureManifest.update({ tenants: fixtureTenantIds.map(id => {
      const userIds = fixtureUserIds.filter(userId => fixtureTenantByUser.get(userId) === id);
      const sessionIds = fixtureSessionIds.filter(sessionId => fixtureTenantBySession.get(sessionId) === id);
      const known = fixtureTrackedByTenant.get(id) || {};
      return { id, userIds, sessionIds, counts: { companies: 1, users: userIds.length, sessions: sessionIds.length,
        ...Object.fromEntries(Object.entries(known).map(([kind, ids]) => [kind, ids.length])) } };
    }),
      records: { companies: [...fixtureTenantIds], users: [...fixtureUserIds], sessions: [...fixtureSessionIds],
        ...fixtureTrackedRecords }, ...extra });
  };
  let host;
  let mediaDirectory;
  let companyId;
  let fixtureUserId;
  let fixtureEmail;
  let fixturePersisted = false;
  let lifecycleFailed = false;
  try {
    await runtime.connect(); connectedRuntime = true;
    const database = disposableCampaign ? 'rotamoto_disposable_0068_source' : 'rotamoto_e2e';
    await assertConnectedIdentity(runtime, { role: 'rotamoto_app', database, env });
    await runtime.query('BEGIN'); transactionOpen = true;
    activePool = savepointPool(runtime);
    const pool = { async connect(...args) {
      const client = await activePool.connect(...args);
      const context = requestContext.getStore();
      const requestId = context?.requestId;
      if (requestId && independentPool) {
        const applicationName = `campaign-0137:${requestId}`;
        await client.query("SELECT set_config('application_name',$1,false)", [applicationName]);
        const identity = await client.query('SELECT pg_backend_pid() AS pid,current_user AS role,current_database() AS database');
        onIndependentConnection?.({ requestId, applicationName, ...identity.rows[0] });
        if (context.path === '/api/sync/push' && !instrumentedIndependentClients.has(client)) {
          const query = client.query.bind(client);
          client.query = async (sql, values) => {
            const queryText = typeof sql === 'string' ? sql : sql?.text;
            const result = await query(sql, values);
            const currentRequest = requestContext.getStore();
            if (currentRequest?.path === '/api/sync/push' && typeof queryText === 'string' && /^\s*BEGIN\b/iu.test(queryText)) {
              const transaction = await query('SELECT pg_backend_pid() AS pid,txid_current()::text AS xid');
              onIndependentTransaction?.({ requestId: currentRequest.requestId,
                applicationName: `campaign-0137:${currentRequest.requestId}`, ...transaction.rows[0] });
            }
            return result;
          };
          instrumentedIndependentClients.add(client);
        }
      }
      return client;
    } };
    const emails = [];
    const operatorMarker = crypto.randomBytes(32).toString('base64url');
    const mfaSecrets = new Map();
    const secretProvider = Object.freeze({ async put({ value }) { const secretRef=`local-v1:${crypto.randomUUID()}`;mfaSecrets.set(secretRef,value);return {secretRef}; },
      async get(secretRef) { if(!mfaSecrets.has(secretRef))throw new Error('missing test secret');return mfaSecrets.get(secretRef); },
      async remove(secretRef) { mfaSecrets.delete(secretRef); } });
    const password = `E2E-${crypto.randomBytes(30).toString('base64url')}`;
    const identityService = createIdentityService({ pool,
      authorizeProvisioner: async ({ context }) => {
        if (context?.request?.headers['x-e2e-operator'] !== operatorMarker) throw new Error('unauthorized');
        return { actorRef: 'test:e2e-fixture-operator' };
      },
      emailProvider: createEmailDeliveryProvider(async message => { emails.push(message); onTestEmail?.(message); return { accepted: true }; }),
      mfaProvider: createNativeMfaProvider({ secretProvider }) , secretProvider });
    const limiter = rateLimiter();
    const originConfig = allowedOrigins.length ? allowedOrigins : undefined;
    const identityHttp = createIdentityHttpHandler({ identityService, logger: () => {}, rateLimiter: limiter,
      allowedOrigin: originConfig });
    mediaDirectory = requestedMediaDirectory || await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-e2e-media-'));
    if (requestedMediaDirectory) await fs.mkdir(mediaDirectory, { recursive: false, mode: 0o700 });
    const objectStore = await createFilesystemObjectStore({ directory: mediaDirectory });
    const mediaStorage = createMediaStorage({ objectStore });
    const proofHttp = createProofMediaHttpHandler({ identityService, mediaStorage, allowedOrigin: originConfig,
      rateLimiter: limiter });
    const adminHttp = createAdminHttpHandler({ identityService, adminService: createAdminService({ repository: createAdminRepository() }),
      logger: () => {}, rateLimiter: limiter, allowedOrigin: originConfig });
    const driverAvailabilityService=createDriverAvailabilityService();
    const syncHttp = createSyncHttpHandler({ identityService, syncService: createSyncService({ mediaStorage,driverAvailability:driverAvailabilityService }), logger: () => {}, rateLimiter: limiter,
      allowedOrigin: originConfig });
    const driverAvailabilityHttp=createDriverAvailabilityHttpHandler({identityService,service:driverAvailabilityService,logger:()=>{},rateLimiter:limiter,allowedOrigin:originConfig});
    const queryHttp = createDomainQueryHttpHandler({ identityService,
      queryService: createDomainQueryService({ repository: createDomainQueryRepository() }), logger: () => {}, rateLimiter: limiter });
    const testHandlers = await extraHttpHandlers(Object.freeze({ identityService, runtime, pool }));
    if (!Array.isArray(testHandlers) || testHandlers.some(handler => typeof handler !== 'function')) throw new Error('Handlers E2E inválidos.');
    // Test-only domain adapters must run before the broad /api/admin handler so
    // mounted marketplace/admin subdomains can use their canonical routes.
    host = await start([identityHttp, ...testHandlers, adminHttp, proofHttp, driverAvailabilityHttp, syncHttp, queryHttp], requestContext);

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
    fixtureTenantIds.push(companyId);
    await syncFixtureManifest();
    assert.equal(emails.length, 1);
    assert.equal(emails[0].kind, 'owner_invitation');
    assert.equal(JSON.stringify(provisioned.body).includes(emails[0].token), false);

    const accepted = await call('/api/identity/invitations/accept', { method: 'POST', body: { token: emails[0].token, password } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    fixtureUserId = accepted.body.userId;
    fixtureUserIds.push(fixtureUserId);
    fixtureTenantByUser.set(fixtureUserId, companyId);
    trackFixtureRecord(companyId, 'authRecords', fixtureUserId);
    await syncFixtureManifest();
    const enrollmentLogin = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId } });
    assert.equal(enrollmentLogin.status,200,JSON.stringify(enrollmentLogin.body));
    assert.equal(enrollmentLogin.body.mfaEnrollmentRequired,true,'unconfigured required MFA yields a limited enrollment session');
    const setupCookie=enrollmentLogin.headers.get('set-cookie').split(';',1)[0];
    const setupSession=await call('/api/identity/session',{cookie:setupCookie});assert.equal(setupSession.status,200);assert.equal(setupSession.body.mfaEnrollmentRequired,true);
    const enrollment=await call('/api/identity/mfa/enrollment',{method:'POST',cookie:setupCookie,csrf:setupSession.body.csrfToken,body:{}});
    assert.equal(enrollment.status,200,JSON.stringify(enrollment.body));assert.match(enrollment.body.otpauthUri,/^otpauth:\/\/totp\//u);
    const wrongCode=String((Number(codeAt(enrollment.body.secret,Math.floor(Date.now()/30000)))+1)%1000000).padStart(6,'0');
    const wrongConfirmation=await call('/api/identity/mfa/enrollment/confirm',{method:'POST',cookie:setupCookie,csrf:setupSession.body.csrfToken,body:{code:wrongCode}});
    assert.equal(wrongConfirmation.status,403);
    const currentCode=codeAt(enrollment.body.secret,Math.floor(Date.now()/30000));
    const confirmed=await call('/api/identity/mfa/enrollment/confirm',{method:'POST',cookie:setupCookie,csrf:setupSession.body.csrfToken,body:{code:currentCode}});
    assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));assert.equal(confirmed.body.recoveryCodes.length,10);
    assert.equal(JSON.stringify(confirmed.body).includes(enrollment.body.secret),false,'enrollment secret is not returned after confirmation');
    const credential=await runtime.query('SELECT mfa_secret_ref,mfa_totp_last_counter FROM rotamoto.credentials WHERE user_id=$1',[fixtureUserId]);
    assert.match(credential.rows[0].mfa_secret_ref,/^local-v1:/u);assert.notEqual(credential.rows[0].mfa_secret_ref,enrollment.body.secret);
    const savedRecoveryDigests=await runtime.query("SELECT encode(token_digest,'hex') AS digest FROM rotamoto.recovery_tokens WHERE user_id=$1 AND purpose='mfa_recovery' ORDER BY digest",[fixtureUserId]);
    assert.deepEqual(savedRecoveryDigests.rows.map(row=>row.digest),confirmed.body.recoveryCodes.map(code=>recoveryDigest(code).toString('hex')).sort(),
      'PostgreSQL stores only digests of one-time MFA recovery codes');
    const enrollmentCounter=Math.floor(Date.now()/30000);
    const futureCode=codeAt(enrollment.body.secret,enrollmentCounter+1);
    const invalidMfa = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId,
      mfaCode: String((Number(futureCode) + 1) % 1000000).padStart(6, '0') } });
    assert.equal(invalidMfa.status, 403, 'invalid native MFA proof cannot create an authenticated fixture');
    const replayCode=await call('/api/identity/login',{method:'POST',body:{email,password,companyId,mfaCode:currentCode}});
    assert.equal(replayCode.status,403,'the TOTP counter accepted during enrollment cannot be replayed');
    const persistedEnrollmentCounter=Number(credential.rows[0].mfa_totp_last_counter);
    while (Math.floor(Date.now()/30000) <= persistedEnrollmentCounter) await new Promise(resolve => setTimeout(resolve,100));
    const loginCounter=Math.floor(Date.now()/30000);
    const loginCode=codeAt(enrollment.body.secret,loginCounter);
    const login = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, mfaCode: loginCode } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const firstLoginCounter=loginCounter;
    const sessionCookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert(sessionCookie.startsWith(`${COOKIE_NAME}=`));
    const session = await call('/api/identity/session', { cookie: sessionCookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.mfaVerified, true);
    try {
      const sessions = await runtime.query('SELECT id::text FROM rotamoto.sessions WHERE user_id=$1', [fixtureUserId]);
      fixtureSessionIds.push(...sessions.rows.map(row => row.id));
      for (const sessionId of sessions.rows.map(row => row.id)) fixtureTenantBySession.set(sessionId, companyId);
      await syncFixtureManifest();
    } catch (_) { /* session IDs are optional when runtime privileges hide the table */ }
    const recoveryLogin=await call('/api/identity/login',{method:'POST',body:{email,password,companyId,mfaCode:confirmed.body.recoveryCodes[0]}});
    assert.equal(recoveryLogin.status,200,'a one-time recovery code can authenticate once');
    await call('/api/identity/logout',{method:'POST',cookie:recoveryLogin.headers.get('set-cookie').split(';',1)[0],csrf:recoveryLogin.body.csrfToken});
    const recoveryReplay=await call('/api/identity/login',{method:'POST',body:{email,password,companyId,mfaCode:confirmed.body.recoveryCodes[0]}});
    assert.equal(recoveryReplay.status,403,'a consumed recovery code cannot be replayed');
    const csrf = session.body.csrfToken;
    const membershipList = await call('/api/admin/memberships?limit=100', { cookie: sessionCookie });
    assert.equal(membershipList.status, 200);
    const membership = membershipList.body.members.find(row => row.userId === accepted.body.userId);
    assert(membership, 'provisioning service created owner membership');
    trackFixtureRecord(companyId, 'memberships', membership.membershipId);
    if (membership.roleId) trackFixtureRecord(companyId, 'roles', membership.roleId);

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
    trackFixtureRecord(companyId, 'drivers', driverId);
    const binding = await call(`/api/admin/memberships/${membership.membershipId}/driver`, { method: 'PUT', cookie: sessionCookie,
      csrf, body: { driverId } });
    assert.equal(binding.status, 200, JSON.stringify(binding.body));
    const motoboyDevice = `motoboy-${crypto.randomUUID()}`;
    const motoboyRegistration = await call('/api/sync/installations/motoboy', { method: 'POST', cookie: sessionCookie, csrf,
      body: { deviceId: motoboyDevice } });
    assert.equal(motoboyRegistration.status, 200, JSON.stringify(motoboyRegistration.body));
    const availabilityOnline=await call('/api/driver-availability/commands',{method:'POST',cookie:sessionCookie,csrf,
      body:{desiredStatus:'online',expectedRevision:0,commandId:crypto.randomUUID()}});
    assert.equal(availabilityOnline.status,200,JSON.stringify(availabilityOnline.body));
    assert.equal(availabilityOnline.body.availability.effectiveStatus,'online','fixture explicitly opts its Driver in before creating assigned work');

    let orderId = null, deliveryId = null, navigationRouteId = null, proofFixture = null;
    let navigationDeliveryIds = [];
    if (businessFixture) {
    const orderLocalId = `order-${crypto.randomUUID()}`;
    const deliveryLocalId = `delivery-${crypto.randomUUID()}`;
    const orderDelivery = await call('/api/sync/push', { method: 'POST', cookie: sessionCookie, csrf, body: {
      protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId: `pkt_${crypto.randomUUID()}`,
      deviceId: restaurantDevice, source: { deviceId: restaurantDevice }, createdAt: now,
      data: { orders: [{ id: orderLocalId, customer: 'Cliente E2E', source: 'ifood', externalId: crypto.randomUUID(), status: 'CREATED', createdAt: now, updatedAt: now, version: 1,
          ...(navigationFixture ? { extensions: { x_rotamoto_navigation_coordinates: { latitude: -23.50, longitude: -46.60, provenance: 'restaurant_order_coordinates' } } } : {}) }],
        deliveries: [{ id: deliveryLocalId, orderId: orderLocalId, driverId, status: 'ASSIGNED', createdAt: now, updatedAt: now, version: 1 }] }
    } });
    assert.equal(orderDelivery.status, 200, JSON.stringify(orderDelivery.body));
    assert(orderDelivery.body.operationResults.every(result => result.status === 'accepted'), JSON.stringify(orderDelivery.body.operationResults));
    orderId = orderDelivery.body.aliases.find(row => row.entity === 'Order').canonicalId;
    deliveryId = orderDelivery.body.aliases.find(row => row.entity === 'Delivery').canonicalId;
    trackFixtureRecord(companyId, 'orders', orderId);
    trackFixtureRecord(companyId, 'deliveries', deliveryId);
    if (navigationFixture) {
      const localOrders = Array.from({ length: 5 }, (_, index) => ({ id: crypto.randomUUID(), companyId,
        customer: `QA parada ${index + 2}`, source: index % 2 ? 'whatsapp' : 'manual', number: String(index + 2),
        createdAt: now, updatedAt: now, version: 1,
        extensions: { x_rotamoto_navigation_coordinates: { latitude: -23.50 - (index + 1) * 0.002,
          longitude: -46.60 - (index + 1) * 0.002, provenance: 'restaurant_order_coordinates' } } }));
      const localDeliveries = localOrders.map(order => ({ id: crypto.randomUUID(), companyId, orderId: order.id,
        driverId, status: 'ASSIGNED', createdAt: now, updatedAt: now, version: 1 }));
      const stopsPush = await call('/api/sync/push', { method: 'POST', cookie: sessionCookie, csrf, body: {
        protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId: `pkt_${crypto.randomUUID()}`,
        deviceId: restaurantDevice, source: { deviceId: restaurantDevice }, createdAt: now,
        data: { orders: localOrders, deliveries: localDeliveries }
      } });
      assert.equal(stopsPush.status, 200, JSON.stringify(stopsPush.body));
      assert(stopsPush.body.operationResults.every(result => result.status === 'accepted'), JSON.stringify(stopsPush.body.operationResults));
      navigationDeliveryIds = [deliveryId, ...stopsPush.body.aliases.filter(row => row.entity === 'Delivery').map(row => row.canonicalId)];
      trackFixtureRecord(companyId, 'orders', stopsPush.body.aliases.filter(row => row.entity === 'Order').map(row => row.canonicalId));
      trackFixtureRecord(companyId, 'deliveries', navigationDeliveryIds.slice(1));
      navigationRouteId = crypto.randomUUID();
      const routePush = await call('/api/sync/push', { method: 'POST', cookie: sessionCookie, csrf, body: {
        protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId: `pkt_${crypto.randomUUID()}`,
        deviceId: restaurantDevice, source: { deviceId: restaurantDevice }, createdAt: now,
        data: { routes: [{ id: navigationRouteId, companyId, deliveryIds: navigationDeliveryIds, status: 'PLANNED', createdAt: now, updatedAt: now, version: 1 }] }
      } });
      assert.equal(routePush.status, 200, JSON.stringify(routePush.body));
      assert(routePush.body.operationResults.every(result => result.status === 'accepted'), JSON.stringify(routePush.body.operationResults));
      navigationRouteId = routePush.body.aliases.find(row => row.entity === 'Route').canonicalId;
      trackFixtureRecord(companyId, 'routes', navigationRouteId);
    }
    }
    if (businessFixture) {
    const delivery = await call(`/api/domain/deliveries/${deliveryId}`, { cookie: sessionCookie });
    assert.equal(delivery.status, 200, JSON.stringify(delivery.body));
    assert.equal(delivery.body.record.orderId, orderId);

    const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
    const deniedUpload = await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/media`, { method: 'POST',
      headers: { Origin: allowedOrigins[0] || host.base, 'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
    assert.equal(deniedUpload.status, 401, 'media upload requires an authenticated session');
    const csrfDeniedUpload = await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/media`, { method: 'POST',
      headers: { Origin: allowedOrigins[0] || host.base, Cookie: sessionCookie, 'Content-Type': 'image/png',
        'Content-Length': String(png.length) }, body: png });
    assert.equal(csrfDeniedUpload.status, 403, 'media upload requires CSRF validation');
    const unbound = await call(`/api/admin/memberships/${membership.membershipId}/driver`, {
      method: 'DELETE', cookie: sessionCookie, csrf
    });
    assert.equal(unbound.status, 200, JSON.stringify(unbound.body));
    const staleAssignmentUpload = await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/media?proofId=${crypto.randomUUID()}`, { method: 'POST',
      headers: { Origin: allowedOrigins[0] || host.base, Cookie: sessionCookie, 'X-CSRF-Token': csrf,
        'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
    assert.equal(staleAssignmentUpload.status, 403, 'media upload checks the current server-side Driver association');
    const rebound = await call(`/api/admin/memberships/${membership.membershipId}/driver`, {
      method: 'PUT', cookie: sessionCookie, csrf, body: { driverId }
    });
    assert.equal(rebound.status, 200, JSON.stringify(rebound.body));
    const proofId = crypto.randomUUID();
    const uploaded = await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/media?proofId=${proofId}`, { method: 'POST',
      headers: { Origin: allowedOrigins[0] || host.base, Cookie: sessionCookie, 'X-CSRF-Token': csrf,
        'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
    const uploadedBody = await uploaded.json();
    assert.equal(uploaded.status, 201, JSON.stringify(uploadedBody));
    assert.equal(uploadedBody.storageRef.provider, 'filesystem-v1');
    assert.equal(uploadedBody.sizeBytes, png.length);
    const repeatedUpload=await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/media?proofId=${proofId}`,{method:'POST',
      headers:{Origin:allowedOrigins[0]||host.base,Cookie:sessionCookie,'X-CSRF-Token':csrf,'Content-Type':'image/png','Content-Length':String(png.length)},body:png});
    const repeatedBody=await repeatedUpload.json();assert.equal(repeatedUpload.status,201,JSON.stringify(repeatedBody));
    assert.deepEqual(repeatedBody.storageRef,uploadedBody.storageRef,'retry of the same proof reuses one media object');
    assert.equal(repeatedBody.sha256,uploadedBody.sha256);
    const changedBytes=Buffer.concat([png,Buffer.from([1])]);
    const conflictingUpload=await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/media?proofId=${proofId}`,{method:'POST',
      headers:{Origin:allowedOrigins[0]||host.base,Cookie:sessionCookie,'X-CSRF-Token':csrf,'Content-Type':'image/png','Content-Length':String(changedBytes.length)},body:changedBytes});
    assert.equal(conflictingUpload.status,409,'one proof ID cannot be rebound to different image bytes');
    const pendingGc=await runProofMediaGc({pool,objectStore,now:()=>new Date(Date.now()+120_000),graceMs:60_000,dryRun:false,log:()=>{}});
    assert.equal(pendingGc.skipped,1,'staged upload intent protects media if the response is lost or sync stays offline');
    const motoboyProofPush = await call('/api/sync/push', { method: 'POST', cookie: sessionCookie, csrf, body: {
      protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId: `pkt_${crypto.randomUUID()}`,
      deviceId: motoboyDevice, source: { deviceId: motoboyDevice }, createdAt: now,
      data: { proofs: [{ id: proofId, deliveryId, companyId, createdAt: now, version: 1, kind: 'signature',
        media: { mimeType: uploadedBody.mimeType, sizeBytes: uploadedBody.sizeBytes, sha256: uploadedBody.sha256,
          storageRef: uploadedBody.storageRef } }] }
    } });
    assert.equal(motoboyProofPush.status, 200, JSON.stringify(motoboyProofPush.body));
    assert.equal(motoboyProofPush.body.operationResults[0].status, 'accepted', JSON.stringify(motoboyProofPush.body.operationResults));
    const canonicalProofId=motoboyProofPush.body.operationResults[0].canonicalId;
    proofFixture = Object.freeze({ proofId, canonicalProofId, storageRef: uploadedBody.storageRef,
      sha256: uploadedBody.sha256, sizeBytes: uploadedBody.sizeBytes, mimeType: uploadedBody.mimeType });
    trackFixtureRecord(companyId, 'proofs', canonicalProofId);
    await runtime.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
    const canonicalProof=await runtime.query("SELECT payload,related_entity_type,related_record_id::text FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,canonicalProofId]);
    assert.equal(canonicalProof.rowCount,1,'accepted proof has canonical PostgreSQL metadata');
    assert.equal(canonicalProof.rows[0].related_record_id,deliveryId);
    const uploadIntent=await runtime.query('SELECT 1 FROM rotamoto.proof_media_upload_intents WHERE company_id=$1 AND proof_id=$2',[companyId,proofId]);
    assert.equal(uploadIntent.rowCount,0,'sync consumes the staged upload intent atomically with canonical metadata');
    const canonicalRetry=await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/media?proofId=${proofId}`,{method:'POST',
      headers:{Origin:allowedOrigins[0]||host.base,Cookie:sessionCookie,'Content-Type':'image/png','X-CSRF-Token':csrf},body:Buffer.from(png)});
    assert.equal(canonicalRetry.status,201,'retry after canonical metadata ACK remains idempotent');
    const canonicalRetryBody=await canonicalRetry.json();
    assert.deepEqual(canonicalRetryBody.storageRef,uploadedBody.storageRef,'post-ACK retry returns the canonical media reference');
    assert.equal(canonicalRetryBody.sha256,uploadedBody.sha256);
    const retryIntent=await runtime.query('SELECT 1 FROM rotamoto.proof_media_upload_intents WHERE company_id=$1 AND proof_id=$2',[companyId,proofId]);
    assert.equal(retryIntent.rowCount,0,'post-ACK idempotent retry does not recreate an orphan upload intent');
    const gcResult=await runProofMediaGc({pool,objectStore,now:()=>new Date(Date.now()+120_000),graceMs:60_000,dryRun:false,log:()=>{}});
    assert.equal(gcResult.skipped,1,'GC confirms canonical reference and preserves synced media');
    const proofRead = await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/${canonicalProofId}/media`, {
      headers: { Origin: allowedOrigins[0] || host.base, Cookie: sessionCookie } });
    assert.equal(proofRead.status, 200, await proofRead.clone().text());
    assert.equal(Buffer.from(await proofRead.arrayBuffer()).toString('hex'), png.toString('hex'));
    }

    const authenticatedCall = (path, options = {}) => call(path, { ...options,
      cookie: options.cookie || sessionCookie, csrf: options.csrf === undefined ? csrf : options.csrf });
    // Wait until the first login's accepted +1 counter is current, then use its
    // next counter. This avoids replaying the same TOTP in fast fixture runs.
    while (Math.floor(Date.now() / 30000) < firstLoginCounter)
      await new Promise(resolve => setTimeout(resolve, 100));
    const browserMfaCode = codeAt(enrollment.body.secret, Math.floor(Date.now() / 30000) + 1);
    const provisionAdditionalTenant = async ({ companyName, email: tenantEmail }) => {
      if (typeof companyName !== 'string' || !companyName.trim() || typeof tenantEmail !== 'string' || !tenantEmail.includes('@'))
        throw new Error('Tenant E2E adicional inválido.');
      const provisionedTenant = await call('/api/admin/tenants/provision', { method: 'POST',
        body: { companyName, email: tenantEmail, idempotencyKey: `e2e-${crypto.randomUUID()}` },
        headers: { 'X-E2E-Operator': operatorMarker } });
      assert.equal(provisionedTenant.status, 202, JSON.stringify(provisionedTenant.body));
      fixtureTenantIds.push(provisionedTenant.body.companyId);
      await syncFixtureManifest();
      const ownerInvitation = emails.findLast(message => message.kind === 'owner_invitation' && message.to === tenantEmail);
      assert(ownerInvitation?.token, 'E2E email sink captured the second tenant owner invitation');
      const tenantPassword = `E2E-${crypto.randomBytes(30).toString('base64url')}`;
      const tenantAccepted = await call('/api/identity/invitations/accept', { method: 'POST',
        body: { token: ownerInvitation.token, password: tenantPassword } });
      assert.equal(tenantAccepted.status, 200, JSON.stringify(tenantAccepted.body));
      fixtureUserIds.push(tenantAccepted.body.userId);
      trackFixtureRecord(provisionedTenant.body.companyId, 'authRecords', tenantAccepted.body.userId);
      fixtureTenantByUser.set(tenantAccepted.body.userId, provisionedTenant.body.companyId);
      await syncFixtureManifest();
      const enrollmentLogin = await call('/api/identity/login', { method: 'POST',
        body: { email: tenantEmail, password: tenantPassword, companyId: provisionedTenant.body.companyId } });
      assert.equal(enrollmentLogin.status, 200, JSON.stringify(enrollmentLogin.body));
      const setupCookie = enrollmentLogin.headers.get('set-cookie').split(';', 1)[0];
      const setupSession = await call('/api/identity/session', { cookie: setupCookie });
      const enrollment = await call('/api/identity/mfa/enrollment', { method: 'POST', cookie: setupCookie,
        csrf: setupSession.body.csrfToken, body: {} });
      assert.equal(enrollment.status, 200, JSON.stringify(enrollment.body));
      let counter = Math.floor(Date.now() / 30000);
      const confirmed = await call('/api/identity/mfa/enrollment/confirm', { method: 'POST', cookie: setupCookie,
        csrf: setupSession.body.csrfToken, body: { code: codeAt(enrollment.body.secret, counter) } });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      while (Math.floor(Date.now() / 30000) <= counter) await new Promise(resolve => setTimeout(resolve, 100));
      counter = Math.floor(Date.now() / 30000);
      const ownerLogin = await call('/api/identity/login', { method: 'POST',
        body: { email: tenantEmail, password: tenantPassword, companyId: provisionedTenant.body.companyId,
          mfaCode: codeAt(enrollment.body.secret, counter) } });
      assert.equal(ownerLogin.status, 200, JSON.stringify(ownerLogin.body));
      try {
        const sessions = await runtime.query('SELECT id::text FROM rotamoto.sessions WHERE user_id=$1', [tenantAccepted.body.userId]);
        fixtureSessionIds.push(...sessions.rows.map(row => row.id));
        for (const sessionId of sessions.rows.map(row => row.id)) fixtureTenantBySession.set(sessionId, provisionedTenant.body.companyId);
        await syncFixtureManifest();
      } catch (_) { /* session IDs are optional under restricted runtime grants */ }
      const ownerCookie = ownerLogin.headers.get('set-cookie').split(';', 1)[0];
      const ownerSession = await call('/api/identity/session', { cookie: ownerCookie });
      assert.equal(ownerSession.status, 200, JSON.stringify(ownerSession.body));
      const memberships = await call('/api/admin/memberships?limit=100', { cookie: ownerCookie });
      const ownerMembership = memberships.body.members.find(row => row.userId === tenantAccepted.body.userId);
      assert(ownerMembership?.membershipId, 'second tenant owner membership exists');
      trackFixtureRecord(provisionedTenant.body.companyId, 'memberships', ownerMembership.membershipId);
      if (ownerMembership.roleId) trackFixtureRecord(provisionedTenant.body.companyId, 'roles', ownerMembership.roleId);
      const deviceId = `tenant-b-${crypto.randomUUID()}`;
      const registered = await call('/api/sync/installations/restaurante', { method: 'POST', cookie: ownerCookie,
        csrf: ownerSession.body.csrfToken, body: { deviceId } });
      assert.equal(registered.status, 200, JSON.stringify(registered.body));
      const now = new Date().toISOString(), localDriverId = `driver-${crypto.randomUUID()}`;
      const driverPush = await call('/api/sync/push', { method: 'POST', cookie: ownerCookie, csrf: ownerSession.body.csrfToken,
        body: { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
          packetId: `pkt_${crypto.randomUUID()}`, deviceId, source: { deviceId }, createdAt: now,
          data: { drivers: [{ id: localDriverId, name: 'Motorista Tenant B E2E', status: 'active', createdAt: now, updatedAt: now, version: 1 }] } } });
      assert.equal(driverPush.status, 200, JSON.stringify(driverPush.body));
      const tenantDriverId = driverPush.body.aliases.find(row => row.entity === 'Driver')?.canonicalId;
      assert(tenantDriverId, 'second tenant Driver has canonical identity');
      const bound = await call(`/api/admin/memberships/${ownerMembership.membershipId}/driver`, { method: 'PUT', cookie: ownerCookie,
        csrf: ownerSession.body.csrfToken, body: { driverId: tenantDriverId } });
      assert.equal(bound.status, 200, JSON.stringify(bound.body));
      return Object.freeze({ companyId: provisionedTenant.body.companyId, userId: tenantAccepted.body.userId,
        membershipId: ownerMembership.membershipId, driverId: tenantDriverId, cookie: ownerCookie,
        csrf: ownerSession.body.csrfToken, email: tenantEmail });
    };
    const enableIndependentRequestTransactions = async () => {
      if (!independentRequestTransactions) throw new Error('Este fixture não habilitou transações independentes.');
      if (independentPool) return;
      await syncFixtureManifest();
      await host.pauseAndDrain();
      await runtime.query('COMMIT');
      transactionOpen = false;
      committedForIndependentRequests = true;
      await syncFixtureManifest({ databaseCommitted: true,
        retentionReason: 'Execução usa sessões PostgreSQL independentes; registros confirmados são preservados até revisão de propriedade e dependências.' });
      const target = resolveE2eTargets(env).runtime;
      independentPool = createPool({ connectionString: target,
        password: storedLoopbackCredential('rotamoto_app', 'rotamoto_e2e'),
        max: 8, connectionTimeoutMillis: 5000, application_name: 'campaign-0137-browser-independent' });
      const probe = await independentPool.connect();
      try { await assertConnectedIdentity(probe, { role: 'rotamoto_app', database: 'rotamoto_e2e', env }); }
      finally { probe.release(); }
      activePool = independentPool;
      // Keep the fixture's inspection client in a fresh READ COMMITTED
      // transaction so tenant-scoped assertions see commits from request PIDs.
      await runtime.query('BEGIN');
      await runtime.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
      transactionOpen = true;
      host.resumeConcurrent();
    };
    const registerFixtureTenant = async ({ id, userIds = [], sessionIds = [], records = {} } = {}) => {
      if (!fixtureManifest || !/^[0-9a-f-]{36}$/iu.test(id || '') ||
          [...userIds, ...sessionIds].some(value => !/^[0-9a-f-]{36}$/iu.test(value))) {
        throw new Error('Fixture tenant registration requires UUID identifiers in rotamoto_e2e.');
      }
      if (!fixtureTenantIds.includes(id)) fixtureTenantIds.push(id);
      for (const userId of userIds) {
        if (!fixtureUserIds.includes(userId)) fixtureUserIds.push(userId);
        fixtureTenantByUser.set(userId, id);
      }
      for (const sessionId of sessionIds) {
        if (!fixtureSessionIds.includes(sessionId)) fixtureSessionIds.push(sessionId);
        fixtureTenantBySession.set(sessionId, id);
      }
      for (const [kind, ids] of Object.entries(records)) {
        if (!/^[a-z][a-zA-Z0-9_]{0,39}$/u.test(kind) || !Array.isArray(ids) ||
            ids.some(value => typeof value !== 'string' || value.length > 200)) throw new Error('Fixture record registration is invalid.');
        safeMetadata({ [kind]: ids });
        trackFixtureRecord(id, kind, ids);
      }
      await syncFixtureManifest();
    };
    await exercise(Object.freeze({ companyId, userId: accepted.body.userId, membershipId: membership.membershipId,
      driverId, orderId, deliveryId, navigationRouteId, navigationDeliveryIds: Object.freeze([...navigationDeliveryIds]), motoboyDevice, restaurantDevice, email, password, mfaCode: browserMfaCode,
      browserSessionCookie: sessionCookie, apiOrigin: host.base, mediaDirectory, proof: proofFixture,
      provisionAdditionalTenant, runtime, call, authenticatedCall, driverAvailabilityService,
      enableIndependentRequestTransactions, registerFixtureTenant,
      fixtureManifest: fixtureManifest ? Object.freeze({ runId: fixtureManifest.runId, file: fixtureManifest.file }) : null,
      acquireIndependentRuntimeClient: async () => {
        if (!independentPool) throw new Error('Transações independentes ainda não habilitadas.');
        return independentPool.connect();
      } }));
    const recoveryRequest = await call('/api/identity/recovery', { method: 'POST', body: { email } });
    assert.equal(recoveryRequest.status, 202, JSON.stringify(recoveryRequest.body));
    const recoveryEmail = emails.findLast(message => message.kind === 'password_recovery' && message.to === email);
    assert(recoveryEmail?.token, 'the test email sink captured this fixture user’s password-recovery token');
    assert.equal(JSON.stringify(recoveryRequest.body).includes(recoveryEmail.token), false,
      'recovery token is delivered out of band and never returned by the API');
    const recoveredPassword = `E2E-recovered-${crypto.randomBytes(24).toString('base64url')}`;
    const recoveryConsumed = await call('/api/identity/recovery/consume', { method: 'POST',
      body: { token: recoveryEmail.token, password: recoveredPassword } });
    assert.equal(recoveryConsumed.status, 204);
    const passwordRecoveryReplay = await call('/api/identity/recovery/consume', { method: 'POST',
      body: { token: recoveryEmail.token, password: recoveredPassword } });
    assert.equal(passwordRecoveryReplay.status, 401, 'password recovery token is one-time');
    if (fixtureManifest) await syncFixtureManifest({ databaseCommitted: committedForIndependentRequests || fixturePersisted,
      evidence: [{ kind: 'fixture-manifest', path: fixtureManifest.file }] });
    if (persistDisposableFixture) {
      await runtime.query('COMMIT'); transactionOpen = false; fixturePersisted = true;
    }
    return Object.freeze({ companyId, userId: accepted.body.userId, membershipId: membership.membershipId,
      driverId, orderId, deliveryId, navigationRouteId, navigationDeliveryIds: Object.freeze([...navigationDeliveryIds]), motoboyDevice, authenticated: true, mfaVerified: true,
      ...(fixturePersisted ? { mediaDirectory } : {}) });
  } catch (error) {
    lifecycleFailed = true;
    if (fixtureManifest) await fixtureManifest.update({ status: 'FAILED', databaseCommitted: committedForIndependentRequests || fixturePersisted,
      lastError: { name: error.name, code: error.code || null, message: 'E2E lifecycle failed; inspect restricted runner output.' },
      retentionReason: committedForIndependentRequests || fixturePersisted
        ? 'Falha após commit: fixtures retidas para inspeção; nenhuma limpeza automática foi executada.' : null }).catch(() => {});
    throw error;
  } finally {
    if (host) {
      // Browser E2E may leave keep-alive requests active while a tab or sync
      // retry is closing. The fixture is transaction-scoped; terminate those
      // test-only sockets so cleanup always reaches rollback and emits a final
      // result instead of hanging in server.close().
      await host.pauseAndDrain();
      host.server.closeAllConnections?.();
      await new Promise(resolve => host.server.close(resolve));
    }
    if (transactionOpen) {
      try { await runtime.query('ROLLBACK'); } catch (_) { /* retain original setup error */ }
    }
    if (independentPool) await independentPool.end().catch(() => {});
    if (connectedRuntime) await runtime.end();
    if (mediaDirectory && !fixturePersisted) await fs.rm(mediaDirectory, { recursive: true, force: true });
    if (fixtureManifest && fixtureTenantIds.length) {
      const tenantDatabaseCounts = [];
      await migrator.connect();
      try {
        await assertConnectedIdentity(migrator, { role: 'rotamoto_migrator', database: 'rotamoto_e2e', env });
        for (const tenantId of fixtureTenantIds) {
          const userIds = fixtureUserIds.filter(userId => fixtureTenantByUser.get(userId) === tenantId);
          await migrator.query('BEGIN READ ONLY');
          try {
            await migrator.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
            const result = await migrator.query(`SELECT
              (SELECT count(*)::int FROM rotamoto.companies WHERE id=$1) AS companies,
              (SELECT count(*)::int FROM rotamoto.users WHERE id=ANY($2::uuid[])) AS users,
              (SELECT count(*)::int FROM rotamoto.credentials WHERE user_id=ANY($2::uuid[])) AS auth_records,
              (SELECT count(*)::int FROM rotamoto.memberships WHERE company_id=$1) AS memberships,
              (SELECT count(*)::int FROM rotamoto.sessions WHERE user_id=ANY($2::uuid[])) AS sessions,
              (SELECT count(*)::int FROM rotamoto.domain_records WHERE company_id=$1) AS domain_records,
              (SELECT count(*)::int FROM rotamoto.sync_inbox WHERE company_id=$1) AS sync_inbox,
              (SELECT count(*)::int FROM rotamoto.sync_outbox WHERE company_id=$1) AS sync_outbox,
              (SELECT count(*)::int FROM rotamoto.audit_log WHERE company_id=$1) AS audit_log`, [tenantId, userIds]);
            if (!committedForIndependentRequests && !fixturePersisted) {
              assert(Object.values(result.rows[0]).every(value => value === 0),
                'rolled-back fixture leaves no database rows for its registered tenant');
            }
            tenantDatabaseCounts.push({ tenantId, counts: result.rows[0] });
          } finally { await migrator.query('ROLLBACK'); }
        }
        await fixtureManifest.update({ tenantDatabaseCounts });
      } finally { await migrator.end(); }
    }
    if (fixtureManifest && !lifecycleFailed) await fixtureManifest.update({
      status: committedForIndependentRequests || fixturePersisted ? 'RETAINED' : 'COMPLETED',
      databaseCommitted: committedForIndependentRequests || fixturePersisted,
      retentionReason: committedForIndependentRequests || fixturePersisted
        ? 'Execution completed; committed fixture and append-only audit rows remain retained.' : null });
    if (!fixturePersisted && committedForIndependentRequests && retainIndependentFixture) {
      await syncFixtureManifest({ databaseCommitted: true,
        retentionReason: 'Execução encerrada após commit; registros auditáveis e dependências permanecem retidos.' }).catch(() => {});
      onIndependentFixtureRetained?.({ runId: fixtureManifest?.runId, manifestPath: fixtureManifest?.file,
        tenantIds: [...new Set(fixtureTenantIds)], userIds: [...new Set(fixtureUserIds)] });
    }
    // Committed fixtures are never deleted by this helper. Eligibility and
    // dependency analysis belong to a separately authorized dry-run review.
    if (!fixturePersisted && !retainIndependentFixture && !fixtureManifest) {
    await migrator.connect();
    try {
      await assertConnectedIdentity(migrator, { role: 'rotamoto_migrator',
        database: disposableCampaign ? 'rotamoto_disposable_0068_source' : 'rotamoto_e2e', env });
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
}

module.exports = { runFixtureLifecycle, savepointPool };
