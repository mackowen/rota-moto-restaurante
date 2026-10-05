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
    invitation: { limit: 50, windowMs: 60000 }, provision: { limit: 50, windowMs: 60000 }, mfa: { limit: 50, windowMs: 60000 }, default: { limit: 1000, windowMs: 60000 } } });
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

async function runFixtureLifecycle({ env = process.env, exercise = async () => {}, allowedOrigins = [],
  persistDisposableFixture = false, mediaDirectory: requestedMediaDirectory } = {}) {
  const clients = createE2eClients(env); // Validate both exact targets before a socket/client is opened.
  const disposableCampaign = clients.migrator ? env.ROTAMOTO_DISPOSABLE_CAMPAIGN === '0068' : false;
  if (persistDisposableFixture && (!disposableCampaign || env.NODE_ENV !== 'test' ||
      requestedMediaDirectory !== path.resolve(requestedMediaDirectory || '') ||
      path.dirname(requestedMediaDirectory) !== os.tmpdir() ||
      !path.basename(requestedMediaDirectory).startsWith('rotamoto-disposable-source-media-'))) {
    throw new Error('Fixture persistente aceita somente diretório temporário e origem descartável da campanha 0068.');
  }
  const { runtime, migrator } = clients;
  let connectedRuntime = false;
  let transactionOpen = false;
  let host;
  let mediaDirectory;
  let companyId;
  let fixtureUserId;
  let fixtureEmail;
  let fixturePersisted = false;
  try {
    await runtime.connect(); connectedRuntime = true;
    const database = disposableCampaign ? 'rotamoto_disposable_0068_source' : 'rotamoto_e2e';
    await assertConnectedIdentity(runtime, { role: 'rotamoto_app', database, env });
    await runtime.query('BEGIN'); transactionOpen = true;
    const pool = savepointPool(runtime);
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
      emailProvider: createEmailDeliveryProvider(async message => { emails.push(message); return { accepted: true }; }),
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
    const syncHttp = createSyncHttpHandler({ identityService, syncService: createSyncService({ mediaStorage }), logger: () => {}, rateLimiter: limiter,
      allowedOrigin: originConfig });
    const queryHttp = createDomainQueryHttpHandler({ identityService,
      queryService: createDomainQueryService({ repository: createDomainQueryRepository() }), logger: () => {}, rateLimiter: limiter });
    host = await start([identityHttp, adminHttp, proofHttp, syncHttp, queryHttp]);

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
    const futureCode=codeAt(enrollment.body.secret,Math.floor(Date.now()/30000)+1);
    const invalidMfa = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId,
      mfaCode: String((Number(futureCode) + 1) % 1000000).padStart(6, '0') } });
    assert.equal(invalidMfa.status, 403, 'invalid native MFA proof cannot create an authenticated fixture');
    const replayCode=await call('/api/identity/login',{method:'POST',body:{email,password,companyId,mfaCode:currentCode}});
    assert.equal(replayCode.status,403,'the TOTP counter accepted during enrollment cannot be replayed');
    const login = await call('/api/identity/login', { method: 'POST', body: { email, password, companyId, mfaCode: futureCode } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const sessionCookie = login.headers.get('set-cookie').split(';', 1)[0];
    assert(sessionCookie.startsWith(`${COOKIE_NAME}=`));
    const session = await call('/api/identity/session', { cookie: sessionCookie });
    assert.equal(session.status, 200);
    assert.equal(session.body.mfaVerified, true);
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
    await runtime.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
    const canonicalProof=await runtime.query("SELECT payload,related_entity_type,related_record_id::text FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,canonicalProofId]);
    assert.equal(canonicalProof.rowCount,1,'accepted proof has canonical PostgreSQL metadata');
    assert.equal(canonicalProof.rows[0].related_record_id,deliveryId);
    const uploadIntent=await runtime.query('SELECT 1 FROM rotamoto.proof_media_upload_intents WHERE company_id=$1 AND proof_id=$2',[companyId,proofId]);
    assert.equal(uploadIntent.rowCount,0,'sync consumes the staged upload intent atomically with canonical metadata');
    const gcResult=await runProofMediaGc({pool,objectStore,now:()=>new Date(Date.now()+120_000),graceMs:60_000,dryRun:false,log:()=>{}});
    assert.equal(gcResult.skipped,1,'GC confirms canonical reference and preserves synced media');
    const proofRead = await fetch(`${host.base}/api/domain/deliveries/${deliveryId}/proofs/${canonicalProofId}/media`, {
      headers: { Origin: allowedOrigins[0] || host.base, Cookie: sessionCookie } });
    assert.equal(proofRead.status, 200, await proofRead.clone().text());
    assert.equal(Buffer.from(await proofRead.arrayBuffer()).toString('hex'), png.toString('hex'));

    const authenticatedCall = (path, options = {}) => call(path, { ...options,
      cookie: options.cookie || sessionCookie, csrf: options.csrf === undefined ? csrf : options.csrf });
    await exercise(Object.freeze({ companyId, userId: accepted.body.userId, membershipId: membership.membershipId,
      driverId, orderId, deliveryId, email, password, mfaCode: futureCode, apiOrigin: host.base, runtime, call, authenticatedCall }));
    const recoveryRequest = await call('/api/identity/recovery', { method: 'POST', body: { email } });
    assert.equal(recoveryRequest.status, 202, JSON.stringify(recoveryRequest.body));
    assert.equal(JSON.stringify(recoveryRequest.body).includes(emails[1].token), false,
      'recovery token is delivered out of band and never returned by the API');
    const recoveredPassword = `E2E-recovered-${crypto.randomBytes(24).toString('base64url')}`;
    const recoveryConsumed = await call('/api/identity/recovery/consume', { method: 'POST',
      body: { token: emails[1].token, password: recoveredPassword } });
    assert.equal(recoveryConsumed.status, 204);
    const passwordRecoveryReplay = await call('/api/identity/recovery/consume', { method: 'POST',
      body: { token: emails[1].token, password: recoveredPassword } });
    assert.equal(passwordRecoveryReplay.status, 401, 'password recovery token is one-time');
    if (persistDisposableFixture) {
      await runtime.query('COMMIT'); transactionOpen = false; fixturePersisted = true;
    }
    return Object.freeze({ companyId, userId: accepted.body.userId, membershipId: membership.membershipId,
      driverId, orderId, deliveryId, authenticated: true, mfaVerified: true,
      ...(fixturePersisted ? { mediaDirectory } : {}) });
  } finally {
    if (host) await new Promise(resolve => host.server.close(resolve));
    if (transactionOpen) {
      try { await runtime.query('ROLLBACK'); } catch (_) { /* retain original setup error */ }
    }
    if (connectedRuntime) await runtime.end();
    if (mediaDirectory && !fixturePersisted) await fs.rm(mediaDirectory, { recursive: true, force: true });
    if (!fixturePersisted) {
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
