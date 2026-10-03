'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { Client } = require('pg');
const { createIdentityService, tokenDigest } = require('../backend/identity/service');
const { COOKIE_NAME, createRateLimiter } = require('../backend/identity/http');
const { createSyncService } = require('../backend/domain/sync-service');
const { createSyncHttpHandler } = require('../backend/domain/sync-http');

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
    const migration = await migrator.query("SELECT migration_id FROM rotamoto.schema_migrations WHERE migration_id='0006_global_event_idempotency'");
    assert.equal(migration.rowCount, 1, 'canonical schema migration is applied by the migrator');
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
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
    await client.query("INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'Synthetic domain sync','active')", [companyId]);
    await client.query('INSERT INTO rotamoto.users(id,email) VALUES($1,$2)', [userId, `domain-sync-${userId}@example.invalid`]);
    await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'qa-sync','Synthetic sync role')", [roleId, companyId]);
    await client.query("INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version) VALUES($1,$2,'sync.push',1),($1,$2,'sync.pull',1)", [companyId, roleId]);
    await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at) VALUES($1,$2,$3,$4,'active',now())", [membershipId, companyId, userId, roleId]);
    await client.query(`INSERT INTO rotamoto.sessions(id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES($1,$2,$3,$4,$5,now(),now(),now()+interval '30 minutes',now()+interval '12 hours')`,
    [sessionId, userId, companyId, tokenDigest(sessionToken), tokenDigest(csrfToken)]);
    await client.query('INSERT INTO rotamoto.users(id,email) VALUES($1,$2)', [readOnlyUserId, `domain-sync-readonly-${readOnlyUserId}@example.invalid`]);
    await client.query("INSERT INTO rotamoto.roles(id,company_id,role_key,display_name) VALUES($1,$2,'qa-no-sync','Synthetic no-sync role')", [readOnlyRoleId, companyId]);
    await client.query("INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,activated_at) VALUES($1,$2,$3,$4,'active',now())", [readOnlyMembershipId, companyId, readOnlyUserId, readOnlyRoleId]);
    await client.query(`INSERT INTO rotamoto.sessions(id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,idle_expires_at,absolute_expires_at)
      VALUES($1,$2,$3,$4,$5,now(),now(),now()+interval '30 minutes',now()+interval '12 hours')`,
    [readOnlySessionId, readOnlyUserId, companyId, tokenDigest(readOnlyToken), tokenDigest(crypto.randomBytes(32).toString('base64url'))]);

    const identityService = createIdentityService({ pool: savepointPool(client) });
    const syncService = createSyncService();
    const logs = [];
    const handler = createSyncHttpHandler({ identityService, syncService, logger: value => logs.push(value),
      rateLimiter: createRateLimiter({ policies: { default: { limit: 100, windowMs: 60000 } } }) });
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = `${COOKIE_NAME}=${sessionToken}`;
    const call = async (path, { method = 'GET', body, csrf = csrfToken, headers = {}, cookie: requestCookie = cookie } = {}) => {
      const response = await fetch(base + path, { method, headers: { Cookie: requestCookie, Origin: base,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    try {
      const badCsrf = await call('/api/sync/push', { method: 'POST', csrf: 'invalid', body: {} });
      assert.equal(badCsrf.status, 403);
      assert.equal(badCsrf.body.error.code, 'CSRF_INVALID');
      const invalidPacket = await call('/api/sync/push', { method: 'POST', body: { protocol: 'wrong' } });
      assert.equal(invalidPacket.status, 400);
      assert.equal(invalidPacket.body.error.code, 'INVALID_INPUT');
      const missingDeviceId = await call('/api/sync/pull');
      assert.equal(missingDeviceId.status, 400);
      const deniedPull = await call('/api/sync/pull?deviceId=unauthorized-device', { cookie: `${COOKIE_NAME}=${readOnlyToken}` });
      assert.equal(deniedPull.status, 403);
      assert.equal(deniedPull.body.error.code, 'FORBIDDEN');
      const baseTime = new Date(Date.now() - 5000).toISOString();
      const packet = { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
        packetId: `pkt_${crypto.randomUUID()}`, deviceId: 'restaurant-test-device', companyId: crypto.randomUUID(),
        source: { app: 'RotaMoto Restaurante', deviceId: 'restaurant-test-device' }, createdAt: baseTime,
        data: { orders: [{ id: 'order-local-1', createdAt: baseTime, updatedAt: baseTime, version: 1, status: 'CREATED', customer: 'Sintético' }],
          deliveries: [{ id: 'delivery-local-1', orderId: 'order-local-1', status: 'CREATED', operationNote: 'preserve me',
            createdAt: baseTime, updatedAt: baseTime, version: 1 }],
          drivers: [], routes: [], locationUpdates: [], deliveryEvents: [{ id: 'event-local-1', eventId: 'event-local-1',
            entity: 'order', entityId: 'order-local-1', type: 'ORDER_CREATED', occurredAt: baseTime, actor: { type: 'user' } }],
          proofs: [], earnings: [], tombstones: [] } };
      const pushed = await call('/api/sync/push', { method: 'POST', body: packet });
      assert.equal(pushed.status, 200, JSON.stringify({ response: pushed.body, logs }));
      assert.equal(pushed.body.companyId, companyId, 'tenant comes from the authenticated session, not packet.companyId');
      assert.equal(pushed.body.received, 3);
      const duplicate = await call('/api/sync/push', { method: 'POST', body: packet });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body.duplicate, true);
      const orderId = pushed.body.aliases.find(alias => alias.entity === 'Order').canonicalId;
      const deliveryId = pushed.body.aliases.find(alias => alias.entity === 'Delivery').canonicalId;
      assert.match(orderId, /^[0-9a-f-]{36}$/iu);
      assert.match(deliveryId, /^[0-9a-f-]{36}$/iu);
      assert.notEqual(orderId, 'order-local-1');
      const stored = await client.query(`SELECT d.payload,d.related_record_id::text,d.related_entity_type,o.payload AS order_payload
        FROM rotamoto.domain_records d JOIN rotamoto.domain_records o ON o.company_id=d.company_id AND o.record_id=d.related_record_id
        WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Delivery'`, [companyId, deliveryId]);
      assert.equal(stored.rowCount, 1);
      assert.equal(stored.rows[0].related_record_id, orderId);
      assert.equal(stored.rows[0].related_entity_type, 'Order');
      assert.equal(stored.rows[0].payload.orderId, orderId, 'references in payload use canonical IDs');
      assert.equal(stored.rows[0].payload.companyId, companyId, 'client tenant was overwritten by session tenant');
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
      assert.equal(finalPage.body.hasMore, false);
      assert.equal(new Set([pull.body.events[0].eventId, next.body.events[0].eventId, finalPage.body.events[0].eventId]).size, 3,
        'microsecond keyset cursor returns every outbox event exactly once');

      const riderTime = new Date(Date.now() + 2000).toISOString();
      const riderPacket = { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1,
        packetId: `pkt_${crypto.randomUUID()}`, deviceId: 'rider-test-device', companyId: crypto.randomUUID(),
        source: { app: 'RotaMoto', deviceId: 'rider-test-device' }, createdAt: riderTime,
        data: { orders: [], deliveries: [{ id: 'delivery-rider-local', orderId: 'order-local-1', status: 'ASSIGNED',
          createdAt: baseTime, updatedAt: riderTime, version: 2 }], drivers: [], routes: [], locationUpdates: [],
          deliveryEvents: [], proofs: [], earnings: [], tombstones: [], races: [], settings: { driverId: 'synthetic' } } };
      const riderPush = await call('/api/sync/push', { method: 'POST', body: riderPacket });
      assert.equal(riderPush.status, 200, JSON.stringify(riderPush.body));
      assert.equal(riderPush.body.aliases.find(alias => alias.entity === 'Delivery').canonicalId, deliveryId,
        'another app installation resolves Delivery through its canonical Order relation');
      const mergedDelivery = await client.query("SELECT payload->>'status' AS status,payload->>'operationNote' AS operation_note FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2",
        [companyId, deliveryId]);
      assert.equal(mergedDelivery.rows[0].status, 'ASSIGNED');
      assert.equal(mergedDelivery.rows[0].operation_note, 'preserve me', 'partial cross-app revision preserves absent fields');

      const eventId = event.rows[0].record_id;
      const eventRetry = { ...packet, packetId: `pkt_${crypto.randomUUID()}`, deviceId: 'restaurant-second-device',
        source: { app: 'RotaMoto Restaurante', deviceId: 'restaurant-second-device' },
        data: { orders: [], deliveries: [], drivers: [], routes: [], locationUpdates: [],
          deliveryEvents: [{ id: 'event-local-1', eventId: 'event-local-1', entity: 'order', entityId: 'order-local-1',
            type: 'ORDER_CREATED', occurredAt: baseTime, actor: { type: 'user' } }], proofs: [], earnings: [], tombstones: [] } };
      const eventRetryResult = await call('/api/sync/push', { method: 'POST', body: eventRetry });
      assert.equal(eventRetryResult.status, 200, JSON.stringify(eventRetryResult.body));
      assert.equal(eventRetryResult.body.aliases[0].canonicalId, eventId, 'eventId deduplicates across installations');

      const invalidTransition = structuredClone(packet);
      invalidTransition.packetId = `pkt_${crypto.randomUUID()}`;
      invalidTransition.data.orders = [];
      invalidTransition.data.deliveries[0] = { ...invalidTransition.data.deliveries[0], status: 'DELIVERED', version: 2,
        updatedAt: new Date(Date.now() + 5000).toISOString() };
      const transitionResult = await call('/api/sync/push', { method: 'POST', body: invalidTransition });
      assert.equal(transitionResult.status, 409);
      assert.equal(transitionResult.body.error.code, 'INVALID_TRANSITION');
      const unchanged = await client.query('SELECT payload->>\'status\' AS status FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2', [companyId, deliveryId]);
      assert.equal(unchanged.rows[0].status, 'ASSIGNED', 'failed packet rolled back domain changes');

      const changedRetry = structuredClone(packet);
      changedRetry.data.orders[0].customer = 'conteúdo divergente';
      const idempotencyConflict = await call('/api/sync/push', { method: 'POST', body: changedRetry });
      assert.equal(idempotencyConflict.status, 409, 'packetId reuse with different content is rejected');

      const wrongOwnerPacket = { ...packet, packetId: `pkt_${crypto.randomUUID()}`, source: { app: 'RotaMoto', deviceId: 'rider-device' },
        deviceId: 'rider-device', data: { ...packet.data, deliveries: [], deliveryEvents: [], orders: [{ id: 'foreign-order',
          createdAt: baseTime, updatedAt: baseTime, version: 1 }] } };
      const wrongOwner = await call('/api/sync/push', { method: 'POST', body: wrongOwnerPacket });
      assert.equal(wrongOwner.status, 403, 'Motoboy cannot write Restaurant-owned orders');

      const tombstonePacket = { ...packet, packetId: `pkt_${crypto.randomUUID()}`, data: { ...packet.data, orders: [], deliveries: [],
        tombstones: [{ store: 'deliveries', id: 'delivery-local-1', deleted: true,
          deletedAt: new Date(Date.now() + 3000).toISOString(), updatedAt: new Date(Date.now() + 3000).toISOString(), version: 2 }] } };
      const tombstoneResult = await call('/api/sync/push', { method: 'POST', body: tombstonePacket });
      assert.equal(tombstoneResult.status, 200, JSON.stringify(tombstoneResult.body));
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
