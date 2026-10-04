'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Client } = require('pg');
const { createIdentityService, tokenDigest } = require('../backend/identity/service');
const { COOKIE_NAME, createRateLimiter } = require('../backend/identity/http');
const { createSyncService } = require('../backend/domain/sync-service');
const { createSyncHttpHandler } = require('../backend/domain/sync-http');
const { createDomainQueryRepository } = require('../backend/domain/query-repository');
const { createDomainQueryService } = require('../backend/domain/query-service');
const { createDomainQueryHttpHandler } = require('../backend/domain/query-http');
const { createAdminRepository } = require('../backend/admin/repository');
const { createAdminService } = require('../backend/admin/service');
const { createAdminHttpHandler } = require('../backend/admin/http');

function savepointPool(client) {
  let counter = 0;
  const stack = [];
  return { async connect() {
    return {
      async query(sql, values) {
        const command = sql.trim().toUpperCase();
        if (command === 'BEGIN') {
          const name = `domain_sync_${++counter}`;
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

async function main() {
  if (!process.env.DATABASE_URL || !process.env.MIGRATOR_DATABASE_URL) {
    throw new Error('DATABASE_URL (runtime) e MIGRATOR_DATABASE_URL (status de migrations) são obrigatórias.');
  }
  assert.equal(decodeURIComponent(new URL(process.env.DATABASE_URL).username), 'rotamoto_app');
  assert.equal(decodeURIComponent(new URL(process.env.MIGRATOR_DATABASE_URL).username), 'rotamoto_migrator');
  const migrator = new Client({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await migrator.connect();
  await client.connect();
  try {
    const migration = await migrator.query("SELECT migration_id FROM rotamoto.schema_migrations WHERE migration_id='0009_domain_model_constraints'");
    assert.equal(migration.rowCount, 1, 'canonical model constraints migration is applied by the migrator');
    assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'rotamoto_app');
    await client.query('BEGIN');
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const readOnlyUserId = crypto.randomUUID();
    const readOnlyRoleId = crypto.randomUUID();
    const readOnlyMembershipId = crypto.randomUUID();
    const readOnlySessionId = crypto.randomUUID();
    const readOnlyToken = crypto.randomBytes(32).toString('base64url');
    const readOnlyCsrf = crypto.randomBytes(32).toString('base64url');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query("INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Synthetic domain sync','active')", [companyId]);
    await client.query('INSERT INTO rotamoto.users(id,email) VALUES($1,$2)', [userId, `domain-sync-${userId}@example.invalid`]);
    await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'qa-sync','Synthetic sync role')", [roleId, companyId]);
    await client.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
      VALUES($1,$2,'sync.push',1),($1,$2,'sync.pull',1),($1,$2,'orders.read',1),
        ($1,$2,'company.manage',1),($1,$2,'members.read',1),($1,$2,'integrations.manage',1)`, [companyId, roleId]);
    await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at) VALUES($1,$2,$3,$4,'active',now())", [membershipId, companyId, userId, roleId]);
    await client.query(`INSERT INTO rotamoto.sessions(id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,idle_expires_at,absolute_expires_at,mfa_verified_at)
      VALUES($1,$2,$3,$4,$5,now(),now(),now()+interval '30 minutes',now()+interval '12 hours',now())`,
    [sessionId, userId, companyId, tokenDigest(sessionToken), tokenDigest(csrfToken)]);
    await client.query('INSERT INTO rotamoto.users(id,email) VALUES($1,$2)', [readOnlyUserId, `domain-sync-readonly-${readOnlyUserId}@example.invalid`]);
    await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'qa-no-sync','Synthetic no-sync role')", [readOnlyRoleId, companyId]);
    await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at) VALUES($1,$2,$3,$4,'active',now())", [readOnlyMembershipId, companyId, readOnlyUserId, readOnlyRoleId]);
    await client.query(`INSERT INTO rotamoto.sessions(id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES($1,$2,$3,$4,$5,now(),now(),now()+interval '30 minutes',now()+interval '12 hours')`,
    [readOnlySessionId, readOnlyUserId, companyId, tokenDigest(readOnlyToken), tokenDigest(readOnlyCsrf)]);

    const identityService = createIdentityService({ pool: savepointPool(client) });
    const syncService = createSyncService();
    const queryService = createDomainQueryService({ repository: createDomainQueryRepository() });
    const adminService = createAdminService({ repository: createAdminRepository() });
    const logs = [];
    const handler = createSyncHttpHandler({ identityService, syncService, logger: value => logs.push(value),
      rateLimiter: createRateLimiter({ policies: { default: { limit: 100, windowMs: 60000 } } }) });
    const queryHttp = createDomainQueryHttpHandler({ identityService, queryService,
      rateLimiter: createRateLimiter({ policies: { default: { limit: 100, windowMs: 60000 } } }), logger: value => logs.push(value) });
    const adminHttp = createAdminHttpHandler({ identityService, adminService,
      rateLimiter: createRateLimiter({ policies: { default: { limit: 100, windowMs: 60000 } } }), logger: value => logs.push(value) });
    const server = http.createServer(async (req, res) => {
      req.requestId = crypto.randomUUID();
      if (await adminHttp(req, res)) return;
      if (await queryHttp(req, res)) return;
      return handler(req, res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = `${COOKIE_NAME}=${sessionToken}`;
    const call = async (path, { method = 'GET', body, csrf = csrfToken, headers = {}, cookie: requestCookie = cookie } = {}) => {
      const response = await fetch(base + path, { method, headers: { Cookie: requestCookie, Origin: base,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
    };
    const registerDevice = async (appKey, deviceId) => call(`/api/sync/installations/${appKey}`, {
      method: 'POST', body: { deviceId }
    });
    try {
      const badCsrf = await call('/api/sync/push', { method: 'POST', csrf: 'invalid', body: {} });
      assert.equal(badCsrf.status, 403);
      assert.equal(badCsrf.body.error.code, 'CSRF_INVALID');
      const invalidPacket = await call('/api/sync/push', { method: 'POST', body: { protocol: 'wrong' } });
      assert.equal(invalidPacket.status, 400);
      assert.equal(invalidPacket.body.error.code, 'INVALID_INPUT');
      const restaurantInstall = await registerDevice('restaurante', 'restaurant-test-device');
      assert.equal(restaurantInstall.status, 200, JSON.stringify(restaurantInstall.body));
      assert.equal(restaurantInstall.body.appKey, 'restaurante');
      const repeatInstall = await registerDevice('restaurante', 'restaurant-test-device');
      assert.equal(repeatInstall.body.installationId, restaurantInstall.body.installationId, 'installation registration is idempotent for its owning user');
      const missingDeviceId = await call('/api/sync/pull');
      assert.equal(missingDeviceId.status, 400);
      const deniedPull = await call('/api/sync/pull?deviceId=unauthorized-device', { cookie: `${COOKIE_NAME}=${readOnlyToken}` });
      assert.equal(deniedPull.status, 403);
      assert.equal(deniedPull.body.error.code, 'FORBIDDEN');
      await client.query("INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version) VALUES($1,$2,'sync.pull',1),($1,$2,'sync.push',1)", [companyId, readOnlyRoleId]);
      const crossInstallPull = await call('/api/sync/pull?deviceId=restaurant-test-device', { cookie: `${COOKIE_NAME}=${readOnlyToken}` });
      assert.equal(crossInstallPull.status, 409);
      assert.equal(crossInstallPull.body.error.code, 'INSTALLATION_REQUIRED', 'another tenant member cannot use a registered installation');
      const crossInstallRegister = await call('/api/sync/installations/restaurante', { method: 'POST', csrf: readOnlyCsrf,
        body: { deviceId: 'restaurant-test-device' }, cookie: `${COOKIE_NAME}=${readOnlyToken}` });
      assert.equal(crossInstallRegister.status, 403);
      assert.equal(crossInstallRegister.body.error.code, 'INSTALLATION_FORBIDDEN');
      const baseTime = new Date(Date.now() - 5000).toISOString();
      const packet = { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
        packetId: `pkt_${crypto.randomUUID()}`, deviceId: 'restaurant-test-device', companyId: crypto.randomUUID(),
        source: { app: 'RotaMoto Restaurante', deviceId: 'restaurant-test-device' }, createdAt: baseTime,
        data: { orders: [{ id: 'order-local-1', createdAt: baseTime, updatedAt: baseTime, version: 1, status: 'CREATED', customer: 'Sintético' }],
          deliveries: [{ id: 'delivery-local-1', orderId: 'order-local-1', status: 'ASSIGNED', operationNote: 'preserve me',
            createdAt: baseTime, updatedAt: baseTime, version: 1 }],
          drivers: [], routes: [], locationUpdates: [], deliveryEvents: [{ id: 'event-local-1', eventId: 'event-local-1',
            entity: 'order', entityId: 'order-local-1', type: 'ORDER_CREATED', occurredAt: baseTime, actor: { type: 'user' } }],
          proofs: [], earnings: [{ id: 'earning-local-1', deliveryId: 'delivery-local-1', amount: 12.5,
            currency: 'BRL', components: [{code:'delivery_fee',amountMinor:1250}], ruleVersion: 'fees-v1',
            createdAt: baseTime, updatedAt: baseTime, version: 1 }], tombstones: [] } };
      const pushed = await call('/api/sync/push', { method: 'POST', body: packet });
      assert.equal(pushed.status, 200, JSON.stringify({ response: pushed.body, logs }));
      assert.equal(pushed.body.companyId, companyId, 'tenant comes from the authenticated session, not packet.companyId');
      assert.equal(pushed.body.received, 4, JSON.stringify(pushed.body.operationResults));
      assert.equal(pushed.body.operationResults.length, 4, 'ACK identifies each operation');
      assert(pushed.body.operationResults.every(result => result.status === 'accepted' && result.canonicalId && result.canonicalVersion === 1));
      const duplicate = await call('/api/sync/push', { method: 'POST', body: packet });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.duplicate, true);
      assert(duplicate.body.operationResults.every(result => result.status === 'duplicate'));
      const orderId = pushed.body.aliases.find(alias => alias.entity === 'Order').canonicalId;
      const deliveryId = pushed.body.aliases.find(alias => alias.entity === 'Delivery').canonicalId;
      const earningId = pushed.body.aliases.find(alias => alias.entity === 'Earning').canonicalId;
      assert.match(orderId, /^[0-9a-f-]{36}$/iu);
      assert.match(deliveryId, /^[0-9a-f-]{36}$/iu);
      assert.match(earningId, /^[0-9a-f-]{36}$/iu);
      assert.notEqual(orderId, 'order-local-1');
      const domainOrders = await call('/api/domain/orders?limit=1');
      assert.equal(domainOrders.status, 200, JSON.stringify(domainOrders.body));
      assert.equal(domainOrders.body.records.length, 1);
      assert.equal(domainOrders.body.records[0].id, orderId);
      assert.equal(domainOrders.body.records[0].version, 1);
      assert.match(domainOrders.headers.get('x-request-id'), /^[0-9a-f-]{36}$/iu);
      const ownDelivery = await call(`/api/domain/deliveries/${deliveryId}`);
      assert.equal(ownDelivery.status, 200);
      assert.equal(ownDelivery.body.record.status, 'ASSIGNED');
      const hiddenTombstone = await call(`/api/domain/deliveries/${crypto.randomUUID()}`);
      assert.equal(hiddenTombstone.status, 404, 'canonical IDs outside this tenant are indistinguishable from missing records');
      const invalidDomainQuery = await call('/api/domain/orders?companyId=' + companyId);
      assert.equal(invalidDomainQuery.status, 400);
      assert.equal(invalidDomainQuery.body.error.code, 'INVALID_INPUT');
      const invalidDomainCursor = await call('/api/domain/orders?cursor=' + Buffer.from(`2025-02-30T12:00:00.000000Z\n${crypto.randomUUID()}`).toString('base64url'));
      assert.equal(invalidDomainCursor.status, 400, 'malformed calendar dates in opaque cursors are rejected as input');
      const duplicateSessionCookie = await call('/api/domain/orders', { headers: { Cookie: `${cookie}; ${cookie}` } });
      assert.equal(duplicateSessionCookie.status, 401, 'ambiguous duplicate session cookies fail closed');
      assert.equal((await call('/api/domain/unsupported')).body.error.code, 'NOT_FOUND');
      assert.equal((await call('/api/sync/unsupported')).body.error.code, 'NOT_FOUND');
      assert.equal((await call('/api/domain/orders', { cookie: `${COOKIE_NAME}=${readOnlyToken}` })).status, 403,
        'domain query requires explicit permission');
      const companyView = await call('/api/admin/company');
      assert.equal(companyView.status, 200);
      assert.equal(companyView.body.id, companyId);
      const membershipView = await call('/api/admin/memberships?limit=1');
      assert.equal(membershipView.status, 200);
      assert.equal(membershipView.body.members.length, 1);
      assert(membershipView.body.members[0].email.includes('@example.invalid'));
      const rolesView = await call('/api/admin/roles');
      assert.equal(rolesView.status, 200);
      assert(rolesView.body.roles.find(role => role.key === 'qa-sync').permissions.includes('orders.read'));
      const integrationView = await call('/api/admin/integrations');
      assert.equal(integrationView.status, 200);
      assert.equal(JSON.stringify(integrationView.body).includes('secret_ref'), false);
      const deniedMembershipView = await call('/api/admin/memberships', { cookie: `${COOKIE_NAME}=${readOnlyToken}` });
      assert.equal(deniedMembershipView.status, 403);
      const methodError = await call('/api/sync/push');
      assert.equal(methodError.status, 405);
      assert.equal(methodError.body.error.code, 'METHOD_NOT_ALLOWED');
      assert.match(methodError.body.requestId, /^[0-9a-f-]{36}$/iu);
      const stored = await client.query(`SELECT d.payload,d.related_record_id::text,d.related_entity_type,o.payload AS order_payload
        FROM rotamoto.domain_records d JOIN rotamoto.domain_records o ON o.company_id=d.company_id AND o.record_id=d.related_record_id
        WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Delivery'`, [companyId, deliveryId]);
      assert.equal(stored.rowCount, 1);
      assert.equal(stored.rows[0].related_record_id, orderId);
      assert.equal(stored.rows[0].related_entity_type, 'Order');
      assert.equal(stored.rows[0].payload.orderId, orderId, 'references in payload use canonical IDs');
      assert.equal(stored.rows[0].payload.companyId, companyId, 'client tenant was overwritten by session tenant');
      const storedEarning = await client.query("SELECT payload->>'amountMinor' AS amount_minor,payload->>'currency' AS currency,payload->>'deliveryId' AS delivery_id,payload->>'ruleVersion' AS rule_version,payload->'components' AS components,related_record_id::text FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Earning'", [companyId, earningId]);
      assert.equal(storedEarning.rows[0].amount_minor, '1250');
      assert.equal(storedEarning.rows[0].currency, 'BRL');
      assert.equal(storedEarning.rows[0].rule_version, 'fees-v1');
      assert.deepEqual(storedEarning.rows[0].components, [{code:'delivery_fee',amountMinor:1250}]);
      assert.equal(storedEarning.rows[0].delivery_id, deliveryId);
      assert.equal(storedEarning.rows[0].related_record_id, deliveryId);
      const riderInstall=await registerDevice('motoboy','moto-proof-test-device');
      assert.equal(riderInstall.status,200);
      const proofPacket={...packet,packetId:`pkt_${crypto.randomUUID()}`,deviceId:'moto-proof-test-device',source:{app:'Rota Moto',deviceId:'moto-proof-test-device'},data:{...packet.data,orders:[],deliveries:[],deliveryEvents:[],earnings:[],proofs:[{
        id:'proof-local-1',deliveryId:'delivery-local-1',createdAt:baseTime,
        media:{mimeType:'image/png',sizeBytes:8,sha256:'a'.repeat(64),storageRef:{provider:'unconfigured',objectKey:'synthetic/ref'}}
      }]}};
      const proofWithoutProvider=await call('/api/sync/push',{method:'POST',body:proofPacket});
      assert.equal(proofWithoutProvider.body.operationResults[0].status,'rejected');
      assert.equal(proofWithoutProvider.body.operationResults[0].error.code,'MEDIA_STORAGE_UNAVAILABLE',
        'canonical proof reference fails closed until a real blob provider validates it');
      const routePacket={...packet,packetId:`pkt_${crypto.randomUUID()}`,data:{...packet.data,orders:[],deliveries:[],deliveryEvents:[],earnings:[],routes:[{id:'route-local-1',deliveryIds:['delivery-local-1'],createdAt:baseTime,updatedAt:baseTime,version:1}]}};
      const routePush=await call('/api/sync/push',{method:'POST',body:routePacket});
      assert.equal(routePush.status,200);
      assert.equal(routePush.body.operationResults[0].status,'accepted');
      const canonicalRouteId=routePush.body.operationResults[0].canonicalId;
      const canonicalRoute=await client.query("SELECT payload->'deliveryIds' AS delivery_ids FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Route'",[companyId,canonicalRouteId]);
      assert.deepEqual(canonicalRoute.rows[0].delivery_ids,[deliveryId],'Route stores canonical Delivery IDs without a redundant inverse field');
      const overlappingRoute={...routePacket,packetId:`pkt_${crypto.randomUUID()}`,data:{...routePacket.data,routes:[{id:'route-local-2',deliveryIds:['delivery-local-1'],createdAt:baseTime,updatedAt:baseTime,version:1}]}};
      const routeConflict=await call('/api/sync/push',{method:'POST',body:overlappingRoute});
      assert.equal(routeConflict.status,200);
      assert.equal(routeConflict.body.operationResults[0].status,'conflict');
      assert.equal(routeConflict.body.operationResults[0].error.code,'ROUTE_DELIVERY_ALREADY_ACTIVE');
      const secretPacket = { ...packet, packetId: `pkt_${crypto.randomUUID()}`,
        data: { ...packet.data, orders: [{ ...packet.data.orders[0], accessToken: 'synthetic-secret-marker' }], deliveries: [] } };
      const secretRejected = await call('/api/sync/push', { method: 'POST', body: secretPacket });
      assert.equal(secretRejected.status, 400);
      assert.equal(JSON.stringify(secretRejected.body).includes('synthetic-secret-marker'), false,
        'credential values are rejected and never echoed');
      const event = await client.query(`SELECT record_id::text,related_entity_type,related_record_id::text FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type='DeliveryEvent'`, [companyId]);
      assert.equal(event.rowCount, 1);
      assert.equal(event.rows[0].related_entity_type, 'Order');
      assert.equal(event.rows[0].related_record_id, orderId);
      await client.query('SAVEPOINT immutable_event');
      await assert.rejects(client.query("UPDATE rotamoto.domain_records SET payload='{}'::jsonb WHERE company_id=$1 AND record_id=$2",
        [companyId, event.rows[0].record_id]), /DeliveryEvent é um fato imutável/);
      await client.query('ROLLBACK TO SAVEPOINT immutable_event');
      await client.query('RELEASE SAVEPOINT immutable_event');

      const pull = await call('/api/sync/pull?limit=1&deviceId=restaurant-test-device');
      assert.equal(pull.status, 200);
      assert.equal(pull.body.protocol, 'rotamoto-sync');
      assert.equal(pull.body.events.length, 1);
      assert.equal(pull.body.hasMore, true);
      const next = await call(`/api/sync/pull?limit=1&deviceId=restaurant-test-device&cursor=${encodeURIComponent(pull.body.nextCursor)}`);
      assert.equal(next.status, 200);
      assert.equal(next.body.events.length, 1);
      assert.notEqual(next.body.events[0].eventId, pull.body.events[0].eventId);
      const finalPage = await call(`/api/sync/pull?limit=1&deviceId=restaurant-test-device&cursor=${encodeURIComponent(next.body.nextCursor)}`);
      assert.equal(finalPage.status, 200);
      assert.equal(finalPage.body.events.length, 1);
      assert.equal(finalPage.body.hasMore, true);
      const lastPage = await call(`/api/sync/pull?limit=1&deviceId=restaurant-test-device&cursor=${encodeURIComponent(finalPage.body.nextCursor)}`);
      assert.equal(lastPage.status, 200);
      assert.equal(lastPage.body.events.length, 1);
      assert.equal(lastPage.body.hasMore, true);
      const endPage=await call(`/api/sync/pull?limit=1&deviceId=restaurant-test-device&cursor=${encodeURIComponent(lastPage.body.nextCursor)}`);
      assert.equal(endPage.status,200);
      assert.equal(endPage.body.events.length,1);
      assert.equal(endPage.body.hasMore,false);
      assert.equal(new Set([pull.body.events[0].eventId,next.body.events[0].eventId,finalPage.body.events[0].eventId,lastPage.body.events[0].eventId,endPage.body.events[0].eventId]).size,5,
        'microsecond keyset cursor returns every outbox event exactly once');

      const riderTime = new Date(Date.now() + 2000).toISOString();
      const motoInstall = await registerDevice('motoboy', 'rider-test-device');
      assert.equal(motoInstall.status, 200);
      const riderPacket = { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
        packetId: `pkt_${crypto.randomUUID()}`, deviceId: 'rider-test-device', companyId: crypto.randomUUID(),
        source: { app: 'RotaMoto', deviceId: 'rider-test-device' }, createdAt: riderTime,
        data: { orders: [], deliveries: [{ id: 'delivery-rider-local', orderId: 'order-local-1', status: 'ASSIGNED', driverId: 'forged-driver',
          createdAt: baseTime, updatedAt: riderTime, version: 2, baseVersion: 1 }], drivers: [], routes: [], locationUpdates: [],
          deliveryEvents: [], proofs: [], earnings: [], tombstones: [], races: [], settings: { driverId: 'synthetic' } } };
      const riderPush = await call('/api/sync/push', { method: 'POST', body: riderPacket });
      assert.equal(riderPush.status, 200, JSON.stringify(riderPush.body));
      assert.equal(riderPush.body.operationResults[0].status, 'rejected', 'Motoboy cannot overwrite the planned driver assignment');
      const mergedDelivery = await client.query("SELECT payload->>'status' AS status,payload->>'operationNote' AS operation_note FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",
        [companyId, deliveryId]);
      assert.equal(mergedDelivery.rows[0].status, 'ASSIGNED');
      assert.equal(mergedDelivery.rows[0].operation_note, 'preserve me', 'partial cross-app revision preserves absent fields');

      const eventId = event.rows[0].record_id;
      const secondInstall = await registerDevice('restaurante', 'restaurant-second-device');
      assert.equal(secondInstall.status, 200);
      const eventRetry = { ...packet, packetId: `pkt_${crypto.randomUUID()}`, deviceId: 'restaurant-second-device',
        source: { app: 'RotaMoto Restaurante', deviceId: 'restaurant-second-device' },
        data: { orders: [], deliveries: [], drivers: [], routes: [], locationUpdates: [],
          deliveryEvents: [{ id: 'event-local-1', eventId: 'event-local-1', entity: 'order', entityId: 'order-local-1',
            type: 'ORDER_CREATED', occurredAt: baseTime, actor: { type: 'user' } }], proofs: [], earnings: [], tombstones: [] } };
      const eventRetryResult = await call('/api/sync/push', { method: 'POST', body: eventRetry });
      assert.equal(eventRetryResult.status, 200, JSON.stringify(eventRetryResult.body));
      assert.equal(eventRetryResult.body.aliases[0].canonicalId, eventId, 'eventId deduplicates across installations');
      assert.equal(eventRetryResult.body.operationResults[0].status, 'duplicate');

      const invalidTransition = structuredClone(packet);
      invalidTransition.packetId = `pkt_${crypto.randomUUID()}`;
      invalidTransition.data.orders = [];
      invalidTransition.data.deliveries[0] = { ...invalidTransition.data.deliveries[0], status: 'DELIVERED', version: 2,
        updatedAt: new Date(Date.now() + 5000).toISOString() };
      const transitionResult = await call('/api/sync/push', { method: 'POST', body: invalidTransition });
      assert.equal(transitionResult.status, 200);
      assert.equal(transitionResult.body.operationResults[0].status, 'rejected');
      assert.equal(transitionResult.body.operationResults[0].error.code, 'FORBIDDEN_FIELD');
      const unchanged = await client.query('SELECT payload->>\'status\' AS status FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2', [companyId, deliveryId]);
      assert.equal(unchanged.rows[0].status, 'ASSIGNED', 'restaurant cannot rewrite execution state');

      const invalidMotoTransition = { ...riderPacket, packetId: `pkt_${crypto.randomUUID()}`,
        data: { ...riderPacket.data, deliveries: [], deliveryEvents: [{ eventId: `evt_${crypto.randomUUID()}`, entity: 'delivery',
          entityId: deliveryId, type: 'DELIVERY_COMPLETED', occurredAt: new Date(Date.now() + 7000).toISOString() }] } };
      const invalidMotoResult = await call('/api/sync/push', { method: 'POST', body: invalidMotoTransition });
      assert.equal(invalidMotoResult.status, 200);
      assert.equal(invalidMotoResult.body.operationResults[0].status, 'conflict');
      assert.equal(invalidMotoResult.body.operationResults[0].error.code, 'INVALID_TRANSITION');
      assert.equal(invalidMotoResult.body.operationResults[0].canonicalVersion, undefined, 'a rejected first event has no canonical revision');

      const startEvent = { eventId: `evt_${crypto.randomUUID()}`, entity: 'delivery', entityId: deliveryId,
        type: 'DELIVERY_STARTED', occurredAt: new Date(Date.now() + 8000).toISOString(), actor: { type: 'driver', id: 'spoofed-driver' } };
      const executionPacket = { ...riderPacket, packetId: `pkt_${crypto.randomUUID()}`,
        data: { ...riderPacket.data, deliveries: [], deliveryEvents: [startEvent], earnings: [{ id: 'moto-earning-event', deliveryId, amount: 999 }] } };
      const executionResult = await call('/api/sync/push', { method: 'POST', body: executionPacket });
      assert.equal(executionResult.status, 200);
      assert.equal(executionResult.body.operationResults.find(result => result.entity === 'Earning').status, 'rejected');
      const acceptedExecutionEvent = executionResult.body.operationResults.find(result => result.entity === 'DeliveryEvent');
      assert.equal(acceptedExecutionEvent.status, 'accepted', JSON.stringify(executionResult.body.operationResults));
      assert.equal(acceptedExecutionEvent.canonicalVersion, 1);
      const projectedDelivery = await client.query("SELECT payload->>'status' AS status,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2", [companyId, deliveryId]);
      assert.equal(projectedDelivery.rows[0].status, 'OUT_FOR_DELIVERY', 'execution event updates the canonical Delivery projection');
      assert.equal(Number(projectedDelivery.rows[0].version), 2);
      const riderSecondInstall = await registerDevice('motoboy', 'rider-second-device');
      assert.equal(riderSecondInstall.status, 200);
      const eventRetryPacket = { ...executionPacket, packetId: `pkt_${crypto.randomUUID()}`, deviceId: 'rider-second-device',
        source: { app: 'RotaMoto Restaurante', deviceId: 'rider-second-device' }, data: { ...executionPacket.data, earnings: [] } };
      const eventDuplicate = await call('/api/sync/push', { method: 'POST', body: eventRetryPacket });
      assert.equal(eventDuplicate.body.operationResults[0].status, 'duplicate', 'eventId is idempotent across app installations');

      const changedRetry = structuredClone(packet);
      changedRetry.data.orders[0].customer = 'conteúdo divergente';
      const idempotencyConflict = await call('/api/sync/push', { method: 'POST', body: changedRetry });
      assert.equal(idempotencyConflict.status, 409, 'packetId reuse with different content is rejected');

      const wrongOwnerPacket = { ...packet, packetId: `pkt_${crypto.randomUUID()}`, source: { app: 'RotaMoto Restaurante', deviceId: 'rider-test-device' },
        deviceId: 'rider-test-device', data: { ...packet.data, deliveries: [], deliveryEvents: [], orders: [{ id: 'foreign-order',
          createdAt: baseTime, updatedAt: baseTime, version: 1 }], earnings: [{ id: 'moto-earning', deliveryId: 'delivery-local-1', amount: 99 }] } };
      const wrongOwner = await call('/api/sync/push', { method: 'POST', body: wrongOwnerPacket });
      assert.equal(wrongOwner.status, 200, 'operation ownership failures return explicit per-operation ACK');
      assert.equal(wrongOwner.body.operationResults[0].status, 'rejected', 'source.app spoofing does not authorize Restaurant writes');
      assert.equal(wrongOwner.body.operationResults[0].error.code, 'FORBIDDEN');
      assert.equal(wrongOwner.body.operationResults[1].entity, 'Earning');
      assert.equal(wrongOwner.body.operationResults[1].status, 'rejected', 'Motoboy cannot publish canonical Earning');

      const tombstonePacket = { ...packet, packetId: `pkt_${crypto.randomUUID()}`, data: { ...packet.data, orders: [], deliveries: [],
        tombstones: [{ store: 'deliveries', id: 'delivery-local-1', deleted: true,
          deletedAt: new Date(Date.now() + 3000).toISOString(), updatedAt: new Date(Date.now() + 3000).toISOString(), version: 3, baseVersion: 2 }] } };
      const tombstoneResult = await call('/api/sync/push', { method: 'POST', body: tombstonePacket });
      assert.equal(tombstoneResult.status, 200, JSON.stringify(tombstoneResult.body));
      assert.equal(tombstoneResult.body.operationResults.find(result => result.operation === 'tombstones:0').status, 'accepted');
      const tombstoneState = await client.query('SELECT deleted_at,payload->>\'deleted\' AS deleted FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2', [companyId, deliveryId]);
      assert.equal(tombstoneState.rows[0].deleted, 'true');
      assert(tombstoneState.rows[0].deleted_at);

      const spoofedCompany = crypto.randomUUID();
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [spoofedCompany]);
      const hidden = await client.query('SELECT 1 FROM rotamoto.domain_records WHERE record_id=$1', [deliveryId]);
      assert.equal(hidden.rowCount, 0, 'RLS hides another tenant canonical rows');
      await client.query("SELECT set_config('app.tenant_id','',true)");
      const defaultDeny = await client.query('SELECT 1 FROM rotamoto.domain_records WHERE record_id=$1', [deliveryId]);
      assert.equal(defaultDeny.rowCount, 0, 'missing tenant context is default-deny');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
      const noDdl = await client.query(`SELECT has_table_privilege(current_user,'rotamoto.domain_records','DELETE') AS delete_domain,
        has_table_privilege(current_user,'rotamoto.local_id_maps','UPDATE') AS update_mapping,
        has_table_privilege(current_user,'rotamoto.sync_outbox','INSERT') AS insert_outbox`);
      assert.deepEqual(noDdl.rows[0], { delete_domain: false, update_mapping: false, insert_outbox: true });
      assert(logs.every(entry => !Object.hasOwn(entry, 'payload') && !Object.hasOwn(entry, 'companyId')),
        'sync logs contain request metadata only');
      const rateLimitInstall = await registerDevice('restaurante', 'rate-limit-device');
      assert.equal(rateLimitInstall.status, 200);
      const limitedServer = http.createServer(createSyncHttpHandler({ identityService, syncService,
        rateLimiter: createRateLimiter({ policies: { default: { limit: 1, windowMs: 60000 } } }) }));
      await new Promise(resolve => limitedServer.listen(0, '127.0.0.1', resolve));
      try {
        const limitedUrl = `http://127.0.0.1:${limitedServer.address().port}/api/sync/pull?deviceId=rate-limit-device`;
        const limitedHeaders = { Cookie: cookie };
        assert.equal((await fetch(limitedUrl, { headers: limitedHeaders })).status, 200);
        const limited = await fetch(limitedUrl, { headers: limitedHeaders });
        assert.equal(limited.status, 429, 'sync pull is rate limited by endpoint and IP');
      } finally {
        await new Promise(resolve => limitedServer.close(resolve));
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    await client.query('ROLLBACK');
    await migrator.query('BEGIN');
    await migrator.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    const leftovers = await migrator.query("SELECT count(*)::int AS count FROM rotamoto.companies WHERE id=$1", [companyId]);
    await migrator.query('ROLLBACK');
    assert.equal(leftovers.rows[0].count, 0, 'synthetic tenant and domain rows were rolled back');
    console.log('PostgreSQL canonical domain and sync API tests: OK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
    await migrator.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
