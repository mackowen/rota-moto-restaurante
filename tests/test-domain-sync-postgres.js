'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createClient } = require('../backend/postgres/connection');
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
  const migrator = createClient({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  const client = createClient({ connectionString: process.env.DATABASE_URL });
  await migrator.connect();
  await client.connect();
  try {
    const migration = await migrator.query("SELECT migration_id FROM rotamoto.schema_migrations WHERE migration_id='0009_domain_model_constraints'");
    assert.equal(migration.rowCount, 1, 'canonical model constraints migration is applied by the migrator');
    const driverBindingMigration = await migrator.query("SELECT migration_id FROM rotamoto.schema_migrations WHERE migration_id='0013_membership_driver_binding'");
    assert.equal(driverBindingMigration.rowCount, 1, 'membership↔Driver binding migration is applied by the migrator');
    assert.equal((await client.query('SELECT current_user AS role')).rows[0].role, 'rotamoto_app');
    await client.query('BEGIN');
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const roleId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    let csrfToken = crypto.randomBytes(32).toString('base64url');
    const readOnlyUserId = crypto.randomUUID();
    const readOnlyRoleId = crypto.randomUUID();
    const readOnlyMembershipId = crypto.randomUUID();
    const readOnlySessionId = crypto.randomUUID();
    const readOnlyToken = crypto.randomBytes(32).toString('base64url');
    const readOnlyCsrf = crypto.randomBytes(32).toString('base64url');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query("INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Synthetic domain sync','active')", [companyId]);
    await client.query('INSERT INTO rotamoto.users(id,email,email_verified_at) VALUES($1,$2,now())', [userId, `domain-sync-${userId}@example.invalid`]);
    await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'qa-sync','Synthetic sync role')", [roleId, companyId]);
    await client.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
      VALUES($1,$2,'sync.push',1),($1,$2,'sync.pull',1),($1,$2,'orders.read',1),
        ($1,$2,'company.manage',1),($1,$2,'members.read',1),($1,$2,'integrations.manage',1)`, [companyId, roleId]);
    await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at) VALUES($1,$2,$3,$4,'active',now())", [membershipId, companyId, userId, roleId]);
    await client.query(`INSERT INTO rotamoto.sessions(id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,idle_expires_at,absolute_expires_at,mfa_verified_at)
      VALUES($1,$2,$3,$4,$5,now(),now(),now()+interval '30 minutes',now()+interval '12 hours',now())`,
    [sessionId, userId, companyId, tokenDigest(sessionToken), tokenDigest(csrfToken)]);
    await client.query('INSERT INTO rotamoto.users(id,email,email_verified_at) VALUES($1,$2,now())', [readOnlyUserId, `domain-sync-readonly-${readOnlyUserId}@example.invalid`]);
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
      const unlinkedMotoInstall = await registerDevice('motoboy', 'unlinked-motoboy-device');
      assert.equal(unlinkedMotoInstall.status, 403);
      assert.equal(unlinkedMotoInstall.body.error.code, 'DRIVER_LINK_REQUIRED', 'Motoboy installation requires a server-resolved Driver link');
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
      const driverId=crypto.randomUUID(),otherDriverId=crypto.randomUUID(),driverNow=new Date().toISOString();
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,
        payload,version,created_at,updated_at) VALUES($1,$2,'Driver','restaurante',$3,$4::jsonb,1,$5,$5),
        ($1,$6,'Driver','restaurante',$3,$7::jsonb,1,$5,$5)`,
      [companyId,driverId,restaurantInstall.body.installationId,JSON.stringify({id:driverId,companyId,name:'Motorista sintético',createdAt:driverNow,updatedAt:driverNow,version:1}),driverNow,
        otherDriverId,JSON.stringify({id:otherDriverId,companyId,name:'Outro motorista sintético',createdAt:driverNow,updatedAt:driverNow,version:1})]);
      const noLinkCsrf=await call(`/api/admin/memberships/${membershipId}/driver`,{method:'PUT',csrf:null,body:{driverId}});
      assert.equal(noLinkCsrf.status,403);assert.equal(noLinkCsrf.body.error.code,'CSRF_INVALID');
      const invalidDriver=await call(`/api/admin/memberships/${membershipId}/driver`,{method:'PUT',body:{driverId:crypto.randomUUID()}});
      assert.equal(invalidDriver.status,404);assert.equal(invalidDriver.body.error.code,'DRIVER_NOT_FOUND');
      await client.query('UPDATE rotamoto.sessions SET mfa_verified_at=NULL WHERE id=$1',[sessionId]);
      const linkWithoutMfa=await call(`/api/admin/memberships/${membershipId}/driver`,{method:'PUT',body:{driverId}});
      assert.equal(linkWithoutMfa.status,403);assert.equal(linkWithoutMfa.body.error.code,'MFA_REQUIRED',
        'sensitive administrative binding keeps the existing MFA requirement');
      await client.query('UPDATE rotamoto.sessions SET mfa_verified_at=now() WHERE id=$1',[sessionId]);
      const linkedMembership=await call(`/api/admin/memberships/${membershipId}/driver`,{method:'PUT',body:{driverId}});
      assert.equal(linkedMembership.status,200,JSON.stringify(linkedMembership.body));
      assert.equal(linkedMembership.body.driverId,driverId);assert.equal(linkedMembership.body.changed,true);
      const sessionWithDriver=await identityService.resolveSession(client,sessionToken);
      assert.equal(sessionWithDriver.driver_id,driverId,'identity session principal resolves the canonical Driver from the server membership');
      const membersWithDriver=await call('/api/admin/memberships?limit=100');
      assert.equal(membersWithDriver.body.members.find(row=>row.membershipId===membershipId).driverId,driverId);
      const repeatedLink=await call(`/api/admin/memberships/${membershipId}/driver`,{method:'PUT',body:{driverId}});
      assert.equal(repeatedLink.body.changed,false,'repeating the same explicit association is idempotent');
      const ambiguousLink=await call(`/api/admin/memberships/${readOnlyMembershipId}/driver`,{method:'PUT',body:{driverId}});
      assert.equal(ambiguousLink.status,409);assert.equal(ambiguousLink.body.error.code,'DRIVER_ALREADY_LINKED');
      const deniedDriverLink=await call(`/api/admin/memberships/${readOnlyMembershipId}/driver`,{method:'PUT',body:{driverId},cookie:`${COOKIE_NAME}=${readOnlyToken}`,csrf:readOnlyCsrf});
      assert.equal(deniedDriverLink.status,403,'ordinary sync membership cannot administer driver bindings');
      const unlinkedDomainRead=await call('/api/domain/deliveries?limit=1',{cookie:`${COOKIE_NAME}=${readOnlyToken}`});
      assert.equal(unlinkedDomainRead.status,403);assert.equal(unlinkedDomainRead.body.error.code,'DRIVER_LINK_REQUIRED');
      const linkReaderDriver=await call(`/api/admin/memberships/${readOnlyMembershipId}/driver`,{method:'PUT',body:{driverId:otherDriverId}});
      assert.equal(linkReaderDriver.status,200,JSON.stringify(linkReaderDriver.body));
      const riderInstall=await registerDevice('motoboy','moto-proof-test-device');
      assert.equal(riderInstall.status,200);
      const assignedDelivery={id:'delivery-local-1',orderId:'order-local-1',driverId,status:'ASSIGNED',operationNote:'preserve me',
        createdAt:baseTime,updatedAt:new Date().toISOString(),version:2,baseVersion:1};
      const assignment=await call('/api/sync/push',{method:'POST',body:{...packet,packetId:`pkt_${crypto.randomUUID()}`,
        data:{...packet.data,orders:[],deliveries:[assignedDelivery],deliveryEvents:[],earnings:[],routes:[],drivers:[]}}});
      assert.equal(assignment.body.operationResults[0].status,'accepted',JSON.stringify(assignment.body.operationResults));
      assert.equal((await client.query("SELECT payload->>'driverId' AS driver_id FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,deliveryId])).rows[0].driver_id,driverId,
        'Delivery assignment is normalized to the canonical Driver ID');

      const otherDeliveryId=crypto.randomUUID(),otherOrderId=crypto.randomUUID();
      const otherNow=new Date().toISOString();
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,$5,$5),($1,$6,'Delivery','restaurante',$3,$7::jsonb,1,$5,$5)`,
      [companyId,otherOrderId,restaurantInstall.body.installationId,JSON.stringify({id:otherOrderId,companyId,number:'synthetic-other',createdAt:otherNow,updatedAt:otherNow,version:1}),otherNow,
        otherDeliveryId,JSON.stringify({id:otherDeliveryId,companyId,orderId:otherOrderId,driverId:otherDriverId,status:'ASSIGNED',createdAt:otherNow,updatedAt:otherNow,version:1})]);
      const otherEvents=[
        {entity:'Delivery',entityId:otherDeliveryId,payload:{id:otherDeliveryId,companyId,version:1,status:'ASSIGNED',driverId:otherDriverId}},
        {entity:'Order',entityId:otherOrderId,payload:{id:otherOrderId,companyId,version:1,number:'synthetic-other'}}
      ];
      for(const item of otherEvents){const outEvent={eventId:crypto.randomUUID(),type:'CANONICAL_RECORD_UPSERTED',entity:item.entity,entityId:item.entityId,
        occurredAt:otherNow,actor:{type:'user',id:userId},payload:item.payload,protocolVersion:1};
        await client.query(`INSERT INTO rotamoto.sync_outbox(company_id,event_id,app_key,installation_id,payload)
          VALUES($1,$2,'restaurante',$3,$4::jsonb)`,[companyId,outEvent.eventId,restaurantInstall.body.installationId,JSON.stringify(outEvent)]);}
      const forbiddenOperations=await call('/api/sync/push',{method:'POST',body:{...packet,packetId:`pkt_${crypto.randomUUID()}`,
        deviceId:'moto-proof-test-device',source:{app:'restaurante',deviceId:'moto-proof-test-device'},data:{...packet.data,orders:[],deliveries:[],drivers:[],routes:[],earnings:[],
          deliveryEvents:[{id:'event-not-assigned',eventId:'event-not-assigned',entity:'delivery',entityId:otherDeliveryId,type:'DELIVERY_ACCEPTED',occurredAt:otherNow,createdAt:otherNow,updatedAt:otherNow,version:1}],
          locationUpdates:[{id:'location-not-assigned',deliveryId:otherDeliveryId,latitude:-23,longitude:-46,recordedAt:otherNow,createdAt:otherNow,updatedAt:otherNow,version:1}],
          proofs:[{id:'proof-not-assigned',deliveryId:otherDeliveryId,createdAt:otherNow,updatedAt:otherNow,version:1}]}}});
      assert.equal(forbiddenOperations.body.operationResults.length,3);
      assert(forbiddenOperations.body.operationResults.every(row=>row.status==='rejected'&&row.error.code==='DRIVER_NOT_ASSIGNED'));
      assert.deepEqual(new Set(forbiddenOperations.body.operationResults.map(row=>row.entity)),new Set(['DeliveryEvent','LocationPoint','DeliveryProof']));
      const authorizedEvent=await call('/api/sync/push',{method:'POST',body:{...packet,packetId:`pkt_${crypto.randomUUID()}`,
        deviceId:'moto-proof-test-device',source:{app:'untrusted-client-label',deviceId:'moto-proof-test-device'},data:{...packet.data,orders:[],deliveries:[],drivers:[],routes:[],earnings:[],
          deliveryEvents:[{id:'event-assigned',eventId:'event-assigned',entity:'delivery',entityId:'delivery-local-1',type:'DELIVERY_ACCEPTED',occurredAt:otherNow,createdAt:otherNow,updatedAt:otherNow,version:1}],locationUpdates:[],proofs:[]}}});
      assert.equal(authorizedEvent.status,200,JSON.stringify(authorizedEvent.body));
      assert.equal(authorizedEvent.body.operationResults?.[0]?.status,'accepted',JSON.stringify(authorizedEvent.body));
      const scopedPull=await call('/api/sync/pull?limit=100&deviceId=moto-proof-test-device&driverId='+otherDriverId);
      assert.equal(scopedPull.status,200,JSON.stringify(scopedPull.body));
      assert(scopedPull.body.events.every(row=>row.entity!=='Delivery'||row.entityId!==otherDeliveryId),'client-supplied driverId cannot broaden pull scope');
      assert(scopedPull.body.events.some(row=>row.entity==='Delivery'&&row.entityId===deliveryId));
      const scopedList=await call('/api/domain/deliveries?limit=100');
      assert.equal(scopedList.status,200);assert(scopedList.body.records.some(row=>row.id===deliveryId));
      assert(scopedList.body.records.some(row=>row.id===otherDeliveryId),'company administrator keeps tenant-wide read authority');
      const adminDomainList=await call('/api/domain/deliveries?limit=100');
      assert.equal(adminDomainList.status,200);assert(adminDomainList.body.records.some(row=>row.id===otherDeliveryId),
        'authorized company administrator can use domain reads without being narrowed by an optional Driver link');
      const readerDomainList=await call('/api/domain/deliveries?limit=100',{cookie:`${COOKIE_NAME}=${readOnlyToken}`});
      assert.equal(readerDomainList.status,200);assert(readerDomainList.body.records.some(row=>row.id===otherDeliveryId));
      assert.equal(readerDomainList.body.records.some(row=>row.id===deliveryId),false,'non-admin domain reads are scoped to the resolved Driver');
      const hiddenOtherDelivery=await call(`/api/domain/deliveries/${deliveryId}`,{cookie:`${COOKIE_NAME}=${readOnlyToken}`});
      assert.equal(hiddenOtherDelivery.status,404,'domain record lookup cannot bypass driver assignment');
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
        WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2`, [companyId, orderId]);
      assert.equal(event.rowCount, 1);
      assert.equal(event.rows[0].related_entity_type, 'Order');
      assert.equal(event.rows[0].related_record_id, orderId);
      await client.query('SAVEPOINT immutable_event');
      await assert.rejects(client.query("UPDATE rotamoto.domain_records SET payload='{}'::jsonb WHERE company_id=$1 AND record_id=$2",
        [companyId, event.rows[0].record_id]), /DeliveryEvent é um fato imutável/);
      await client.query('ROLLBACK TO SAVEPOINT immutable_event');
      await client.query('RELEASE SAVEPOINT immutable_event');

      let page = await call('/api/sync/pull?limit=1&deviceId=restaurant-test-device');
      const pagedEventIds = [];
      for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
        assert.equal(page.status, 200);
        assert.equal(page.body.protocol, 'rotamoto-sync');
        assert.equal(page.body.events.length, 1);
        pagedEventIds.push(page.body.events[0].eventId);
        if (!page.body.hasMore) break;
        assert(page.body.nextCursor, 'keyset pagination supplies the next cursor while rows remain');
        page = await call(`/api/sync/pull?limit=1&deviceId=restaurant-test-device&cursor=${encodeURIComponent(page.body.nextCursor)}`);
      }
      assert.equal(new Set(pagedEventIds).size, pagedEventIds.length, 'microsecond keyset cursor does not repeat events');
      const outboxCount=await client.query('SELECT count(*)::int AS count FROM rotamoto.sync_outbox WHERE company_id=$1',[companyId]);
      assert.equal(pagedEventIds.length,outboxCount.rows[0].count,'keyset pagination returns every tenant outbox event exactly once');

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
      assert.equal(mergedDelivery.rows[0].status, 'ACCEPTED');
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
      assert.equal(unchanged.rows[0].status, 'ACCEPTED', 'restaurant cannot rewrite execution state');

      const invalidMotoTransition = { ...riderPacket, packetId: `pkt_${crypto.randomUUID()}`,
        data: { ...riderPacket.data, deliveries: [], deliveryEvents: [{ eventId: `evt_${crypto.randomUUID()}`, entity: 'delivery',
          entityId: deliveryId, type: 'DELIVERY_COMPLETED', occurredAt: new Date(Date.now() + 7000).toISOString() }] } };
      const invalidMotoResult = await call('/api/sync/push', { method: 'POST', body: invalidMotoTransition });
      assert.equal(invalidMotoResult.status, 200);
      assert.equal(invalidMotoResult.body.operationResults[0].status, 'conflict',JSON.stringify(invalidMotoResult.body.operationResults));
      assert.equal(invalidMotoResult.body.operationResults[0].error.code, 'INVALID_TRANSITION');
      assert.equal(invalidMotoResult.body.operationResults[0].canonicalVersion, undefined, 'a rejected first event has no canonical revision');

      const pushExecutionEvent = async (type, offset) => {
        const executionEvent = { eventId: `evt_${crypto.randomUUID()}`, entity: 'delivery', entityId: deliveryId,
          type, occurredAt: new Date(Date.now() + offset).toISOString(), actor: { type: 'driver', id: 'spoofed-driver' } };
        const result = await call('/api/sync/push', { method: 'POST', body: { ...riderPacket,
          packetId: `pkt_${crypto.randomUUID()}`, data: { ...riderPacket.data, deliveries: [], deliveryEvents: [executionEvent] } } });
        assert.equal(result.status, 200);
        assert.equal(result.body.operationResults[0].status, 'accepted', JSON.stringify(result.body.operationResults));
        return result;
      };
      await pushExecutionEvent('DELIVERY_ACCEPTED', 6500);
      let acceptedProjection = await client.query("SELECT payload,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2", [companyId, deliveryId]);
      assert.equal(acceptedProjection.rows[0].payload.status, 'ACCEPTED');
      assert.ok(acceptedProjection.rows[0].payload.acceptedAt);
      assert.equal(Number(acceptedProjection.rows[0].version), 3);
      await pushExecutionEvent('DELIVERY_PICKED_UP', 7000);
      let pickedProjection = await client.query("SELECT payload,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2", [companyId, deliveryId]);
      assert.equal(pickedProjection.rows[0].payload.status, 'PICKED_UP');
      assert.ok(pickedProjection.rows[0].payload.pickedUpAt);
      assert.equal(Number(pickedProjection.rows[0].version), 4);
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
      const projectedDelivery = await client.query("SELECT payload,payload->>'status' AS status,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2", [companyId, deliveryId]);
      assert.equal(projectedDelivery.rows[0].status, 'OUT_FOR_DELIVERY', 'execution event updates the canonical Delivery projection');
      assert.equal(Number(projectedDelivery.rows[0].version), 5);
      const prematureRedelivery={...projectedDelivery.rows[0].payload,status:'REDELIVERY',version:6,baseVersion:5,
        updatedAt:new Date(Date.now()+8500).toISOString()};
      const prematurePacket={...packet,packetId:`pkt_${crypto.randomUUID()}`,data:{...packet.data,orders:[],
        deliveries:[prematureRedelivery],deliveryEvents:[],earnings:[],routes:[],proofs:[],locationUpdates:[]}};
      const prematureResult=await call('/api/sync/push',{method:'POST',body:prematurePacket});
      assert.equal(prematureResult.body.operationResults[0].status,'rejected');
      assert.equal(prematureResult.body.operationResults[0].error.code,'FORBIDDEN_FIELD',
        'Restaurant cannot request redelivery before a terminal delivery outcome');
      const failedEvent={eventId:`evt_${crypto.randomUUID()}`,entity:'delivery',entityId:deliveryId,
        type:'DELIVERY_FAILED',occurredAt:new Date(Date.now()+9000).toISOString()};
      const failedPacket={...executionPacket,packetId:`pkt_${crypto.randomUUID()}`,
        data:{...executionPacket.data,deliveryEvents:[failedEvent],earnings:[]}};
      const failedResult=await call('/api/sync/push',{method:'POST',body:failedPacket});
      assert.equal(failedResult.body.operationResults[0].status,'accepted',JSON.stringify(failedResult.body.operationResults));
      const afterFailure=await client.query("SELECT payload,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,deliveryId]);
      assert.equal(afterFailure.rows[0].payload.status,'FAILED');assert.equal(Number(afterFailure.rows[0].version),6);
      const redeliveryRecord={...afterFailure.rows[0].payload,status:'REDELIVERY',version:7,baseVersion:6,
        updatedAt:new Date(Date.now()+10000).toISOString()};
      const redeliveryPacket={...packet,packetId:`pkt_${crypto.randomUUID()}`,data:{...packet.data,orders:[],
        deliveries:[redeliveryRecord],deliveryEvents:[],earnings:[],routes:[],proofs:[],locationUpdates:[]}};
      const redeliveryResult=await call('/api/sync/push',{method:'POST',body:redeliveryPacket});
      assert.equal(redeliveryResult.body.operationResults[0].status,'accepted',JSON.stringify(redeliveryResult.body.operationResults));
      const auditReadDenied=await client.query("SELECT has_table_privilege(current_user,'rotamoto.audit_log','SELECT') AS allowed");
      assert.equal(auditReadDenied.rows[0].allowed,false,'runtime keeps audit_log append-only and non-readable');
      const afterRedelivery=await client.query("SELECT payload,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,deliveryId]);
      const reassignedRecord={...afterRedelivery.rows[0].payload,status:'ASSIGNED',version:8,baseVersion:7,
        updatedAt:new Date(Date.now()+11000).toISOString()};
      const reassignedPacket={...redeliveryPacket,packetId:`pkt_${crypto.randomUUID()}`,data:{...redeliveryPacket.data,deliveries:[reassignedRecord]}};
      const reassignedResult=await call('/api/sync/push',{method:'POST',body:reassignedPacket});
      assert.equal(reassignedResult.body.operationResults[0].status,'accepted',JSON.stringify(reassignedResult.body.operationResults));
      const returnStart={eventId:`evt_${crypto.randomUUID()}`,entity:'delivery',entityId:deliveryId,
        type:'DELIVERY_STARTED',occurredAt:new Date(Date.now()+12000).toISOString()};
      const returnStartPacket={...executionPacket,packetId:`pkt_${crypto.randomUUID()}`,
        data:{...executionPacket.data,deliveryEvents:[returnStart],earnings:[]}};
      const returnStartResult=await call('/api/sync/push',{method:'POST',body:returnStartPacket});
      assert.equal(returnStartResult.body.operationResults[0].status,'accepted');
      const returnEvent={eventId:`evt_${crypto.randomUUID()}`,entity:'delivery',entityId:deliveryId,
        type:'DELIVERY_RETURNED',occurredAt:new Date(Date.now()+13000).toISOString()};
      const returnPacket={...executionPacket,packetId:`pkt_${crypto.randomUUID()}`,
        data:{...executionPacket.data,deliveryEvents:[returnEvent],earnings:[]}};
      const returnResult=await call('/api/sync/push',{method:'POST',body:returnPacket});
      assert.equal(returnResult.body.operationResults[0].status,'accepted',JSON.stringify(returnResult.body.operationResults));
      const afterReturn=await client.query("SELECT payload,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,deliveryId]);
      assert.equal(afterReturn.rows[0].payload.status,'RETURNED');assert.equal(Number(afterReturn.rows[0].version),10);
      const returnedRedelivery={...afterReturn.rows[0].payload,status:'REDELIVERY',version:11,baseVersion:10,
        updatedAt:new Date(Date.now()+14000).toISOString()};
      const returnedRedeliveryPacket={...packet,packetId:`pkt_${crypto.randomUUID()}`,data:{...packet.data,orders:[],
        deliveries:[returnedRedelivery],deliveryEvents:[],earnings:[],routes:[],proofs:[],locationUpdates:[]}};
      const returnedRedeliveryResult=await call('/api/sync/push',{method:'POST',body:returnedRedeliveryPacket});
      assert.equal(returnedRedeliveryResult.body.operationResults[0].status,'accepted',JSON.stringify(returnedRedeliveryResult.body.operationResults));
      const afterReturnedRedelivery=await client.query("SELECT payload FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,deliveryId]);
      const afterReturnedAssignment={...afterReturnedRedelivery.rows[0].payload,status:'ASSIGNED',version:12,baseVersion:11,
        updatedAt:new Date(Date.now()+15000).toISOString()};
      const returnedAssignmentPacket={...returnedRedeliveryPacket,packetId:`pkt_${crypto.randomUUID()}`,data:{...returnedRedeliveryPacket.data,deliveries:[afterReturnedAssignment]}};
      const returnedAssignment=await call('/api/sync/push',{method:'POST',body:returnedAssignmentPacket});
      assert.equal(returnedAssignment.body.operationResults[0].status,'accepted',JSON.stringify(returnedAssignment.body.operationResults));
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

      const beforeReassign=await client.query("SELECT payload,version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",[companyId,deliveryId]);
      const reassign={...packet,packetId:`pkt_${crypto.randomUUID()}`,deviceId:'restaurant-test-device',
        data:{...packet.data,orders:[],deliveries:[{...beforeReassign.rows[0].payload,driverId:otherDriverId,
          version:Number(beforeReassign.rows[0].version)+1,baseVersion:Number(beforeReassign.rows[0].version),updatedAt:new Date().toISOString()}],
          drivers:[],routes:[],deliveryEvents:[],earnings:[]}};
      const reassigned=await call('/api/sync/push',{method:'POST',body:reassign});
      assert.equal(reassigned.body.operationResults[0].status,'accepted',JSON.stringify(reassigned.body.operationResults));
      const oldDriverPull=await call('/api/sync/pull?limit=100&deviceId=moto-proof-test-device');
      const revoked=oldDriverPull.body.events.find(row=>row.type==='CANONICAL_ASSIGNMENT_REVOKED'&&row.entityId===deliveryId);
      assert(revoked,'former driver receives an assignment revocation notification');
      assert.deepEqual(Object.keys(revoked.payload).sort(),['companyId','id','updatedAt','version']);
      assert.equal(JSON.stringify(revoked).includes(otherDriverId),false,'revocation does not reveal the next driver identity');
      const lateFact=await call('/api/sync/push',{method:'POST',body:{...packet,packetId:`pkt_${crypto.randomUUID()}`,
        deviceId:'moto-proof-test-device',source:{app:'untrusted-client-label',deviceId:'moto-proof-test-device'},data:{...packet.data,orders:[],deliveries:[],drivers:[],routes:[],earnings:[],
          deliveryEvents:[{id:'late-old-driver-event',eventId:'late-old-driver-event',entity:'delivery',entityId:deliveryId,
            type:'DELIVERY_PICKED_UP',occurredAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),version:1}],
          locationUpdates:[],proofs:[]}}});
      assert.equal(lateFact.body.operationResults[0].status,'rejected');
      assert.equal(lateFact.body.operationResults[0].error.code,'DRIVER_NOT_ASSIGNED');

      const beforeTombstone=await client.query('SELECT version FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2',[companyId,deliveryId]);
      const tombstoneVersion=Number(beforeTombstone.rows[0].version);
      const tombstonePacket = { ...packet, packetId: `pkt_${crypto.randomUUID()}`, data: { ...packet.data, orders: [], deliveries: [],
        tombstones: [{ store: 'deliveries', id: 'delivery-local-1', deleted: true,
          deletedAt: new Date(Date.now() + 3000).toISOString(), updatedAt: new Date(Date.now() + 3000).toISOString(), version: tombstoneVersion+1, baseVersion: tombstoneVersion }] } };
      const tombstoneResult = await call('/api/sync/push', { method: 'POST', body: tombstonePacket });
      assert.equal(tombstoneResult.status, 200, JSON.stringify(tombstoneResult.body));
      assert.equal(tombstoneResult.body.operationResults.find(result => result.operation === 'tombstones:0').status, 'accepted');
      const tombstoneState = await client.query('SELECT deleted_at,payload->>\'deleted\' AS deleted FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2', [companyId, deliveryId]);
      assert.equal(tombstoneState.rows[0].deleted, 'true');
      assert(tombstoneState.rows[0].deleted_at);
      const unlink=await call(`/api/admin/memberships/${membershipId}/driver`,{method:'DELETE'});
      assert.equal(unlink.status,200,JSON.stringify(unlink.body));assert.equal(unlink.body.driverId,null);assert.equal(unlink.body.changed,true);
      const unlinkRepeat=await call(`/api/admin/memberships/${membershipId}/driver`,{method:'DELETE'});
      assert.equal(unlinkRepeat.status,200);assert.equal(unlinkRepeat.body.changed,false,'unlink is idempotent');
      const sessionAfterUnlink=await identityService.resolveSession(client,sessionToken);
      assert.equal(sessionAfterUnlink.driver_id,null,'unlinked identity no longer resolves an execution Driver');
      const installAfterUnlink=await registerDevice('motoboy','unlinked-after-admin-device');
      assert.equal(installAfterUnlink.status,403);assert.equal(installAfterUnlink.body.error.code,'DRIVER_LINK_REQUIRED');

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
      server.closeAllConnections?.();
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
