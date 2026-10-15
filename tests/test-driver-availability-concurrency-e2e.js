'use strict';

// Real two-session PostgreSQL interleavings against a newly owned schema built
// from checked-in migrations. The schema and synthetic rows remain in
// rotamoto_e2e under a durable fixture manifest; teardown never drops them.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createClient, createPool } = require('../backend/postgres/connection');
const { getMigrations } = require('../backend/postgres/migrate');
const { createE2eClients, assertConnectedIdentity, storedLoopbackCredential } = require('./e2e-support/guards');
const { createIdentityService } = require('../backend/identity/service');
const { createRateLimiter } = require('../backend/identity/http');
const { createSyncService } = require('../backend/domain/sync-service');
const { createSyncHttpHandler } = require('../backend/domain/sync-http');
const { createDriverAvailabilityService } = require('../backend/logistics/driver-availability');
const { createDriverAvailabilityHttpHandler } = require('../backend/logistics/driver-availability-http');
const { createRestaurantDriverQueueService } = require('../backend/logistics/restaurant-driver-queue');
const { createRestaurantDriverQueueHttpHandler } = require('../backend/logistics/restaurant-driver-queue-http');
const { createLogisticsService } = require('../backend/logistics/service');
const { createLogisticsHttpHandler } = require('../backend/logistics/http');
const { createFixtureManifest } = require('./e2e-support/fixture-manifest');

const RUNTIME_URL = process.env.E2E_RUNTIME_DATABASE_URL;
const DATABASE = 'rotamoto_e2e';
const RUNTIME_ROLE = 'rotamoto_app';
const MIGRATOR_ROLE = 'rotamoto_migrator';
const CAMPAIGN = process.env.ROTAMOTO_E2E_CAMPAIGN || '0160';
const UUID = () => crypto.randomUUID();
const digest = value => crypto.createHash('sha256').update(value).digest();
function signedPresenceToken(pair, claims) {
  const encoded=Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input=`rm-presence.v1.${encoded}`;
  return `${input}.${crypto.sign(null,Buffer.from(input),pair.privateKey).toString('base64url')}`;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const timeline = [];
const runtimeClients = new Set();

function mark(label, detail = '') { timeline.push({ sequence: timeline.length + 1, label, detail }); }
function expected(value, message) { assert.equal(value, true, message); }
function schemaSql(schema, sql) { return sql.replace(/\brotamoto\./gu, `${schema}.`); }
function mappedClient(client, schema) {
  return { query: (sql, values) => client.query(schemaSql(schema, sql), values), release: () => client.release() };
}
function createRateLimit() { return { consume: () => ({ allowed: true }) }; }

async function configureTimeouts(client) {
  await client.query("SET lock_timeout='8s'");
  await client.query("SET statement_timeout='12s'");
}

async function openRuntimeClient({ schema = null, tenantId = null, applicationName = 'campaign-0112-runtime' } = {}) {
  const client = createClient({ connectionString: RUNTIME_URL,
    password: storedLoopbackCredential(RUNTIME_ROLE, DATABASE), application_name: applicationName,
    connectionTimeoutMillis: 5000, statement_timeout: 12000, query_timeout: 14000 });
  await client.connect();
  runtimeClients.add(client);
  try {
    await assertConnectedIdentity(client, { database: DATABASE, role: RUNTIME_ROLE });
    await configureTimeouts(client);
    if (tenantId) await client.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId]);
    return schema ? { raw: client, client: mappedClient(client, schema) } : { raw: client, client };
  } catch (error) { runtimeClients.delete(client); await client.end().catch(() => {}); throw error; }
}

async function endRuntimeClient(client) {
  if (runtimeClients.delete(client)) await client.end().catch(() => {});
}

function createRuntimePool(schema) {
  const rawPool = createPool({ connectionString: RUNTIME_URL,
    password: storedLoopbackCredential(RUNTIME_ROLE, DATABASE), application_name: 'campaign-0112-api',
    max: 12, connectionTimeoutMillis: 5000, statement_timeout: 12000, query_timeout: 14000 });
  return {
    async connect() {
      const client = await rawPool.connect();
      try {
        // Verify every checked-out backend before it can handle a test request.
        const identity = (await client.query(`SELECT current_database() AS database,current_user AS role,
          inet_server_addr()::text AS server_address,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass
          FROM pg_roles WHERE rolname=current_user`)).rows[0];
        assert.deepEqual(identity, { database: DATABASE, role: RUNTIME_ROLE, server_address: '127.0.0.1/32', bypass: false });
        await client.query("SET application_name='campaign-0112-api'");
        await configureTimeouts(client);
        return { query: (sql, values) => client.query(schemaSql(schema, sql), values), release: error => client.release(error) };
      } catch (error) { client.release(error); throw error; }
    },
    end: () => rawPool.end()
  };
}

function createFixture() {
  const now = new Date().toISOString();
  const companyId = UUID(), otherCompanyId = UUID(), userId = UUID(), roleId = UUID(), membershipId = UUID();
  const driverId = UUID(), otherDriverId = UUID(), restaurantInstallId = UUID(), motoboyInstallId = UUID(), otherInstallId = UUID();
  const sessions = [
    { id: UUID(), token: crypto.randomBytes(32).toString('base64url'), csrf: crypto.randomBytes(32).toString('base64url') },
    { id: UUID(), token: crypto.randomBytes(32).toString('base64url'), csrf: crypto.randomBytes(32).toString('base64url') }
  ];
  const deliveries = Array.from({ length: 6 }, () => ({ id: UUID(), orderId: UUID() }));
  const historicalEvents = [2, 3].map(deliveryIndex => ({ id: UUID(), key: `e2e-0112-${UUID()}`,
    deliveryIndex }));
  return { now, companyId, otherCompanyId, userId, roleId, membershipId, driverId, otherDriverId,
    restaurantInstallId, motoboyInstallId, otherInstallId, sessions, deliveries, historicalEvents };
}

function driverRecord(f, id, companyId, installationId) {
  const payload = { id, companyId, name: 'Driver de concorrência E2E', status: 'ACTIVE', version: 1,
    createdAt: f.now, updatedAt: f.now };
  return [companyId, id, 'Driver', 'restaurante', installationId, JSON.stringify(payload), f.now, f.now];
}
function orderRecord(f, companyId, id, installationId) {
  const payload = { id, companyId, customer: 'Fixture E2E sintética', source: 'manual', version: 1,
    createdAt: f.now, updatedAt: f.now };
  return [companyId, id, 'Order', 'restaurante', installationId, JSON.stringify(payload), f.now, f.now];
}
function deliveryRecord(f, id, orderId, status, driverId = null, installationId = f.restaurantInstallId) {
  const payload = { id, companyId: f.companyId, orderId, driverId, status, version: 1,
    createdAt: f.now, updatedAt: f.now };
  return [f.companyId, id, 'Delivery', 'restaurante', installationId, 'Order', orderId,
    JSON.stringify(payload), f.now, f.now];
}

async function seedFixture(client, schema, f) {
  const q = (sql, values) => client.query(schemaSql(schema, sql), values);
  await client.query('BEGIN');
  try {
    await q("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    await q(`INSERT INTO ${schema}.companies(id,name,status) VALUES($1,'Campanha 0112 E2E sintética','active')`, [f.companyId]);
    await q(`INSERT INTO ${schema}.users(id,email,email_verified_at) VALUES($1,$2,now())`, [f.userId, `campaign-0112-${f.userId}@example.invalid`]);
    await q(`INSERT INTO ${schema}.credentials(user_id,password_phc,mfa_required) VALUES($1,'$argon2id$e2e-fixture-placeholder',false)`, [f.userId]);
    await q(`INSERT INTO ${schema}.roles(id,company_id,role_key,display_name) VALUES($1,$2,'e2e_concurrency','E2E concurrency fixture')`, [f.roleId, f.companyId]);
    await q(`INSERT INTO ${schema}.role_permissions(company_id,role_id,permission_key,catalog_version)
      SELECT $1,$2,permission_key,1 FROM ${schema}.permissions WHERE permission_key=ANY($3::text[])`, [f.companyId, f.roleId, ['orders.manage', 'sync.pull', 'sync.push']]);
    const permissionCount = await q(`SELECT count(*)::int AS n FROM ${schema}.role_permissions WHERE company_id=$1 AND role_id=$2`, [f.companyId, f.roleId]);
    assert.equal(permissionCount.rows[0].n, 3, 'the E2E role has only the operation and sync permissions required by these paths');
    await q(`INSERT INTO ${schema}.sync_installations(id,company_id,app_key,local_device_id,registered_by_user_id)
      VALUES($1,$3,'restaurante','campaign-0112-restaurante',$4),($2,$3,'motoboy','campaign-0112-motoboy',$4)`,
    [f.restaurantInstallId, f.motoboyInstallId, f.companyId, f.userId]);
    const driver = driverRecord(f, f.driverId, f.companyId, f.restaurantInstallId);
    await q(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8)`, driver);
    const otherDriver = driverRecord(f, f.otherDriverId, f.otherCompanyId, f.otherInstallId);
    await q("SELECT set_config('app.tenant_id',$1,true)", [f.otherCompanyId]);
    await q(`INSERT INTO ${schema}.companies(id,name,status) VALUES($1,'Campanha 0112 tenant isolado','active')`, [f.otherCompanyId]);
    await q(`INSERT INTO ${schema}.sync_installations(id,company_id,app_key,local_device_id,registered_by_user_id)
      VALUES($1,$2,'restaurante','campaign-0112-other-tenant',$3)`, [f.otherInstallId, f.otherCompanyId, f.userId]);
    await q(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8)`, otherDriver);
    await q(`INSERT INTO ${schema}.driver_availability(company_id,driver_id,status,revision)
      VALUES($1,$2,'offline',0)`, [f.otherCompanyId, f.otherDriverId]);
    await q("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    await q(`INSERT INTO ${schema}.memberships(id,company_id,user_id,role_id,status,activated_at,driver_id)
      VALUES($1,$2,$3,$4,'active',now(),$5)`, [f.membershipId, f.companyId, f.userId, f.roleId, f.driverId]);
    for (const session of f.sessions) {
      await q(`INSERT INTO ${schema}.sessions(id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,
        idle_expires_at,absolute_expires_at,mfa_verified_at)
        VALUES($1,$2,$3,$4,$5,now(),now(),now()+interval '30 minutes',now()+interval '12 hours',now())`,
      [session.id, f.userId, f.companyId, digest(session.token), digest(session.csrf)]);
    }
    for (const delivery of f.deliveries) {
      const order = orderRecord(f, f.companyId, delivery.orderId, f.restaurantInstallId);
      await q(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8)`, order);
    }
    const deliveryRows = [
      deliveryRecord(f, f.deliveries[0].id, f.deliveries[0].orderId, 'CREATED'),
      deliveryRecord(f, f.deliveries[1].id, f.deliveries[1].orderId, 'CREATED'),
      deliveryRecord(f, f.deliveries[2].id, f.deliveries[2].orderId, 'FAILED', f.driverId),
      deliveryRecord(f, f.deliveries[3].id, f.deliveries[3].orderId, 'FAILED', f.driverId),
      deliveryRecord(f, f.deliveries[4].id, f.deliveries[4].orderId, 'CREATED'),
      deliveryRecord(f, f.deliveries[5].id, f.deliveries[5].orderId, 'CREATED')
    ];
    for (const row of deliveryRows) {
      await q(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,
        related_entity_type,related_record_id,payload,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$10)`, row);
    }
    for (const historical of f.historicalEvents) {
      const eventPayload = { id: historical.id, eventId: historical.id, entity: 'Delivery',
        entityId: f.deliveries[historical.deliveryIndex].id, type: 'DELIVERY_FAILED', occurredAt: f.now,
        actor: { type: 'driver', id: f.driverId }, payload: { reason: 'synthetic E2E fixture' }, protocolVersion: 1 };
      await q(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,
        related_entity_type,related_record_id,source_event_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'DeliveryEvent','motoboy',$3,'Delivery',$4,$5,$6::jsonb,1,$7,$8)`,
      [f.companyId, historical.id, f.motoboyInstallId, f.deliveries[historical.deliveryIndex].id, historical.key,
        JSON.stringify(eventPayload), f.now, f.now]);
    }
    await q(`INSERT INTO ${schema}.driver_availability(company_id,driver_id,status,revision,lease_expires_at,lease_session_id,updated_by_user_id)
      VALUES($1,$2,'online',1,now()+interval '120 seconds',$3,$4)`,
    [f.companyId, f.driverId, f.sessions[0].id, f.userId]);
    await client.query('COMMIT');
    mark('fixture committed in isolated E2E schema');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function seedReturnReceiptRaces(client, schema, f) {
  const now = new Date().toISOString();
  const scenarios = [0, 1].map(() => ({ orderId: UUID(), originalId: UUID(), returnId: UUID() }));
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    for (const row of scenarios) {
      const order = { id: row.orderId, companyId: f.companyId, number: `RETURN-RACE-${row.orderId.slice(0, 8)}`,
        customer: 'Fixture sintética de concorrência RETURN', status: 'READY', version: 1, createdAt: now, updatedAt: now };
      const original = { id: row.originalId, companyId: f.companyId, orderId: row.orderId, status: 'CANCELLED',
        version: 7, createdAt: now, updatedAt: now, extensions: { x_rotamoto_custody_state: 'RETURN_REQUESTED' } };
      const returned = { id: row.returnId, companyId: f.companyId, orderId: row.orderId, status: 'ARRIVED',
        version: 4, createdAt: now, updatedAt: now, extensions: { x_rotamoto_delivery_type: 'RETURN',
          x_rotamoto_return_of_delivery_id: row.originalId, x_rotamoto_custody_state: 'AWAITING_RESTAURANT_RECEIPT',
          x_rotamoto_driver_handover_confirmed: true } };
      await client.query(schemaSql(schema, `INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,
        source_installation_id,payload,version,created_at,updated_at) VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,$5,$5)`),
      [f.companyId, row.orderId, f.restaurantInstallId, JSON.stringify(order), now]);
      await client.query(schemaSql(schema, `INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,
        source_installation_id,related_entity_type,related_record_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,'Order',$4,$5::jsonb,7,$6,$6),
              ($1,$7,'Delivery','restaurante',$3,'Delivery',$2,$8::jsonb,4,$6,$6)`),
      [f.companyId, row.originalId, f.restaurantInstallId, row.orderId, JSON.stringify(original), now,
        row.returnId, JSON.stringify(returned)]);
    }
    await client.query('COMMIT');
    return scenarios;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

function assignmentPacket(f, deliveryIndex, { status = 'ASSIGNED', driverId = f.driverId, packetId = `pkt_${UUID()}` } = {}) {
  const base = deliveryRecord(f, f.deliveries[deliveryIndex].id, f.deliveries[deliveryIndex].orderId,
    status === 'REDELIVERY' ? 'FAILED' : 'CREATED', status === 'REDELIVERY' ? f.driverId : null);
  const now = new Date().toISOString();
  const prior = JSON.parse(base[7]);
  const delivery = { ...prior, status, driverId, ...(driverId ? { assignedAt: now } : {}), updatedAt: now,
    version: 2, baseVersion: 1 };
  return { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId,
    deviceId: 'campaign-0112-restaurante', source: { deviceId: 'campaign-0112-restaurante' }, createdAt: now,
    data: { orders: [], drivers: [], deliveries: [delivery], routes: [], deliveryEvents: [], locationUpdates: [],
      proofs: [], earnings: [], tombstones: [] } };
}

function readyDeliveryPacket(f) {
  const now=new Date().toISOString(),orderId=UUID(),deliveryId=UUID();
  const order={id:orderId,companyId:f.companyId,number:`E2E-${orderId.slice(0,8)}`,customer:'Fixture sintética',address:'Endereço E2E',source:'manual',status:'READY',version:1,createdAt:now,updatedAt:now};
  const delivery={id:deliveryId,companyId:f.companyId,orderId,driverId:null,status:'CREATED',version:1,createdAt:now,updatedAt:now};
  return {deliveryId,packet:{protocol:'rotamoto-sync',protocolVersion:1,schemaVersion:1,packetId:`pkt_${UUID()}`,deviceId:'campaign-0112-restaurante',source:{deviceId:'campaign-0112-restaurante'},createdAt:now,
    data:{orders:[order],drivers:[],deliveries:[delivery],routes:[],deliveryEvents:[],locationUpdates:[],proofs:[],earnings:[],tombstones:[]}}};
}
function deliveryExecutionPacket(f,deliveryId,type,driverId=f.driverId){
  const at=new Date().toISOString(),eventId=UUID();
  const event={id:eventId,eventId,companyId:f.companyId,entity:'Delivery',entityId:deliveryId,type,occurredAt:at,
    actor:{type:'driver',id:driverId},payload:{},protocolVersion:1,version:1,createdAt:at,updatedAt:at};
  return {protocol:'rotamoto-sync',protocolVersion:1,schemaVersion:1,packetId:`pkt_${UUID()}`,deviceId:'campaign-0112-motoboy',source:{deviceId:'campaign-0112-motoboy'},createdAt:at,
    data:{orders:[],drivers:[],deliveries:[],routes:[],deliveryEvents:[event],locationUpdates:[],proofs:[],earnings:[],tombstones:[]}};
}

function unassignedRedeliveryPacket(f, fixture, packetId=`pkt_${UUID()}`){
  const now=new Date().toISOString();
  const delivery={id:fixture.deliveryId,companyId:f.companyId,orderId:fixture.orderId,driverId:null,status:'REDELIVERY',
    version:2,baseVersion:1,createdAt:f.now,updatedAt:now};
  return {protocol:'rotamoto-sync',protocolVersion:1,schemaVersion:1,packetId,deviceId:'campaign-0112-restaurante',
    source:{deviceId:'campaign-0112-restaurante'},createdAt:now,
    data:{orders:[],drivers:[],deliveries:[delivery],routes:[],deliveryEvents:[],locationUpdates:[],proofs:[],earnings:[],tombstones:[]}};
}

async function seedRedeliveryFixture(client,schema,f){
  const orderId=UUID(),deliveryId=UUID(),eventId=UUID(),now=new Date().toISOString();
  const order=orderRecord(f,f.companyId,orderId,f.restaurantInstallId);
  const delivery=deliveryRecord(f,deliveryId,orderId,'FAILED',f.driverId);
  const eventPayload={id:eventId,eventId,entity:'Delivery',entityId:deliveryId,type:'DELIVERY_FAILED',occurredAt:now,
    actor:{type:'driver',id:f.driverId},payload:{reason:'synthetic E2E failure'},protocolVersion:1};
  await client.query('BEGIN');
  try{
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
      VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,$5,$5)`,[f.companyId,orderId,f.restaurantInstallId,JSON.stringify(JSON.parse(order[5])),now]);
    await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,related_entity_type,related_record_id,payload,version,created_at,updated_at)
      VALUES($1,$2,'Delivery','restaurante',$3,'Order',$4,$5::jsonb,1,$6,$6)`,[f.companyId,deliveryId,f.restaurantInstallId,orderId,delivery[7],now]);
    await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,related_entity_type,related_record_id,source_event_id,payload,version,created_at,updated_at)
      VALUES($1,$2,'DeliveryEvent','motoboy',$3,'Delivery',$4,$5,$6::jsonb,1,$7,$7)`,
      [f.companyId,eventId,f.motoboyInstallId,deliveryId,eventId,JSON.stringify(eventPayload),now]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
  return {orderId,deliveryId,eventId};
}

async function seedEligibilityPair(client,schema,f,kind){
  const firstId=UUID(),secondId=UUID(),now=new Date().toISOString();
  const firstLease=kind==='expired'?'now()-interval \'1 second\'':"now()+interval '120 seconds'";
  await client.query('BEGIN');
  try{
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    await client.query(`UPDATE ${schema}.restaurant_driver_presence SET is_present=false,checked_out_at=coalesce(checked_out_at,now()),revision=revision+1,updated_at=now()
      WHERE company_id=$1 AND is_present`,[f.companyId]);
    for(const [index,driverId] of [firstId,secondId].entries()){
      const row=driverRecord(f,driverId,f.companyId,f.restaurantInstallId);
      await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Driver','restaurante',$3,$4::jsonb,1,$5,$5)`,[f.companyId,driverId,f.restaurantInstallId,JSON.stringify(JSON.parse(row[5])),now]);
      const status=index===0&&kind==='offline'?'offline':'online';
      await client.query(`INSERT INTO ${schema}.driver_availability(company_id,driver_id,status,revision,lease_expires_at,lease_session_id,updated_by_user_id)
        VALUES($1,$2,$3,1,CASE WHEN $3='online' THEN ${index===0?firstLease:"now()+interval '120 seconds'"} ELSE NULL END,
          CASE WHEN $3='online' THEN $4::uuid ELSE NULL END,$5)`,[f.companyId,driverId,status,f.sessions[0].id,f.userId]);
      const present=!(index===0&&kind==='offline');
      await client.query(`INSERT INTO ${schema}.restaurant_driver_presence(company_id,driver_id,checked_in_at,checkin_method,confirmed,is_present,checked_out_at,revision,updated_at)
        VALUES($1,$2,now()-($3::int*interval '1 minute'),'restaurant_qr',true,$4,CASE WHEN $4 THEN NULL ELSE now() END,1,now())`,
      [f.companyId,driverId,index===0?4:2,present]);
    }
    if(kind==='occupied'){
      const orderId=UUID(),deliveryId=UUID(),order=orderRecord(f,f.companyId,orderId,f.restaurantInstallId),delivery=deliveryRecord(f,deliveryId,orderId,'ASSIGNED',firstId);
      await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,$5,$5)`,[f.companyId,orderId,f.restaurantInstallId,JSON.stringify(JSON.parse(order[5])),now]);
      await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,related_entity_type,related_record_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,'Order',$4,$5::jsonb,1,$6,$6)`,[f.companyId,deliveryId,f.restaurantInstallId,orderId,JSON.stringify(JSON.parse(delivery[7])),now]);
    }
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
  return {firstId,secondId};
}

async function seedIndependentRiders(client, schema, f, drivers) {
  const riders = drivers.map(driverId => ({ userId: UUID(), membershipId: UUID(), session: {
    id: UUID(), token: crypto.randomBytes(32).toString('base64url'), csrf: crypto.randomBytes(32).toString('base64url') },
    installationId: UUID(), driverId }));
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    for (const [index, rider] of riders.entries()) {
      await client.query(`INSERT INTO ${schema}.users(id,email,email_verified_at) VALUES($1,$2,now())`,
        [rider.userId, `campaign-0191-rider-${index}-${rider.userId}@example.invalid`]);
      await client.query(`INSERT INTO ${schema}.credentials(user_id,password_phc,mfa_required)
        VALUES($1,'$argon2id$e2e-fixture-placeholder',false)`, [rider.userId]);
      await client.query(`INSERT INTO ${schema}.memberships(id,company_id,user_id,role_id,status,activated_at,driver_id)
        VALUES($1,$2,$3,$4,'active',now(),$5)`, [rider.membershipId, f.companyId, rider.userId, f.roleId, rider.driverId]);
      await client.query(`INSERT INTO ${schema}.sessions(id,user_id,active_company_id,token_digest,csrf_digest,created_at,last_seen_at,
        idle_expires_at,absolute_expires_at,mfa_verified_at)
        VALUES($1,$2,$3,$4,$5,now(),now(),now()+interval '30 minutes',now()+interval '12 hours',now())`,
      [rider.session.id, rider.userId, f.companyId, digest(rider.session.token), digest(rider.session.csrf)]);
      await client.query(`INSERT INTO ${schema}.sync_installations(id,company_id,app_key,local_device_id,registered_by_user_id)
        VALUES($1,$2,'motoboy',$3,$4)`, [rider.installationId, f.companyId, `campaign-0191-${rider.installationId}`, rider.userId]);
      await client.query(`UPDATE ${schema}.driver_availability SET lease_session_id=$3,updated_by_user_id=$4,
        lease_expires_at=now()+interval '120 seconds' WHERE company_id=$1 AND driver_id=$2`,
      [f.companyId, rider.driverId, rider.session.id, rider.userId]);
    }
    await client.query('COMMIT');
    return riders;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

async function seedForeignEligibleDriver(client,schema,f){
  await client.query('BEGIN');
  try{
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[f.otherCompanyId]);
    await client.query(`UPDATE ${schema}.driver_availability SET status='online',revision=revision+1,lease_expires_at=now()+interval '120 seconds',
      lease_session_id=$3,updated_by_user_id=$4 WHERE company_id=$1 AND driver_id=$2`,[f.otherCompanyId,f.otherDriverId,f.sessions[0].id,f.userId]);
    await client.query(`INSERT INTO ${schema}.restaurant_driver_presence(company_id,driver_id,checked_in_at,checkin_method,confirmed,is_present,revision,updated_at)
      VALUES($1,$2,now()-interval '5 minutes','restaurant_qr',true,true,1,now())
      ON CONFLICT(company_id,driver_id) DO UPDATE SET checked_in_at=EXCLUDED.checked_in_at,checkin_method='restaurant_qr',confirmed=true,
        is_present=true,checked_out_at=NULL,revision=${schema}.restaurant_driver_presence.revision+1,updated_at=now()`,[f.otherCompanyId,f.otherDriverId]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
}

function apiServer({ identityService, availability, queue, syncService, logisticsService }) {
  let handlers = [];
  const server = http.createServer(async (req, res) => {
    req.clientIp = '127.0.0.1'; req.requestId = UUID();
    try {
      for (const handler of handlers) if (await handler(req, res)) return;
      if (!res.writableEnded) res.writeHead(404).end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
      if (!res.writableEnded) res.end();
    }
  });
  return { server, setHandlers(origin) {
    const rateLimiter = createRateLimit();
    handlers = [
      createDriverAvailabilityHttpHandler({ identityService, service: availability, rateLimiter, logger: () => {}, allowedOrigin: [origin] }),
      createRestaurantDriverQueueHttpHandler({ identityService, service: queue, rateLimiter, logger: () => {}, allowedOrigin: [origin] }),
      createLogisticsHttpHandler({ identityService, logisticsService, rateLimiter, logger: () => {}, allowedOrigin: [origin] }),
      createSyncHttpHandler({ identityService, syncService, rateLimiter, logger: () => {}, allowedOrigin: [origin] })
    ];
  } };
}

async function fetchJson(origin, path, session, { method = 'GET', body } = {}) {
  const headers = { Origin: origin, Cookie: `__Host-rotamoto_session=${session.token}` };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = session.csrf;
  }
  try {
    const response = await fetch(`${origin}${path}`, { method, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(11000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch (error) { return { status: 0, body: { transportError: error.cause?.code || error.name } }; }
}

async function waitForBlockedRequest(observer, applicationName, expectedBlockerPid, expectedCount = 1) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = await observer.client.query(`SELECT pid,wait_event_type,pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'`, [applicationName]);
    const byPid = new Map(result.rows.map(row => [Number(row.pid), row.blockers.map(Number)]));
    const reachesExpectedBlocker = pid => {
      const visited = new Set();
      const visit = current => {
        if (current === Number(expectedBlockerPid)) return true;
        if (visited.has(current)) return false;
        visited.add(current);
        return (byPid.get(current) || []).some(visit);
      };
      return (byPid.get(pid) || []).some(visit);
    };
    const blocked = result.rows.filter(row => reachesExpectedBlocker(Number(row.pid)));
    if (blocked.length >= expectedCount) return blocked.map(row => Number(row.pid));
    await sleep(10); // Poll the explicit PostgreSQL lock barrier; this delay does not establish ordering.
  }
  throw new Error(`barreira de lock não observada (${applicationName} bloqueada por backend esperado)`);
}

async function readAvailability(client, schema, f) {
  const result = await client.query(schemaSql(schema, `SELECT status,revision,lease_expires_at,lease_session_id
    FROM rotamoto.driver_availability WHERE company_id=$1 AND driver_id=$2`), [f.companyId, f.driverId]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function pushDirect(client, syncService, principal, packet) {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.tenant_id',$1,true)", [principal.company_id]);
  return syncService.push(client, principal, packet);
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test', 'E2E concurrency test requires NODE_ENV=test');
  const targets = createE2eClients(process.env); // exact rotamoto_e2e target is checked before sockets are opened
  const migrations = getMigrations();
  const m0039 = migrations.find(row => row.id === '0039_driver_operational_availability');
  assert(m0039, 'repository includes migration 0039');
  assert.match(CAMPAIGN, /^\d{4}$/u, 'fixture campaign must be a four-digit campaign ID');
  const schema = `campaign${CAMPAIGN}_${UUID().replaceAll('-', '')}`;
  assert.match(schema, new RegExp(`^campaign${CAMPAIGN}_[a-f0-9]{32}$`, 'u'));
  const f = createFixture();
  const fixture = await createFixtureManifest({ campaign: CAMPAIGN, evidence: [
    { kind: 'test', name: 'availability-concurrency-e2e' },
    { kind: 'retention', reason: 'Isolated schema and append-only audit rows are retained; cleanup is prohibited.' }
  ] });
  await fixture.update({ status: 'RUNNING', tenants: [
    { id: f.companyId, counts: { companies: 1, users: 1, roles: 1, drivers: 1 } },
    { id: f.otherCompanyId, counts: { companies: 1, drivers: 1 } }
  ], records: { schemas: [schema], companies: [f.companyId, f.otherCompanyId], users: [f.userId],
    roles: [f.roleId], drivers: [f.driverId, f.otherDriverId], orders: f.deliveries.map(row => row.orderId),
    deliveries: f.deliveries.map(row => row.id), routes: [], evidence: ['two-session concurrency trace'] } });
  const tenantPrincipal = { company_id: f.companyId, user_id: f.userId, role_id:f.roleId, driver_id: f.driverId,
    permissions: ['sync.pull', 'sync.push','orders.manage'], mfa_verified_at: new Date(), mfa_enrollment_required: false };
  let schemaCommitted = false, completed = false, pool, httpHost, origin;
  const trace = [];
  const markLocal = (name, detail = '') => { const item = `${trace.length + 1}:${name}${detail ? `:${detail}` : ''}`; trace.push(item); mark(name, detail); console.log(item); };
  const migrator = targets.migrator;
  let migratorConnected = false;
  try {
    await migrator.connect(); migratorConnected = true;
    await assertConnectedIdentity(migrator, { database: DATABASE, role: MIGRATOR_ROLE });
    const ledger = await migrator.query(`SELECT checksum_sha256 FROM rotamoto.schema_migrations WHERE migration_id=$1`, [m0039.id]);
    assert.equal(ledger.rowCount, 1, 'actual E2E database has migration 0039 recorded');
    assert.equal(ledger.rows[0].checksum_sha256.trim(), m0039.checksum, 'actual E2E ledger checksum matches checked-in 0039');
    const actualSecurity = await migrator.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
      pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [['driver_availability','driver_availability_commands']]);
    assert.deepEqual(actualSecurity.rows.map(row => ({ table: row.relname, rls: row.relrowsecurity,
      force: row.relforcerowsecurity, owner: row.owner })), [
      { table: 'driver_availability', rls: true, force: true, owner: 'rotamoto_migrator' },
      { table: 'driver_availability_commands', rls: true, force: true, owner: 'rotamoto_migrator' }
    ], 'actual rotamoto_e2e 0039 tables preserve owner and FORCE RLS');
    const actualPolicies = await migrator.query(`SELECT tablename,qual,with_check FROM pg_policies
      WHERE schemaname='rotamoto' AND tablename=ANY($1::text[]) ORDER BY tablename`, [['driver_availability','driver_availability_commands']]);
    assert.equal(actualPolicies.rowCount, 2);
    for (const policy of actualPolicies.rows) {
      assert.match(policy.qual, /current_tenant_id/u);
      assert.match(policy.with_check, /current_tenant_id/u);
    }
    markLocal('actual rotamoto_e2e 0039 checksum/RLS/FORCE validated');
    const m0040=migrations.find(row=>row.id==='0040_restaurant_driver_queue');assert(m0040,'repository includes migration 0040');
    const ledger0040=await migrator.query('SELECT checksum_sha256 FROM rotamoto.schema_migrations WHERE migration_id=$1',[m0040.id]);
    assert.equal(ledger0040.rowCount,1,'actual E2E DB has queue migration 0040 applied');assert.equal(ledger0040.rows[0].checksum_sha256.trim(),m0040.checksum);
    const queueSecurity=await migrator.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto'
      AND c.relname=ANY($1::text[]) ORDER BY c.relname`,[['restaurant_dispatch_settings','restaurant_driver_presence','restaurant_presence_qr_nonces']]);
    assert.equal(queueSecurity.rowCount,3);for(const row of queueSecurity.rows){assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);assert.equal(row.owner,'rotamoto_migrator')}
    const queuePolicies=await migrator.query(`SELECT tablename,qual,with_check FROM pg_policies WHERE schemaname='rotamoto' AND tablename=ANY($1::text[])`,[['restaurant_dispatch_settings','restaurant_driver_presence','restaurant_presence_qr_nonces']]);
    assert.equal(queuePolicies.rowCount,3);for(const row of queuePolicies.rows){assert.match(row.qual,/current_tenant_id/u);assert.match(row.with_check,/current_tenant_id/u)}
    markLocal('actual rotamoto_e2e 0040 checksum/RLS/FORCE validated');

    const existingSchema = await migrator.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    assert.equal(existingSchema.rowCount, 0, 'generated schema name is new and owned by this test run');
    await migrator.query('BEGIN');
    try {
      await migrator.query(`CREATE SCHEMA ${schema}`);
      for (const migration of migrations) await migrator.query(migration.up.replace(/\brotamoto\b/gu, schema));
      await migrator.query(`GRANT USAGE ON SCHEMA ${schema} TO rotamoto_app`);
      // Match only the application's established least-privilege identity ACLs
      // from backend/postgres/admin/role-split.sql in this throwaway schema.
      for (const grant of [
        `GRANT SELECT,INSERT,UPDATE ON ${schema}.companies TO rotamoto_app`,
        `GRANT SELECT,INSERT,UPDATE ON ${schema}.credentials TO rotamoto_app`,
        `GRANT SELECT,INSERT,UPDATE ON ${schema}.memberships TO rotamoto_app`,
        `GRANT SELECT ON ${schema}.permissions TO rotamoto_app`,
        `GRANT SELECT ON ${schema}.role_permissions TO rotamoto_app`,
        `GRANT SELECT,INSERT ON ${schema}.roles TO rotamoto_app`,
        `GRANT SELECT,INSERT,UPDATE ON ${schema}.sessions TO rotamoto_app`,
        `GRANT SELECT,INSERT,UPDATE ON ${schema}.users TO rotamoto_app`,
        `GRANT INSERT ON ${schema}.audit_log TO rotamoto_app`,
        `GRANT EXECUTE ON FUNCTION ${schema}.current_tenant_id() TO rotamoto_app`
      ]) await migrator.query(grant);
      await migrator.query('COMMIT'); schemaCommitted = true;
      await fixture.update({ databaseCommitted: true });
    } catch (error) { await migrator.query('ROLLBACK').catch(() => {}); throw error; }
    markLocal('isolated schema migrated inside rotamoto_e2e', `migrations=${migrations.length}`);
    await seedFixture(migrator, schema, f);
    const returnReceiptRaces = await seedReturnReceiptRaces(migrator, schema, f);
    await migrator.query('BEGIN');
    try {
      await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[f.otherCompanyId]);
      await migrator.query(schemaSql(schema,`INSERT INTO rotamoto.restaurant_dispatch_settings(company_id,mode) VALUES($1,'automatic')`),[f.otherCompanyId]);
      await migrator.query(schemaSql(schema,`INSERT INTO rotamoto.restaurant_driver_presence(company_id,driver_id,checked_in_at,checkin_method,confirmed,is_present,revision)
        VALUES($1,$2,now(),'self_reported',false,true,1)`),[f.otherCompanyId,f.otherDriverId]);
      await migrator.query(schemaSql(schema,`INSERT INTO rotamoto.restaurant_presence_qr_nonces(company_id,nonce_id,expires_at) VALUES($1,$2,now()+interval '60 seconds')`),[f.otherCompanyId,UUID()]);
      await migrator.query('COMMIT');
    } catch(error) { await migrator.query('ROLLBACK');throw error; }

    const availability = createDriverAvailabilityService();
    const connectOperation = name => openRuntimeClient({ schema, applicationName: name });
    let canonical;
    const observer = await openRuntimeClient({ applicationName: 'campaign-0112-observer' });
    const qrPair=crypto.generateKeyPairSync('ed25519');
    const queue=createRestaurantDriverQueueService({qrKey:qrPair.privateKey.export({type:'pkcs8',format:'pem'}),qrKid:'e2e0113'});
    const syncService = createSyncService({ driverAvailability: availability,restaurantDriverQueue:queue });
    const logisticsService = createLogisticsService();
    pool = createRuntimePool(schema);
    const identityService = createIdentityService({ pool });
    const host = apiServer({ identityService, availability, queue, syncService, logisticsService }); httpHost = host.server;
    await new Promise((resolve, reject) => { httpHost.once('error', reject); httpHost.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${httpHost.address().port}`; host.setHandlers(origin);
    const sessions = f.sessions;
    const raceReturnReceipt = async ({ scenario, returnId, idempotencyKeys }) => {
      const blocker = await connectOperation(`campaign-0126-return-receipt-${scenario}-barrier`);
      try {
        await blocker.client.query("SELECT set_config('app.tenant_id',$1,false)", [f.companyId]);
        await blocker.client.query('BEGIN');
        const locked = await blocker.client.query(`SELECT record_id FROM rotamoto.domain_records
          WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' FOR UPDATE`, [f.companyId, returnId]);
        assert.equal(locked.rowCount, 1, `${scenario}: independent PostgreSQL transaction locked RETURN ${returnId}`);
        const blockerPid = Number((await blocker.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const requests = sessions.map((session, index) => fetchJson(origin,
          `/api/logistics/returns/${returnId}/receipt`, session, { method: 'POST', body: {
            expectedVersion: 4, idempotencyKey: idempotencyKeys[index], reason: `Recebimento concorrente ${scenario}`
          } }));
        const blocked = await waitForBlockedRequest(observer, 'campaign-0112-api', blockerPid, 2);
        assert.equal(blocked.length, 2, `${scenario}: both independently authenticated HTTP sessions reached the PostgreSQL lock barrier`);
        markLocal(`0126 RETURN receipt ${scenario}: two independent HTTP sessions blocked on PostgreSQL`, `blockedPids=${blocked.length}`);
        await blocker.client.query('COMMIT');
        return await Promise.all(requests);
      } finally {
        await blocker.client.query('ROLLBACK').catch(() => {});
        await endRuntimeClient(blocker.raw);
      }
    };

    const sameReceiptKey = `receipt-race-${UUID()}`;
    const sameKeyResults = await raceReturnReceipt({ scenario: 'same-idempotency-key',
      returnId: returnReceiptRaces[0].returnId, idempotencyKeys: [sameReceiptKey, sameReceiptKey] });
    assert.deepEqual(sameKeyResults.map(row => row.status), [200, 200]);
    assert.equal(sameKeyResults.filter(row => row.body?.duplicate === true).length, 1,
      'same-key concurrent receipt has one original result and one replay');
    const sameKeyCheck = await connectOperation('campaign-0126-return-receipt-same-key-check');
    try {
      await sameKeyCheck.client.query("SELECT set_config('app.tenant_id',$1,false)", [f.companyId]);
      const operations = await sameKeyCheck.client.query(`SELECT count(*)::int AS n FROM rotamoto.delivery_custody_operations
        WHERE company_id=$1 AND operation_type='RECEIPT' AND delivery_id=$2 AND idempotency_key=$3`,
      [f.companyId, returnReceiptRaces[0].returnId, sameReceiptKey]);
      const facts = await sameKeyCheck.client.query(`SELECT count(*)::int AS n FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2
          AND payload->>'type'='DELIVERY_RETURN_RECEIPT_CONFIRMED'`, [f.companyId, returnReceiptRaces[0].returnId]);
      assert.equal(operations.rows[0].n, 1, 'same-key race commits one durable receipt operation');
      assert.equal(facts.rows[0].n, 1, 'same-key race emits one receipt fact');
    } finally { await endRuntimeClient(sameKeyCheck.raw); }
    markLocal('0126 same-key concurrent RETURN receipt: one durable operation and one receipt fact');

    const differentKeyResults = await raceReturnReceipt({ scenario: 'distinct-idempotency-keys',
      returnId: returnReceiptRaces[1].returnId, idempotencyKeys: [`receipt-race-a-${UUID()}`, `receipt-race-b-${UUID()}`] });
    assert.equal(differentKeyResults.filter(row => row.status === 200 && row.body?.duplicate !== true).length, 1,
      JSON.stringify(differentKeyResults.map(row => ({ status: row.status, body: row.body }))));
    const losingReceipt = differentKeyResults.find(row => row.status === 409 || row.body?.duplicate === true);
    assert.ok(losingReceipt && (losingReceipt.status === 409 || (losingReceipt.status === 200 && losingReceipt.body?.duplicate === true)),
      'distinct-key race either rejects the stale revision or converges as already received');
    if (losingReceipt.status === 409) assert.equal(losingReceipt.body.error.code, 'REVISION_CONFLICT');
    const distinctCheck = await connectOperation('campaign-0126-return-receipt-distinct-key-check');
    try {
      await distinctCheck.client.query("SELECT set_config('app.tenant_id',$1,false)", [f.companyId]);
      const final = await distinctCheck.client.query(`SELECT payload->>'status' AS status,
        payload->'extensions'->>'x_rotamoto_custody_state' AS custody,version FROM rotamoto.domain_records
        WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`, [f.companyId, returnReceiptRaces[1].returnId]);
      const facts = await distinctCheck.client.query(`SELECT count(*)::int AS n FROM rotamoto.domain_records
        WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2
          AND payload->>'type'='DELIVERY_RETURN_RECEIPT_CONFIRMED'`, [f.companyId, returnReceiptRaces[1].returnId]);
      assert.equal(final.rows[0].status, 'RETURNED');
      assert.equal(final.rows[0].custody, 'RECEIVED');
      assert.equal(Number(final.rows[0].version), 5);
      assert.equal(facts.rows[0].n, 1, 'distinct-key race accepts one receipt event only');
    } finally { await endRuntimeClient(distinctCheck.raw); }
    markLocal('0126 distinct-key concurrent RETURN receipt: one accepted receipt, loser is stale 409 or convergent duplicate');

    for (const session of sessions) {
      const authenticated = await fetchJson(origin, '/api/driver-availability', session);
      assert.equal(authenticated.status, 200, JSON.stringify(authenticated.body));
      assert.equal(authenticated.body.availability.effectiveStatus, 'online');
    }
    markLocal('two authenticated sessions resolve to the same Driver');

    // 0113: the signed, short-lived restaurant QR is a physical-presence proof.
    // The same transaction stores server time, consumes the nonce, and makes
    // the confirmed Online/unoccupied Driver eligible in the FIFO queue.
    const qr=await fetchJson(origin,'/api/restaurant-driver-queue/qr',sessions[0],{method:'POST',body:{}});
    assert.equal(qr.status,200,JSON.stringify(qr.body));
    const invalidQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:`${qr.body.token}tampered`}});
    assert.equal(invalidQr.status,400);assert.equal(invalidQr.body.error.code,'PRESENCE_QR_INVALID');
    const tokenNow=Math.floor(Date.now()/1000), tokenBase={v:1,jti:UUID(),kid:'e2e0113',iat:tokenNow,exp:tokenNow+60};
    const foreignQr=signedPresenceToken(qrPair,{...tokenBase,c:f.otherCompanyId});
    const crossTenantQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:foreignQr}});
    assert.equal(crossTenantQr.status,403);assert.equal(crossTenantQr.body.error.code,'PRESENCE_QR_TENANT_MISMATCH');
    const expiredQr=signedPresenceToken(qrPair,{...tokenBase,c:f.companyId,iat:tokenNow-120,exp:tokenNow-60});
    const expiredCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:expiredQr}});
    assert.equal(expiredCheckIn.status,400);assert.equal(expiredCheckIn.body.error.code,'PRESENCE_QR_INVALID');
    const presenceCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:qr.body.token}});
    assert.equal(presenceCheckIn.status,200,JSON.stringify(presenceCheckIn.body));
    assert.equal(presenceCheckIn.body.presence.confirmed,true);
    assert.equal(presenceCheckIn.body.presence.method,'restaurant_qr');
    const replayQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[1],{method:'POST',body:{token:qr.body.token}});
    assert.equal(replayQr.status,409);assert.equal(replayQr.body.error.code,'PRESENCE_QR_REPLAY');
    const repeatedCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/check-in',sessions[1],{method:'POST',body:{}});
    assert.equal(repeatedCheckIn.status,200);assert.equal(repeatedCheckIn.body.presence.duplicate,true);
    assert.equal(repeatedCheckIn.body.presence.checkedInAt,presenceCheckIn.body.presence.checkedInAt,'duplicate check-in preserves server FIFO timestamp');
    const firstQueue=await fetchJson(origin,'/api/restaurant-driver-queue',sessions[0]);
    assert.equal(firstQueue.status,200);assert.equal(firstQueue.body.presence.eligible,true);assert.equal(firstQueue.body.presence.position,1);
    const tiedDriverId='ffffffff-ffff-4fff-8fff-ffffffffffff';
    const tiedDriver=driverRecord(f,tiedDriverId,f.companyId,f.restaurantInstallId);
    await migrator.query('BEGIN');
    try {
      await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
      await migrator.query(schemaSql(schema,`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,1,$7,$8)`),tiedDriver);
      await migrator.query(schemaSql(schema,`INSERT INTO rotamoto.driver_availability(company_id,driver_id,status,revision,lease_expires_at,lease_session_id,updated_by_user_id)
        VALUES($1,$2,'online',1,now()+interval '120 seconds',$3,$4)`),[f.companyId,tiedDriverId,sessions[0].id,f.userId]);
      await migrator.query(schemaSql(schema,`INSERT INTO rotamoto.restaurant_driver_presence(company_id,driver_id,checked_in_at,checkin_method,confirmed,is_present,revision,updated_at)
        VALUES($1,$2,$3,'restaurant_qr',true,true,1,$3)`),[f.companyId,tiedDriverId,firstQueue.body.presence.checkedInAt]);
      await migrator.query('COMMIT');
    } catch(error) { await migrator.query('ROLLBACK');throw error; }
    const queueReader=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-fifo-tie'});
    const tiedQueue=await queue.getQueue(queueReader.client,{...tenantPrincipal,driver_id:null});
    assert.deepEqual(tiedQueue.queue.map(row=>row.driverId),[f.driverId,tiedDriverId],'equal PostgreSQL arrival timestamps use deterministic ascending Driver UUID as tie-breaker');
    await endRuntimeClient(queueReader.raw);
    await migrator.query('BEGIN');
    await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    const tieCleanup=await migrator.query(schemaSql(schema,`UPDATE rotamoto.restaurant_driver_presence SET is_present=false,checked_out_at=now(),revision=revision+1 WHERE company_id=$1 AND driver_id=$2`),[f.companyId,tiedDriverId]);
    assert.equal(tieCleanup.rowCount,1,'tie-only synthetic Driver is removed from the active queue after the FIFO assertion');
    await migrator.query('COMMIT');
    markLocal('0113: equal server FIFO timestamps have deterministic Driver UUID tie-break; tenant-scoped queue query returns canonical order');
    markLocal('0113: authenticated QR check-in, tamper/replay rejection, duplicate idempotency and server FIFO timestamp confirmed');

    // 0114 regression: an unassigned manual redelivery request must persist as
    // REDELIVERY and retain the existing immutable failure event.
    const manualRedeliveryFixture=await seedRedeliveryFixture(migrator,schema,f);
    const manualRedeliveryPacket=unassignedRedeliveryPacket(f,manualRedeliveryFixture);
    const manualRedeliveryResponse=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:manualRedeliveryPacket});
    assert.equal(manualRedeliveryResponse.status,200,JSON.stringify(manualRedeliveryResponse.body));
    assert.equal(manualRedeliveryResponse.body.operationResults[0].status,'accepted',JSON.stringify(manualRedeliveryResponse.body));
    const manualRedeliveryState=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0114-manual-redelivery'});
    const manualRedeliveryRow=await manualRedeliveryState.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,manualRedeliveryFixture.deliveryId]);
    assert.equal(manualRedeliveryRow.rows[0].payload.status,'REDELIVERY');assert.equal(manualRedeliveryRow.rows[0].payload.driverId,null);
    const manualRedeliveryHistory=await manualRedeliveryState.client.query(`SELECT count(*)::int AS n FROM ${schema}.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2`,[f.companyId,manualRedeliveryFixture.deliveryId]);
    assert.equal(manualRedeliveryHistory.rows[0].n,1,'manual retry preserves the immutable failure event');
    await endRuntimeClient(manualRedeliveryState.raw);
    markLocal('0114 manual mode: unassigned REDELIVERY persisted without silent allocation; failure event retained');

    const autoMode=await fetchJson(origin,'/api/restaurant-driver-queue/settings',sessions[0],{method:'POST',body:{mode:'automatic',expectedRevision:0}});
    assert.equal(autoMode.status,200,JSON.stringify(autoMode.body));assert.equal(autoMode.body.settings.mode,'automatic');
    // Expected to expose any mismatch between the REDELIVERY→ASSIGNED contract
    // and the dispatcher’s status mutation before making a product correction.
    const automaticRedeliveryFixture=await seedRedeliveryFixture(migrator,schema,f);
    const automaticRedeliveryPacket=unassignedRedeliveryPacket(f,automaticRedeliveryFixture);
    const automaticRedeliveryResponse=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:automaticRedeliveryPacket});
    assert.equal(automaticRedeliveryResponse.status,200,JSON.stringify(automaticRedeliveryResponse.body));
    assert.equal(automaticRedeliveryResponse.body.operationResults[0].status,'accepted',JSON.stringify(automaticRedeliveryResponse.body));
    const automaticRedeliveryState=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0114-auto-redelivery-readback'});
    const automaticRedeliveryRow=await automaticRedeliveryState.client.query(`SELECT payload,version FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,automaticRedeliveryFixture.deliveryId]);
    assert.equal(automaticRedeliveryRow.rows[0].payload.status,'ASSIGNED');assert.equal(automaticRedeliveryRow.rows[0].payload.driverId,f.driverId);assert.equal(Number(automaticRedeliveryRow.rows[0].version),2);
    const automaticRedeliveryHistory=await automaticRedeliveryState.client.query(`SELECT count(*)::int AS n FROM ${schema}.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2`,[f.companyId,automaticRedeliveryFixture.deliveryId]);
    assert.equal(automaticRedeliveryHistory.rows[0].n,1,'automatic re-delivery retains the immutable failure event without fabricating execution events');
    await migrator.query("SELECT set_config('app.tenant_id',$1,false)",[f.companyId]);
    const redeliveryAudit=await migrator.query(`SELECT details FROM ${schema}.audit_log WHERE company_id=$1 AND action='delivery.redelivery.requested' AND resource_id=$2`,[f.companyId,automaticRedeliveryFixture.deliveryId]);
    assert.equal(redeliveryAudit.rowCount,1);assert.equal(redeliveryAudit.rows[0].details.assignedAutomatically,true);
    await endRuntimeClient(automaticRedeliveryState.raw);
    const retryAutomaticRedelivery=await fetchJson(origin,'/api/sync/push',sessions[1],{method:'POST',body:automaticRedeliveryPacket});
    assert.equal(retryAutomaticRedelivery.status,200);assert.equal(retryAutomaticRedelivery.body.duplicate,true);
    markLocal('0114 automatic mode: real unassigned REDELIVERY followed FAILED→REDELIVERY→ASSIGNED, retained history/audit, retry idempotent');
    for(const type of ['DELIVERY_ACCEPTED','DELIVERY_PICKED_UP','DELIVERY_STARTED','DELIVERY_COMPLETED']){
      const eventResult=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:deliveryExecutionPacket(f,automaticRedeliveryFixture.deliveryId,type)});
      assert.equal(eventResult.status,200,JSON.stringify(eventResult.body));assert.equal(eventResult.body.operationResults[0].status,'accepted',JSON.stringify(eventResult.body));
    }
    const nextQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr',sessions[0],{method:'POST',body:{}});
    const nextCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:nextQr.body.token}});
    assert.equal(nextCheckIn.status,200,JSON.stringify(nextCheckIn.body));
    const ready=readyDeliveryPacket(f);
    const autoDispatch=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:ready.packet});
    assert.equal(autoDispatch.status,200,JSON.stringify(autoDispatch.body));assert.equal(autoDispatch.body.operationResults[1].status,'accepted',JSON.stringify(autoDispatch.body));
    markLocal('0113: automatic ready-delivery sync response',JSON.stringify(autoDispatch.body.operationResults));
    const autoDeliveryId=autoDispatch.body.operationResults.find(row=>row.entity==='Delivery').canonicalId;
    const autoState=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-auto-readback'});
    const dispatched=await autoState.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,autoDeliveryId]);
    assert.equal(dispatched.rowCount,1,`canonical Delivery missing: ${JSON.stringify(autoDispatch.body.operationResults)}`);assert.equal(dispatched.rows[0].payload.status,'ASSIGNED');assert.equal(dispatched.rows[0].payload.driverId,f.driverId);
    const consumedPresence=await autoState.client.query(`SELECT is_present,revision FROM ${schema}.restaurant_driver_presence WHERE company_id=$1 AND driver_id=$2`,[f.companyId,f.driverId]);
    assert.equal(consumedPresence.rows[0].is_present,false);await endRuntimeClient(autoState.raw);
    const duplicateAuto=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:ready.packet});assert.equal(duplicateAuto.status,200);assert.equal(duplicateAuto.body.duplicate,true);
    markLocal('0113: real sync push dispatches only CREATED delivery through confirmed FIFO presence; retry is idempotent');

    const manualMode=await fetchJson(origin,'/api/restaurant-driver-queue/settings',sessions[0],{method:'POST',body:{mode:'manual',expectedRevision:autoMode.body.settings.revision}});
    assert.equal(manualMode.status,200);
    const manualReady=readyDeliveryPacket(f);
    const noSilentDispatch=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:manualReady.packet});
    assert.equal(noSilentDispatch.status,200,JSON.stringify(noSilentDispatch.body));
    const manualDeliveryId=noSilentDispatch.body.operationResults.find(row=>row.entity==='Delivery').canonicalId;
    const manualState=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-manual-readback'});
    const pendingManual=await manualState.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,manualDeliveryId]);
    assert.equal(pendingManual.rows[0].payload.status,'CREATED');assert.equal(pendingManual.rows[0].payload.driverId,null);await endRuntimeClient(manualState.raw);
    markLocal('0113: manual mode persists on server and does not silently assign new CREATED delivery');

    // Finish the first automatically assigned Delivery through the real
    // Motoboy event contract, then verify self-report requires an operator
    // confirmation before it can enter the automatic queue.
    for(const type of ['DELIVERY_ACCEPTED','DELIVERY_PICKED_UP','DELIVERY_STARTED','DELIVERY_COMPLETED']){
      const eventResult=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:deliveryExecutionPacket(f,autoDeliveryId,type)});
      assert.equal(eventResult.status,200,JSON.stringify(eventResult.body));
      assert.equal(eventResult.body.operationResults[0].status,'accepted',JSON.stringify(eventResult.body));
    }
    const selfCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/check-in',sessions[0],{method:'POST',body:{}});
    assert.equal(selfCheckIn.status,200,JSON.stringify(selfCheckIn.body));assert.equal(selfCheckIn.body.presence.confirmed,false);
    const selfQueue=await fetchJson(origin,'/api/restaurant-driver-queue',sessions[0]);assert.equal(selfQueue.body.presence.eligible,false);
    const unconfirmedReader=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-unconfirmed-readback'});
    const unconfirmedRestaurantQueue=await queue.getQueue(unconfirmedReader.client,{...tenantPrincipal,driver_id:null});
    assert.equal(unconfirmedRestaurantQueue.records.find(row=>row.driverId===f.driverId)?.eligible,false);
    assert.equal(unconfirmedRestaurantQueue.queue.some(row=>row.driverId===f.driverId),false,'self-reported presence never appears as eligible in the Restaurant FIFO view');
    await endRuntimeClient(unconfirmedReader.raw);
    const confirmQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr',sessions[0],{method:'POST',body:{}});
    const qrUpgrade=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:confirmQr.body.token}});
    assert.equal(qrUpgrade.status,200,JSON.stringify(qrUpgrade.body));assert.equal(qrUpgrade.body.presence.confirmed,true);
    assert.equal(qrUpgrade.body.presence.checkedInAt,selfCheckIn.body.presence.checkedInAt,'QR confirms a self-reported presence without moving FIFO time');
    const confirmedReader=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-confirmed-readback'});
    const confirmedRestaurantQueue=await queue.getQueue(confirmedReader.client,{...tenantPrincipal,driver_id:null});
    assert.equal(confirmedRestaurantQueue.queue.some(row=>row.driverId===f.driverId),true,'Restaurant FIFO view includes the driver only after physical confirmation');
    await endRuntimeClient(confirmedReader.raw);
    await fetchJson(origin,'/api/restaurant-driver-queue/check-out',sessions[0],{method:'POST',body:{}});
    await fetchJson(origin,'/api/restaurant-driver-queue/check-in',sessions[0],{method:'POST',body:{}});
    const operatorConfirm=await fetchJson(origin,'/api/restaurant-driver-queue/confirm',sessions[0],{method:'POST',body:{driverId:f.driverId}});
    assert.equal(operatorConfirm.status,200,JSON.stringify(operatorConfirm.body));
    const confirmedQueue=await fetchJson(origin,'/api/restaurant-driver-queue',sessions[0]);assert.equal(confirmedQueue.body.presence.eligible,true);
    markLocal('0113: manual button is self-reported only; operator confirmation enables automatic eligibility after real delivery completion');

    // Automatic A: Offline takes the canonical Driver/availability locks;
    // the real Restaurant sync request reaches a second PostgreSQL backend
    // while that transaction is open. The barrier observes its lock wait.
    const autoOfflineFirst=await connectOperation('campaign-0113-auto-offline-first');
    await autoOfflineFirst.client.query('BEGIN');await autoOfflineFirst.client.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    const currentAvailability=await readAvailability(autoOfflineFirst.client,schema,f);
    const offlineBeforeAuto=await availability.set(autoOfflineFirst.client,{...tenantPrincipal,session_id:sessions[0].id},{desiredStatus:'offline',expectedRevision:Number(currentAvailability.revision),commandId:UUID()});
    assert.equal(offlineBeforeAuto.availability.effectiveStatus,'offline');
    const autoBlockedByOffline=readyDeliveryPacket(f);
    const autoBlockedResponsePromise=fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:autoBlockedByOffline.packet});
    // Auto dispatch uses SKIP LOCKED for FIFO candidates. Observe its response
    // while Offline still owns the locks: the dispatcher must skip the locked
    // Driver and persist the new Delivery as CREATED, rather than wait or assign.
    const autoBlockedResponse=await autoBlockedResponsePromise;assert.equal(autoBlockedResponse.status,200,JSON.stringify(autoBlockedResponse.body));
    const blockedDeliveryId=autoBlockedResponse.body.operationResults.find(row=>row.entity==='Delivery').canonicalId;
    const remainsPendingWhileOfflineUncommitted=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-auto-offline-inflight'});
    const inflightState=await remainsPendingWhileOfflineUncommitted.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,blockedDeliveryId]);
    assert.equal(inflightState.rows[0].payload.status,'CREATED');assert.equal(inflightState.rows[0].payload.driverId,null);
    await endRuntimeClient(remainsPendingWhileOfflineUncommitted.raw);
    await autoOfflineFirst.client.query('COMMIT');await endRuntimeClient(autoOfflineFirst.raw);
    const offlineRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-auto-offline-readback'});
    const remainsPending=await offlineRead.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,blockedDeliveryId]);
    assert.equal(remainsPending.rows[0].payload.status,'CREATED');assert.equal(remainsPending.rows[0].payload.driverId,null);await endRuntimeClient(offlineRead.raw);
    markLocal('0113 auto A: real automatic dispatch ran concurrently while Offline held locks; SKIP LOCKED kept Delivery pending before Offline commit');

    // Returning Online does not restore old presence; a new one-use QR check-in
    // puts the Driver back at the FIFO tail before the inverse race.
    const automaticAgain=await fetchJson(origin,'/api/restaurant-driver-queue/settings',sessions[0],{method:'POST',body:{mode:'automatic',expectedRevision:manualMode.body.settings.revision}});
    assert.equal(automaticAgain.status,200);
    canonical=await fetchJson(origin,'/api/driver-availability',sessions[0]);
    const returnedOnline=await fetchJson(origin,'/api/driver-availability/commands',sessions[0],{method:'POST',body:{desiredStatus:'online',expectedRevision:canonical.body.availability.revision,commandId:UUID()}});
    assert.equal(returnedOnline.status,200);const noStalePresence=await fetchJson(origin,'/api/restaurant-driver-queue',sessions[0]);assert.equal(noStalePresence.body.presence.present,false);
    const returningQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr',sessions[0],{method:'POST',body:{}});
    const returningCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:returningQr.body.token}});
    assert.equal(returningCheckIn.status,200);assert.equal(returningCheckIn.body.presence.confirmed,true);
    assert(Date.parse(returningCheckIn.body.presence.checkedInAt)>Date.parse(presenceCheckIn.body.presence.checkedInAt),'return enters at a new server timestamp at the FIFO tail');

    // 0114: exercise the same deterministic Offline × automatic-redelivery
    // interleavings through sync-push (not a dispatcher stub).
    const redeliveryOfflineTx=await connectOperation('campaign-0114-redelivery-offline-first');
    await redeliveryOfflineTx.client.query('BEGIN');
    await redeliveryOfflineTx.client.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    const beforeRedeliveryOffline=await readAvailability(redeliveryOfflineTx.client,schema,f);
    const offlineRedeliveryFirstCommand=await availability.set(redeliveryOfflineTx.client,{...tenantPrincipal,session_id:sessions[0].id},
      {desiredStatus:'offline',expectedRevision:Number(beforeRedeliveryOffline.revision),commandId:UUID()});
    assert.equal(offlineRedeliveryFirstCommand.availability.effectiveStatus,'offline');
    const offlineFirstFixture=await seedRedeliveryFixture(migrator,schema,f);
    const offlineFirstPacket=unassignedRedeliveryPacket(f,offlineFirstFixture);
    const offlineFirstDispatchTx=await connectOperation('campaign-0114-redelivery-dispatch-offline-first');
    let offlineFirstResponse;
    try {
      offlineFirstResponse=await pushDirect(offlineFirstDispatchTx.client,syncService,tenantPrincipal,offlineFirstPacket);
      await offlineFirstDispatchTx.client.query('COMMIT');
    } catch(error) {
      await offlineFirstDispatchTx.client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { await endRuntimeClient(offlineFirstDispatchTx.raw); }
    assert.equal(offlineFirstResponse.operationResults[0].status,'accepted',JSON.stringify(offlineFirstResponse));
    const offlineFirstRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0114-redelivery-offline-readback'});
    const offlineFirstState=await offlineFirstRead.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,offlineFirstFixture.deliveryId]);
    assert.equal(offlineFirstState.rows[0].payload.status,'REDELIVERY');assert.equal(offlineFirstState.rows[0].payload.driverId,null,
      'automatic redelivery must remain unassigned when the only FIFO candidate is locked Offline');
    const offlineFirstRevocation=await offlineFirstRead.client.query(`SELECT count(*)::int AS n FROM ${schema}.sync_outbox WHERE company_id=$1 AND payload->>'type'='CANONICAL_ASSIGNMENT_REVOKED' AND payload->>'entityId'=$2`,[f.companyId,offlineFirstFixture.deliveryId]);
    assert.equal(offlineFirstRevocation.rows[0].n,0,'terminal failure does not create an active-assignment revocation or block on its recipient');
    await endRuntimeClient(offlineFirstRead.raw);
    await redeliveryOfflineTx.client.query('COMMIT');await endRuntimeClient(redeliveryOfflineTx.raw);
    const retryOfflineRedelivery=await fetchJson(origin,'/api/sync/push',sessions[1],{method:'POST',body:offlineFirstPacket});
    assert.equal(retryOfflineRedelivery.status,200);assert.equal(retryOfflineRedelivery.body.duplicate,true);
    canonical=await fetchJson(origin,'/api/driver-availability',sessions[0]);
    const onlineAfterRedeliveryOffline=await fetchJson(origin,'/api/driver-availability/commands',sessions[0],{method:'POST',body:{desiredStatus:'online',expectedRevision:canonical.body.availability.revision,commandId:UUID()}});
    assert.equal(onlineAfterRedeliveryOffline.status,200,JSON.stringify(onlineAfterRedeliveryOffline.body));
    const redeliveryReturnQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr',sessions[0],{method:'POST',body:{}});
    const redeliveryReturnCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:redeliveryReturnQr.body.token}});
    assert.equal(redeliveryReturnCheckIn.status,200,JSON.stringify(redeliveryReturnCheckIn.body));
    markLocal('0114 re-delivery Offline-first: canonical Offline committed; real automatic re-delivery stayed REDELIVERY/unassigned; retry idempotent');

    const assignmentFirstFixture=await seedRedeliveryFixture(migrator,schema,f);
    const assignmentFirstPacket=unassignedRedeliveryPacket(f,assignmentFirstFixture);
    const assignmentFirstTx=await connectOperation('campaign-0114-redelivery-assignment-first');
    const assignmentFirstPid=(await assignmentFirstTx.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const assignmentFirstResult=await pushDirect(assignmentFirstTx.client,syncService,tenantPrincipal,assignmentFirstPacket);
    assert.equal(assignmentFirstResult.operationResults[0].status,'accepted',JSON.stringify(assignmentFirstResult));
    const assignedRedeliveryId=assignmentFirstResult.operationResults[0].canonicalId;
    const assignedRedeliveryOpen=await assignmentFirstTx.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,assignedRedeliveryId]);
    assert.equal(assignedRedeliveryOpen.rows[0].payload.status,'ASSIGNED');assert.equal(assignedRedeliveryOpen.rows[0].payload.driverId,f.driverId);
    canonical=await fetchJson(origin,'/api/driver-availability',sessions[1]);
    const offlineAfterRedeliveryPromise=fetchJson(origin,'/api/driver-availability/commands',sessions[1],{method:'POST',body:{desiredStatus:'offline',expectedRevision:canonical.body.availability.revision,commandId:UUID()}});
    await waitForBlockedRequest(observer,'campaign-0112-api',assignmentFirstPid);
    await assignmentFirstTx.client.query('COMMIT');await endRuntimeClient(assignmentFirstTx.raw);
    const offlineAfterRedelivery=await offlineAfterRedeliveryPromise;
    assert.equal(offlineAfterRedelivery.status,200,JSON.stringify(offlineAfterRedelivery.body));
    const assignmentRetry=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:assignmentFirstPacket});
    assert.equal(assignmentRetry.status,200);assert.equal(assignmentRetry.body.duplicate,true);
    const assignedRedeliveryRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0114-redelivery-assignment-readback'});
    const assignedRedeliveryFinal=await assignedRedeliveryRead.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,assignedRedeliveryId]);
    assert.equal(assignedRedeliveryFinal.rows[0].payload.status,'ASSIGNED');assert.equal(assignedRedeliveryFinal.rows[0].payload.driverId,f.driverId);
    const assignedRedeliveryEvents=await assignedRedeliveryRead.client.query(`SELECT count(*)::int AS n FROM ${schema}.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2`,[f.companyId,assignedRedeliveryId]);
    assert.equal(assignedRedeliveryEvents.rows[0].n,1,'assignment-first redelivery retains the failure event exactly once');
    await endRuntimeClient(assignedRedeliveryRead.raw);
    markLocal('0114 re-delivery assignment-first: real automatic sync assignment committed before Offline; assignment/history retained and retry idempotent');
    for(const type of ['DELIVERY_ACCEPTED','DELIVERY_PICKED_UP','DELIVERY_STARTED','DELIVERY_COMPLETED']){
      const result=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:deliveryExecutionPacket(f,assignedRedeliveryId,type)});
      assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.operationResults[0].status,'accepted',JSON.stringify(result.body));
    }
    canonical=await fetchJson(origin,'/api/driver-availability',sessions[0]);
    const onlineAfterRedeliveryAssignment=await fetchJson(origin,'/api/driver-availability/commands',sessions[0],{method:'POST',body:{desiredStatus:'online',expectedRevision:canonical.body.availability.revision,commandId:UUID()}});
    assert.equal(onlineAfterRedeliveryAssignment.status,200);
    const finalRedeliveryQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr',sessions[0],{method:'POST',body:{}});
    const finalRedeliveryCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:finalRedeliveryQr.body.token}});
    assert.equal(finalRedeliveryCheckIn.status,200);

    // Two real REDELIVERY sync operations contend for the FIFO settings row
    // and the two eligible Drivers through independent PostgreSQL sessions.
    await migrator.query('BEGIN');
    await migrator.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    await migrator.query(schemaSql(schema,`UPDATE rotamoto.restaurant_driver_presence SET is_present=true,confirmed=true,checked_in_at=now()-interval '1 second',checked_out_at=NULL,revision=revision+1,updated_at=now()
      WHERE company_id=$1 AND driver_id=$2`),[f.companyId,tiedDriverId]);
    await migrator.query('COMMIT');
    const simultaneousOne=await seedRedeliveryFixture(migrator,schema,f),simultaneousTwo=await seedRedeliveryFixture(migrator,schema,f);
    const simultaneousPacketOne=unassignedRedeliveryPacket(f,simultaneousOne),simultaneousPacketTwo=unassignedRedeliveryPacket(f,simultaneousTwo);
    const firstAutoRedeliveryTx=await connectOperation('campaign-0114-simultaneous-redelivery-a');
    const secondAutoRedeliveryTx=await connectOperation('campaign-0112-api');
    await firstAutoRedeliveryTx.client.query('BEGIN');await firstAutoRedeliveryTx.client.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    await secondAutoRedeliveryTx.client.query('BEGIN');await secondAutoRedeliveryTx.client.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
    const simultaneousPid=(await firstAutoRedeliveryTx.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const firstAutoRedelivery=await pushDirect(firstAutoRedeliveryTx.client,syncService,tenantPrincipal,simultaneousPacketOne);
    assert.equal(firstAutoRedelivery.operationResults[0].status,'accepted',JSON.stringify(firstAutoRedelivery));
    const secondAutoRedeliveryPromise=pushDirect(secondAutoRedeliveryTx.client,syncService,tenantPrincipal,simultaneousPacketTwo);
    await waitForBlockedRequest(observer,'campaign-0112-api',simultaneousPid);
    await firstAutoRedeliveryTx.client.query('COMMIT');await endRuntimeClient(firstAutoRedeliveryTx.raw);
    const secondAutoRedelivery=await secondAutoRedeliveryPromise;
    assert.equal(secondAutoRedelivery.operationResults[0].status,'accepted',JSON.stringify(secondAutoRedelivery));
    await secondAutoRedeliveryTx.client.query('COMMIT');await endRuntimeClient(secondAutoRedeliveryTx.raw);
    const simultaneousIds=[firstAutoRedelivery.operationResults[0].canonicalId,secondAutoRedelivery.operationResults[0].canonicalId];
    const simultaneousRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0114-simultaneous-redelivery-readback'});
    const simultaneousRows=await simultaneousRead.client.query(`SELECT record_id::text AS id,payload->>'status' AS status,payload->>'driverId' AS driver_id FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=ANY($2::uuid[]) ORDER BY record_id`,[f.companyId,simultaneousIds]);
    assert.equal(simultaneousRows.rowCount,2);assert(simultaneousRows.rows.every(row=>row.status==='ASSIGNED'));
    assert.deepEqual(new Set(simultaneousRows.rows.map(row=>row.driver_id)),new Set([f.driverId,tiedDriverId]),'simultaneous automatic redeliveries must allocate distinct FIFO Drivers');
    const simultaneousRetry=await fetchJson(origin,'/api/sync/push',sessions[1],{method:'POST',body:simultaneousPacketOne});
    assert.equal(simultaneousRetry.status,200);assert.equal(simultaneousRetry.body.duplicate,true);
    const simultaneousOwnedBySession=simultaneousRows.rows.find(row=>row.driver_id===f.driverId);
    assert(simultaneousOwnedBySession,'one concurrent assignment belongs to the authenticated fixture Driver');
    for(const type of ['DELIVERY_ACCEPTED','DELIVERY_PICKED_UP','DELIVERY_STARTED','DELIVERY_COMPLETED']){
      const result=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:deliveryExecutionPacket(f,simultaneousOwnedBySession.id,type)});
      assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.operationResults[0].status,'accepted',JSON.stringify(result.body));
    }
    const afterSimultaneousQr=await fetchJson(origin,'/api/restaurant-driver-queue/qr',sessions[0],{method:'POST',body:{}});
    const afterSimultaneousCheckIn=await fetchJson(origin,'/api/restaurant-driver-queue/qr-check-in',sessions[0],{method:'POST',body:{token:afterSimultaneousQr.body.token}});
    assert.equal(afterSimultaneousCheckIn.status,200,JSON.stringify(afterSimultaneousCheckIn.body));
    await endRuntimeClient(simultaneousRead.raw);
    markLocal('0114 concurrent auto redelivery: two independent real sync transactions serialized at FIFO lock, assigned distinct eligible Drivers, preserved idempotency/history');

    // Automatic B: the real sync transaction assigns and holds Driver,
    // availability, presence, settings, and Delivery locks. A second session's
    // Offline command is observed waiting on that backend before commit.
    const autoAssignBeforeOffline=readyDeliveryPacket(f);
    const autoAssignmentTx=await connectOperation('campaign-0113-auto-assignment-first');
    const autoAssignmentPid=(await autoAssignmentTx.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const autoAssignmentResult=await pushDirect(autoAssignmentTx.client,syncService,tenantPrincipal,autoAssignBeforeOffline.packet);
    assert.equal(autoAssignmentResult.operationResults.find(row=>row.entity==='Delivery').status,'accepted',JSON.stringify(autoAssignmentResult));
    const assignedWhileOpen=await autoAssignmentTx.client.query(`SELECT payload->>'status' AS status,payload->>'driverId' AS driver_id FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2`,[f.companyId,autoAssignmentResult.operationResults.find(row=>row.entity==='Delivery').canonicalId]);
    assert.equal(assignedWhileOpen.rows[0]?.status,'ASSIGNED',`real automatic dispatch must assign before the race barrier: ${JSON.stringify(assignedWhileOpen.rows[0])}`);
    assert.equal(assignedWhileOpen.rows[0]?.driver_id,f.driverId);
    const availabilityBeforeAutoOffline=await fetchJson(origin,'/api/driver-availability',sessions[1]);
    const racingOffline=fetchJson(origin,'/api/driver-availability/commands',sessions[1],{method:'POST',body:{desiredStatus:'offline',expectedRevision:availabilityBeforeAutoOffline.body.availability.revision,commandId:UUID()}});
    let autoBlockedPids;
    try{autoBlockedPids=await waitForBlockedRequest(observer,'campaign-0112-api',autoAssignmentPid)}catch(error){const response=await racingOffline;throw new Error(`${error.message}; offline response=${JSON.stringify(response)}`)}
    assert.equal(autoBlockedPids.length,1);await autoAssignmentTx.client.query('COMMIT');await endRuntimeClient(autoAssignmentTx.raw);
    const offlineAfterAuto=await racingOffline;assert.equal(offlineAfterAuto.status,200,JSON.stringify(offlineAfterAuto.body));assert.equal(offlineAfterAuto.body.availability.effectiveStatus,'offline');
    const assignedAutoId=autoAssignmentResult.operationResults.find(row=>row.entity==='Delivery').canonicalId;
    const autoBRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-auto-b-readback'});
    const autoBState=await autoBRead.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,assignedAutoId]);
    assert.equal(autoBState.rows[0].payload.status,'ASSIGNED');assert.equal(autoBState.rows[0].payload.driverId,f.driverId);await endRuntimeClient(autoBRead.raw);
    const autoRetry=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:autoAssignBeforeOffline.packet});assert.equal(autoRetry.status,200);assert.equal(autoRetry.body.duplicate,true);
    const noAutoWhileOffline=readyDeliveryPacket(f);const noAutoAfterOffline=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:noAutoWhileOffline.packet});
    const noAutoId=noAutoAfterOffline.body.operationResults.find(row=>row.entity==='Delivery').canonicalId;
    const noAutoRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0113-auto-offline-followup'});
    const stillPending=await noAutoRead.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,noAutoId]);
    assert.equal(stillPending.rows[0].payload.status,'CREATED');assert.equal(stillPending.rows[0].payload.driverId,null);await endRuntimeClient(noAutoRead.raw);
    markLocal('0113 auto B: deterministic PostgreSQL lock order assigns before Offline; assignment remains valid and retries do not duplicate');

    const commandPrincipal = (session, index) => ({ ...tenantPrincipal, session_id: session.id, sessionIndex: index });
    const runDirectCommand = async (client, session, desiredStatus, expectedRevision, commandId) => {
      return availability.set(client, commandPrincipal(session), { desiredStatus, expectedRevision, commandId });
    };

    // A. Offline acquires the canonical Driver/availability locks before the
    // real Restaurante sync-push assignment arrives on a different backend.
    const operationA = await connectOperation('campaign-0112-offline-a');
    await operationA.client.query('BEGIN');
    await operationA.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    const beforeA = await readAvailability(operationA.client, schema, f);
    const offlineA = await runDirectCommand(operationA.client, sessions[0], 'offline', Number(beforeA.revision), UUID());
    assert.equal(offlineA.availability.effectiveStatus, 'offline');
    const assignWhileOffline = assignmentPacket(f, 0);
    const blockedAssignmentPromise = fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: assignWhileOffline });
    const blockedByA = await waitForBlockedRequest(observer, 'campaign-0112-api', await operationA.client.query('SELECT pg_backend_pid() AS pid').then(r => r.rows[0].pid));
    markLocal('A: Offline holds Driver lock; assignment is blocked in an independent PostgreSQL transaction', `blockedPids=${blockedByA.length}`);
    await operationA.client.query('COMMIT'); await endRuntimeClient(operationA.raw);
    markLocal('A: Offline transaction committed');
    const assignmentAResponse = await blockedAssignmentPromise;
    assert.equal(assignmentAResponse.status, 200, JSON.stringify(assignmentAResponse.body));
    assert.equal(assignmentAResponse.body.operationResults[0].status, 'rejected');
    assert.equal(assignmentAResponse.body.operationResults[0].error.code, 'DRIVER_NOT_AVAILABLE');
    const stateAfterA = await openRuntimeClient({ schema, tenantId: f.companyId, applicationName: 'campaign-0112-check-a' });
    const deliveryA = await stateAfterA.client.query(`SELECT payload,version FROM ${schema}.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`, [f.companyId, f.deliveries[0].id]);
    assert.equal(deliveryA.rowCount, 1); assert.equal(deliveryA.rows[0].payload.status, 'CREATED');
    assert.equal(deliveryA.rows[0].payload.driverId, null); assert.equal(Number(deliveryA.rows[0].version), 1);
    await endRuntimeClient(stateAfterA.raw);
    const retryA = await fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: assignWhileOffline });
    assert.equal(retryA.status, 200); assert.equal(retryA.body.duplicate, true);
    markLocal('A: assignment rejected after Offline; retry idempotent and Delivery unchanged');

    // Return to Online through the authenticated route before scenario B.
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const online = await fetchJson(origin, '/api/driver-availability/commands', sessions[0], { method: 'POST', body: {
      desiredStatus: 'online', expectedRevision: canonical.body.availability.revision, commandId: UUID() } });
    assert.equal(online.status, 200, JSON.stringify(online.body));
    markLocal('A: restored Online through authenticated endpoint');

    // B. Real sync service assigns and holds Delivery+Driver locks. The second
    // authenticated session's Offline command blocks until assignment commits.
    const operationB = await connectOperation('campaign-0112-assignment-b');
    markLocal('B: independent assignment backend connected');
    const packetB = assignmentPacket(f, 1);
    const pidB = (await operationB.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    markLocal('B: assignment backend PID captured');
    const assignmentB = await pushDirect(operationB.client, syncService, tenantPrincipal, packetB);
    markLocal('B: real sync push completed before commit');
    assert.equal(assignmentB.operationResults[0].status, 'accepted', JSON.stringify(assignmentB));
    markLocal('B: assignment accepted and uncommitted');
    const availabilityBStart = await fetchJson(origin, '/api/driver-availability', sessions[1]);
    markLocal('B: second authenticated session read availability', `http=${availabilityBStart.status}`);
    const offlineBPromise = fetchJson(origin, '/api/driver-availability/commands', sessions[1], { method: 'POST', body: {
      desiredStatus: 'offline', expectedRevision: availabilityBStart.body.availability.revision, commandId: UUID() } });
    const blockedByB = await waitForBlockedRequest(observer, 'campaign-0112-api', pidB);
    markLocal('B: assignment holds Driver lock; second-session Offline waits independently', `blockedPids=${blockedByB.length}`);
    await operationB.client.query('COMMIT'); await endRuntimeClient(operationB.raw);
    markLocal('B: assignment transaction committed');
    const offlineBResponse = await offlineBPromise;
    assert.equal(offlineBResponse.status, 200, JSON.stringify(offlineBResponse.body));
    assert.equal(offlineBResponse.body.availability.effectiveStatus, 'offline');
    const assigned = await openRuntimeClient({ schema, tenantId: f.companyId, applicationName: 'campaign-0112-check-b' });
    const assignedDelivery = await assigned.client.query(`SELECT payload,version FROM ${schema}.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`, [f.companyId, f.deliveries[1].id]);
    assert.equal(assignedDelivery.rowCount, 1); assert.equal(assignedDelivery.rows[0].payload.status, 'ASSIGNED');
    assert.equal(assignedDelivery.rows[0].payload.driverId, f.driverId); assert.equal(Number(assignedDelivery.rows[0].version), 2);
    await endRuntimeClient(assigned.raw);
    const retryB = await fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: packetB });
    assert.equal(retryB.status, 200); assert.equal(retryB.body.duplicate, true);
    markLocal('B: committed assignment remains valid after Offline; sync retry does not duplicate');

    // A subsequent new assignment is blocked while the canonical state is Offline.
    const assignmentAfterOffline = await fetchJson(origin, '/api/sync/push', sessions[0], {
      method: 'POST', body: assignmentPacket(f, 4) });
    assert.equal(assignmentAfterOffline.status, 200);
    assert.equal(assignmentAfterOffline.body.operationResults[0].error.code, 'DRIVER_NOT_AVAILABLE');

    // D1. Redelivery is an actual Restaurant sync update and is rejected if
    // Offline won first; the failed state and immutable history event survive.
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const onlineForRedelivery = await fetchJson(origin, '/api/driver-availability/commands', sessions[0], { method: 'POST', body: {
      desiredStatus: 'online', expectedRevision: canonical.body.availability.revision, commandId: UUID() } });
    assert.equal(onlineForRedelivery.status, 200);
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const offlineForRedelivery = await fetchJson(origin, '/api/driver-availability/commands', sessions[0], { method: 'POST', body: {
      desiredStatus: 'offline', expectedRevision: canonical.body.availability.revision, commandId: UUID() } });
    assert.equal(offlineForRedelivery.status, 200);
    const rejectedRedeliveryPacket = assignmentPacket(f, 2, { status: 'REDELIVERY' });
    const rejectedRedelivery = await fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: rejectedRedeliveryPacket });
    assert.equal(rejectedRedelivery.status, 200);
    assert.equal(rejectedRedelivery.body.operationResults[0].error.code, 'DRIVER_NOT_AVAILABLE');
    const redeliveryA = await openRuntimeClient({ schema, tenantId: f.companyId, applicationName: 'campaign-0112-check-redelivery-a' });
    const failedState = await redeliveryA.client.query(`SELECT payload,version FROM ${schema}.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`, [f.companyId, f.deliveries[2].id]);
    const historyBefore = await redeliveryA.client.query(`SELECT record_id::text,source_event_id FROM ${schema}.domain_records
      WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2`, [f.companyId, f.deliveries[2].id]);
    assert.equal(failedState.rows[0].payload.status, 'FAILED'); assert.equal(Number(failedState.rows[0].version), 1);
    assert.equal(historyBefore.rowCount, 1); assert.equal(historyBefore.rows[0].record_id, f.historicalEvents[0].id);
    await endRuntimeClient(redeliveryA.raw);
    markLocal('D1: Offline rejects real redelivery; FAILED state/event preserved');

    // D2. Redelivery obtains the same Driver lock before Offline; the offline
    // request waits, and committed REDELIVERY/history remain coherent.
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const onlineForRedelivery2 = await fetchJson(origin, '/api/driver-availability/commands', sessions[0], { method: 'POST', body: {
      desiredStatus: 'online', expectedRevision: canonical.body.availability.revision, commandId: UUID() } });
    assert.equal(onlineForRedelivery2.status, 200);
    const operationD2 = await connectOperation('campaign-0112-redelivery-d2');
    const redeliveryPacket = assignmentPacket(f, 3, { status: 'REDELIVERY' });
    const pidD2 = (await operationD2.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const redeliveryResult = await pushDirect(operationD2.client, syncService, tenantPrincipal, redeliveryPacket);
    assert.equal(redeliveryResult.operationResults[0].status, 'accepted', JSON.stringify(redeliveryResult));
    const availabilityD2Start = await fetchJson(origin, '/api/driver-availability', sessions[1]);
    const offlineD2Promise = fetchJson(origin, '/api/driver-availability/commands', sessions[1], { method: 'POST', body: {
      desiredStatus: 'offline', expectedRevision: availabilityD2Start.body.availability.revision, commandId: UUID() } });
    const blockedByD2 = await waitForBlockedRequest(observer, 'campaign-0112-api', pidD2);
    markLocal('D2: redelivery holds Driver lock; Offline waits in independent transaction', `blockedPids=${blockedByD2.length}`);
    await operationD2.client.query('COMMIT'); await endRuntimeClient(operationD2.raw);
    const offlineD2Response = await offlineD2Promise;
    assert.equal(offlineD2Response.status, 200); assert.equal(offlineD2Response.body.availability.effectiveStatus, 'offline');
    const redeliveryB = await openRuntimeClient({ schema, tenantId: f.companyId, applicationName: 'campaign-0112-check-redelivery-b' });
    const redeliveryState = await redeliveryB.client.query(`SELECT payload,version FROM ${schema}.domain_records
      WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`, [f.companyId, f.deliveries[3].id]);
    const historyAfter = await redeliveryB.client.query(`SELECT record_id::text,source_event_id FROM ${schema}.domain_records
      WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2`, [f.companyId, f.deliveries[3].id]);
    assert.equal(redeliveryState.rows[0].payload.status, 'REDELIVERY');
    assert.equal(redeliveryState.rows[0].payload.driverId, f.driverId);
    assert.equal(historyAfter.rowCount, 1, 'redelivery preserves its immutable event history without fabricating a new event');
    assert.equal(historyAfter.rows[0].record_id, f.historicalEvents[1].id);
    await endRuntimeClient(redeliveryB.raw);
    const retryRedelivery = await fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: redeliveryPacket });
    assert.equal(retryRedelivery.status, 200); assert.equal(retryRedelivery.body.duplicate, true);
    markLocal('D2: REDELIVERY commits before Offline, no event fabricated, idempotent retry');

    // C: the real sync-push CREATED path above exercises automatic dispatch
    // with PostgreSQL locks and two-session Offline races in both orders.
    markLocal('C: automatic CREATED dispatch path exercised in both deterministic Offline interleavings');

    // E. Two real authenticated sessions race commands against the same
    // expected revision while a barrier holds both behind the Driver row.
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const onlineBeforeRace = await fetchJson(origin, '/api/driver-availability/commands', sessions[1], { method: 'POST', body: {
      desiredStatus: 'online', expectedRevision: canonical.body.availability.revision, commandId: UUID() } });
    assert.equal(onlineBeforeRace.status, 200);
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const raceRevision = canonical.body.availability.revision;
    const barrier = await connectOperation('campaign-0112-session-barrier');
    await barrier.client.query('BEGIN');
    await barrier.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    await barrier.client.query(`SELECT 1 FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2
      AND entity_type='Driver' FOR UPDATE`, [f.companyId, f.driverId]);
    const barrierPid = (await barrier.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const concurrentCommands = [
      fetchJson(origin, '/api/driver-availability/commands', sessions[0], { method: 'POST', body: {
        desiredStatus: 'offline', expectedRevision: raceRevision, commandId: UUID() } }),
      fetchJson(origin, '/api/driver-availability/commands', sessions[1], { method: 'POST', body: {
        desiredStatus: 'online', expectedRevision: raceRevision, commandId: UUID() } })
    ];
    const blockedSessions = await waitForBlockedRequest(observer, 'campaign-0112-api', barrierPid, 2);
    assert.equal(blockedSessions.length, 2, 'both independently authenticated session requests reached the PostgreSQL lock barrier');
    markLocal('E: both session commands are blocked on one Driver lock', `blockedPids=${blockedSessions.length}`);
    await barrier.client.query('COMMIT'); await endRuntimeClient(barrier.raw);
    const concurrentResults = await Promise.all(concurrentCommands);
    const [offlineResult,onlineResult]=concurrentResults;
    if(onlineResult.status===409){
      assert.equal(offlineResult.status,200,'a stale Online command can only follow an accepted Offline transition');
      assert.equal(onlineResult.body.error.code,'REVISION_CONFLICT');
      assert.equal(offlineResult.body.availability.effectiveStatus,'offline');
      assert.equal(offlineResult.body.availability.revision,raceRevision+1);
    }else{
      assert.deepEqual(concurrentResults.map(row=>row.status),[200,200],
        'two 200 responses are valid only when the same-session Online request is a no-op before Offline commits');
      assert.equal(onlineResult.body.availability.effectiveStatus,'online');
      assert.equal(onlineResult.body.availability.revision,raceRevision,
        'the same-session Online no-op does not advance the canonical revision');
      assert.equal(offlineResult.body.availability.effectiveStatus,'offline');
      assert.equal(offlineResult.body.availability.revision,raceRevision+1,
        'the Offline transition advances the revision exactly once');
    }
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    assert.equal(canonical.body.availability.revision, raceRevision + 1);
    assert.equal(canonical.body.availability.effectiveStatus,'offline',
      'the terminal canonical state is Offline in either valid lock interleaving');
    markLocal('E: revision and lease semantics verified for both valid command interleavings');

    // Same idempotency key concurrently from both valid sessions creates one command receipt.
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const duplicateBarrier = await connectOperation('campaign-0112-idempotency-barrier');
    await duplicateBarrier.client.query('BEGIN');
    await duplicateBarrier.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    await duplicateBarrier.client.query(`SELECT 1 FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2
      AND entity_type='Driver' FOR UPDATE`, [f.companyId, f.driverId]);
    const duplicateBarrierPid = (await duplicateBarrier.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const duplicateCommandId = UUID();
    const duplicateDesired = canonical.body.availability.effectiveStatus;
    const duplicateRequests = sessions.map(session => fetchJson(origin, '/api/driver-availability/commands', session, { method: 'POST', body: {
      desiredStatus: duplicateDesired, expectedRevision: canonical.body.availability.revision, commandId: duplicateCommandId } }));
    await waitForBlockedRequest(observer, 'campaign-0112-api', duplicateBarrierPid, 2);
    await duplicateBarrier.client.query('COMMIT'); await endRuntimeClient(duplicateBarrier.raw);
    const duplicateResults = await Promise.all(duplicateRequests);
    assert.deepEqual(duplicateResults.map(row => row.status), [200,200]);
    assert.equal(duplicateResults.filter(row => row.body.command.duplicate === true).length, 1);
    const receipt = await openRuntimeClient({ schema, tenantId: f.companyId, applicationName: 'campaign-0112-check-idempotency' });
    const receiptCount = await receipt.client.query(`SELECT count(*)::int AS n FROM ${schema}.driver_availability_commands
      WHERE company_id=$1 AND driver_id=$2 AND command_id=$3`, [f.companyId, f.driverId, duplicateCommandId]);
    assert.equal(receiptCount.rows[0].n, 1); await endRuntimeClient(receipt.raw);
    markLocal('E: duplicate idempotency key raced across sessions; one durable receipt');

    // Non-owner heartbeat cannot extend the current session's lease.
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    if (canonical.body.availability.effectiveStatus !== 'online' || canonical.body.availability.leaseSessionId !== sessions[0].id) {
      const ownerOnline = await fetchJson(origin, '/api/driver-availability/commands', sessions[0], { method: 'POST', body: {
        desiredStatus: 'online', expectedRevision: canonical.body.availability.revision, commandId: UUID() } });
      assert.equal(ownerOnline.status, 200);
      canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    }
    const nonOwnerHeartbeat = await fetchJson(origin, '/api/driver-availability/heartbeat', sessions[1], { method: 'POST', body: {
      revision: canonical.body.availability.revision } });
    assert.equal(nonOwnerHeartbeat.status, 200); assert.equal(nonOwnerHeartbeat.body.renewed, false);
    const ownerHeartbeat = await fetchJson(origin, '/api/driver-availability/heartbeat', sessions[0], { method: 'POST', body: {
      revision: canonical.body.availability.revision } });
    assert.equal(ownerHeartbeat.status, 200); assert.equal(ownerHeartbeat.body.renewed, true);
    markLocal('E: non-owner heartbeat rejected; lease owner heartbeat renewed');

    // Lease expires while an assignment waits for its Driver lock.
    const expiryTx = await connectOperation('campaign-0112-lease-expiry');
    await expiryTx.client.query('BEGIN');
    await expiryTx.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    await expiryTx.client.query(`SELECT 1 FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2
      AND entity_type='Driver' FOR UPDATE`, [f.companyId, f.driverId]);
    await expiryTx.client.query(`UPDATE ${schema}.driver_availability SET lease_expires_at=now()-interval '1 second'
      WHERE company_id=$1 AND driver_id=$2`, [f.companyId, f.driverId]);
    const expiryPid = (await expiryTx.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const leaseAssignment = fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: assignmentPacket(f, 4) });
    await waitForBlockedRequest(observer, 'campaign-0112-api', expiryPid);
    await expiryTx.client.query('COMMIT'); await endRuntimeClient(expiryTx.raw);
    const expiredAssignment = await leaseAssignment;
    assert.equal(expiredAssignment.status, 200);
    assert.equal(expiredAssignment.body.operationResults[0].error.code, 'DRIVER_NOT_AVAILABLE');
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    assert.equal(canonical.body.availability.effectiveStatus, 'offline');
    assert.equal(canonical.body.availability.reason, 'lease_expired');
    markLocal('E: lease expires under contention; assignment observes expired lease and rejects');

    // F. Rollback releases locks and reverts Offline command; the following
    // real assignment is accepted. Tenant B is invisible under Tenant A RLS.
    const restoreOnline = await fetchJson(origin, '/api/driver-availability/commands', sessions[0], { method: 'POST', body: {
      desiredStatus: 'online', expectedRevision: canonical.body.availability.revision, commandId: UUID() } });
    assert.equal(restoreOnline.status, 200);
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    const rollbackTx = await connectOperation('campaign-0112-rollback');
    await rollbackTx.client.query('BEGIN');
    await rollbackTx.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    const rollbackCommandId = UUID();
    const rollbackCommand = await runDirectCommand(rollbackTx.client, sessions[0], 'offline', canonical.body.availability.revision, rollbackCommandId);
    assert.equal(rollbackCommand.availability.effectiveStatus, 'offline');
    await rollbackTx.client.query('ROLLBACK'); await endRuntimeClient(rollbackTx.raw);
    canonical = await fetchJson(origin, '/api/driver-availability', sessions[0]);
    assert.equal(canonical.body.availability.effectiveStatus, 'online');
    const rollbackCheck = await openRuntimeClient({ schema, tenantId: f.companyId, applicationName: 'campaign-0112-check-rollback' });
    const rollbackReceipt = await rollbackCheck.client.query(`SELECT count(*)::int AS n FROM ${schema}.driver_availability_commands
      WHERE company_id=$1 AND driver_id=$2 AND command_id=$3`, [f.companyId, f.driverId, rollbackCommandId]);
    assert.equal(rollbackReceipt.rows[0].n, 0); await endRuntimeClient(rollbackCheck.raw);
    const tenantCheck = await openRuntimeClient({ schema, applicationName: 'campaign-0112-tenant-check' });
    await tenantCheck.client.query('BEGIN');
    await tenantCheck.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
    const hidden = await tenantCheck.client.query(`SELECT count(*)::int AS n FROM ${schema}.domain_records
      WHERE company_id=$1 AND record_id=$2`, [f.otherCompanyId, f.otherDriverId]);
    assert.equal(hidden.rows[0].n, 0, 'Tenant A cannot read Tenant B Driver under FORCE RLS');
    const otherTenantAvailability = await tenantCheck.client.query(`SELECT count(*)::int AS n FROM ${schema}.driver_availability
      WHERE company_id=$1`, [f.otherCompanyId]);
    assert.equal(otherTenantAvailability.rows[0].n, 0, 'Tenant A cannot read Tenant B availability despite a seeded row');
    for(const table of ['restaurant_dispatch_settings','restaurant_driver_presence','restaurant_presence_qr_nonces']){
      const hiddenQueueRows=await tenantCheck.client.query(`SELECT count(*)::int AS n FROM ${schema}.${table} WHERE company_id=$1`,[f.otherCompanyId]);
      assert.equal(hiddenQueueRows.rows[0].n,0,`Tenant A cannot read Tenant B row in ${table} under FORCE RLS`);
    }
    await tenantCheck.client.query('ROLLBACK'); await endRuntimeClient(tenantCheck.raw);
    const assignAfterRollback = assignmentPacket(f, 5);
    const acceptedAfterRollback = await fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: assignAfterRollback });
    assert.equal(acceptedAfterRollback.status, 200);
    assert.equal(acceptedAfterRollback.body.operationResults[0].status, 'accepted');
    const acceptedRetry = await fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: assignAfterRollback });
    assert.equal(acceptedRetry.status, 200); assert.equal(acceptedRetry.body.duplicate, true);
    const finalVerify = await openRuntimeClient({ schema, tenantId: f.companyId, applicationName: 'campaign-0112-final-check' });
    const finalCounts = await finalVerify.client.query(`SELECT
      (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery') AS deliveries,
      (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$3) AS events,
      (SELECT count(*)::int FROM ${schema}.sync_outbox WHERE company_id=$1 AND payload->>'entityId'=$2::text) AS outbox`,
    [f.companyId, f.deliveries[5].id, f.deliveries[5].id]);
    assert.deepEqual(finalCounts.rows[0], { deliveries: 1, events: 0, outbox: 1 }, 'successful retry creates one canonical Delivery/outbox, no fake event');
    await endRuntimeClient(finalVerify.raw);
    markLocal('F: rollback restored Online and removed its command; RLS isolation and idempotent retry passed');

    // 0115: the real automatic REDLIVERY path must skip each older ineligible
    // FIFO record and choose the next eligible Driver. Each case uses the
    // sync service and a committed canonical fixture in the disposable E2E schema.
    assert.equal(automaticAgain.body.settings.mode,'automatic','the canonical Restaurant setting is automatic for the eligibility matrix');
    const eligibilityCases=['offline','occupied','expired','locked'];
    for(const kind of eligibilityCases){
      const pair=await seedEligibilityPair(migrator,schema,f,kind);
      markLocal(`0115 eligibility fixture seeded: ${kind}`);
      const queueReader=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:`campaign-0115-fifo-${kind}-read`});
      const observedQueue=await queue.getQueue(queueReader.client,{...tenantPrincipal,driver_id:null});
      markLocal(`0115 canonical FIFO read completed: ${kind}`);
      const localRecords=observedQueue.records.filter(row=>row.driverId===pair.firstId||row.driverId===pair.secondId);
      assert.deepEqual(localRecords.map(row=>row.driverId),[pair.firstId,pair.secondId],`${kind}: server arrival timestamp orders the older candidate first`);
      if(kind==='locked') assert.deepEqual(observedQueue.queue.filter(row=>row.driverId===pair.firstId||row.driverId===pair.secondId).map(row=>row.driverId),[pair.firstId,pair.secondId]);
      else assert.deepEqual(observedQueue.queue.filter(row=>row.driverId===pair.firstId||row.driverId===pair.secondId).map(row=>row.driverId),[pair.secondId],`${kind}: only the second candidate is eligible`);
      if(kind==='offline') assert.equal(localRecords[0].online,false,'offline FIFO record is not eligible');
      if(kind==='occupied') assert.equal(localRecords[0].busy,true,'candidate with active Delivery is not eligible');
      if(kind==='expired') assert.equal(localRecords[0].online,false,'expired lease is not eligible');
      markLocal(`0115 FIFO eligibility asserted: ${kind}`);
      if(kind==='locked'){
        const lockFirst=await connectOperation('campaign-0115-fifo-lock-first');
        await lockFirst.client.query('BEGIN');
        await lockFirst.client.query("SELECT set_config('app.tenant_id',$1,true)",[f.companyId]);
        await lockFirst.client.query(`SELECT d.record_id FROM ${schema}.domain_records d
          JOIN ${schema}.driver_availability a ON a.company_id=d.company_id AND a.driver_id=d.record_id
          JOIN ${schema}.restaurant_driver_presence p ON p.company_id=d.company_id AND p.driver_id=d.record_id
          WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Driver' FOR UPDATE OF d,a,p`,[f.companyId,pair.firstId]);
        const redelivery=await seedRedeliveryFixture(migrator,schema,f);
        const packet=unassignedRedeliveryPacket(f,redelivery);
        markLocal(`0115 redelivery fixture ready: ${kind}`);
        const response=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:packet});
        assert.equal(response.status,200,JSON.stringify(response.body));
        assert.equal(response.body.operationResults.find(row=>row.entity==='Delivery').status,'accepted');
        const assignedId=response.body.operationResults.find(row=>row.entity==='Delivery').canonicalId;
        const read=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0115-fifo-lock-read'});
        const state=await read.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,assignedId]);
        assert.equal(state.rows[0].payload.driverId,pair.secondId,'dispatcher skips a locked older candidate and selects the next FIFO candidate');
        const lockCounts=await read.client.query(`SELECT
          (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery') AS delivery_count,
          (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2) AS event_count,
          (SELECT count(*)::int FROM ${schema}.sync_inbox WHERE company_id=$1 AND packet_id=$3) AS receipt_count,
          (SELECT count(*)::int FROM ${schema}.sync_outbox WHERE company_id=$1 AND payload->>'entityId'=$2::text) AS outbox_count`,
        [f.companyId,assignedId,packet.packetId.slice(4)]);
        assert.deepEqual(lockCounts.rows[0],{delivery_count:1,event_count:1,receipt_count:1,outbox_count:1},'locked-candidate dispatch writes one canonical artifact of each kind');
        await migrator.query("SELECT set_config('app.tenant_id',$1,false)",[f.companyId]);
        const lockAudit=await migrator.query(`SELECT count(*)::int AS count FROM ${schema}.audit_log WHERE company_id=$1 AND action='delivery.redelivery.requested' AND resource_id=$2::text`,[f.companyId,assignedId]);
        assert.equal(lockAudit.rows[0].count,1,'locked-candidate dispatch writes one audit record');
        await endRuntimeClient(read.raw);
        await lockFirst.client.query('COMMIT');await endRuntimeClient(lockFirst.raw);
        const retry=await fetchJson(origin,'/api/sync/push',sessions[1],{method:'POST',body:packet});
        assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true,'locked-candidate dispatch retry is idempotent');
        const retryRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0115-fifo-lock-retry-read'});
        const retryCounts=await retryRead.client.query(`SELECT
          (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery') AS delivery_count,
          (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2) AS event_count,
          (SELECT count(*)::int FROM ${schema}.sync_inbox WHERE company_id=$1 AND packet_id=$3) AS receipt_count,
          (SELECT count(*)::int FROM ${schema}.sync_outbox WHERE company_id=$1 AND payload->>'entityId'=$2::text) AS outbox_count`,
        [f.companyId,assignedId,packet.packetId.slice(4)]);
        assert.deepEqual(retryCounts.rows[0],{delivery_count:1,event_count:1,receipt_count:1,outbox_count:1},'retry leaves each artifact unique');
        const retryAudit=await migrator.query(`SELECT count(*)::int AS count FROM ${schema}.audit_log WHERE company_id=$1 AND action='delivery.redelivery.requested' AND resource_id=$2::text`,[f.companyId,assignedId]);
        assert.equal(retryAudit.rows[0].count,1,'retry leaves one audit record');
        await endRuntimeClient(retryRead.raw);
        markLocal('0115 FIFO lock interleaving: a locked older Driver is skipped and the next eligible Driver receives REDELIVERY');
      }else{
        const redelivery=await seedRedeliveryFixture(migrator,schema,f);
        const packet=unassignedRedeliveryPacket(f,redelivery);
        markLocal(`0115 redelivery fixture ready: ${kind}`);
        const response=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:packet});
        assert.equal(response.status,200,JSON.stringify(response.body));
        assert.equal(response.body.operationResults.find(row=>row.entity==='Delivery').status,'accepted');
        const assignedId=response.body.operationResults.find(row=>row.entity==='Delivery').canonicalId;
        const read=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:`campaign-0115-fifo-${kind}-readback`});
        const deliveryState=await read.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,assignedId]);
        assert.equal(deliveryState.rows[0].payload.driverId,pair.secondId,`${kind}: automatic redelivery selects next eligible FIFO Driver`);
        const counts=await read.client.query(`SELECT
          (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery') AS delivery_count,
          (SELECT count(*)::int FROM ${schema}.domain_records WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2) AS event_count,
          (SELECT count(*)::int FROM ${schema}.sync_inbox WHERE company_id=$1 AND packet_id=$3) AS receipt_count,
          (SELECT count(*)::int FROM ${schema}.sync_outbox WHERE company_id=$1 AND payload->>'entityId'=$2::text) AS outbox_count`,
        [f.companyId,assignedId,packet.packetId.slice(4)]);
        assert.deepEqual(counts.rows[0],{delivery_count:1,event_count:1,receipt_count:1,outbox_count:1},`${kind}: canonical record, failure event, sync receipt and outbox are unique`);
        await migrator.query("SELECT set_config('app.tenant_id',$1,false)",[f.companyId]);
        const audit=await migrator.query(`SELECT count(*)::int AS count FROM ${schema}.audit_log WHERE company_id=$1 AND action='delivery.redelivery.requested' AND resource_id=$2::text`,[f.companyId,assignedId]);
        assert.equal(audit.rows[0].count,1,`${kind}: one canonical redelivery audit`);
        await endRuntimeClient(read.raw);
        const retry=await fetchJson(origin,'/api/sync/push',sessions[1],{method:'POST',body:packet});
        assert.equal(retry.status,200);assert.equal(retry.body.duplicate,true,`${kind}: repeated sync package is idempotent`);
        const retryAudit=await migrator.query(`SELECT count(*)::int AS count FROM ${schema}.audit_log WHERE company_id=$1 AND action='delivery.redelivery.requested' AND resource_id=$2::text`,[f.companyId,assignedId]);
        assert.equal(retryAudit.rows[0].count,1,`${kind}: retry does not duplicate audit`);
        markLocal(`0115 FIFO eligibility ${kind}: real automatic redelivery selected next eligible Driver, retained one event/receipt/audit, retry idempotent`);
      }
      await endRuntimeClient(queueReader.raw);
    }

    // A fully eligible tenant-B Driver with an older arrival must never be
    // visible or selected for tenant A's real dispatcher transaction.
    const foreignPair=await seedEligibilityPair(migrator,schema,f,'occupied');
    await seedForeignEligibleDriver(migrator,schema,f);
    const tenantAQueue=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0115-tenant-a-queue'});
    const visibleA=await queue.getQueue(tenantAQueue.client,{...tenantPrincipal,driver_id:null});
    assert.equal(visibleA.records.some(row=>row.driverId===f.otherDriverId),false,'tenant A queue never returns tenant B Driver');
    assert.deepEqual(visibleA.queue.filter(row=>row.driverId===foreignPair.firstId||row.driverId===foreignPair.secondId).map(row=>row.driverId),[foreignPair.secondId]);
    await endRuntimeClient(tenantAQueue.raw);
    const foreignRedelivery=await seedRedeliveryFixture(migrator,schema,f),foreignPacket=unassignedRedeliveryPacket(f,foreignRedelivery);
    const foreignDispatch=await fetchJson(origin,'/api/sync/push',sessions[0],{method:'POST',body:foreignPacket});
    assert.equal(foreignDispatch.status,200,JSON.stringify(foreignDispatch.body));
    const foreignAssignedId=foreignDispatch.body.operationResults.find(row=>row.entity==='Delivery').canonicalId;
    const foreignRead=await openRuntimeClient({schema,tenantId:f.companyId,applicationName:'campaign-0115-tenant-a-dispatch'});
    const foreignState=await foreignRead.client.query(`SELECT payload FROM ${schema}.domain_records WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`,[f.companyId,foreignAssignedId]);
    assert.equal(foreignState.rows[0].payload.driverId,foreignPair.secondId,'tenant A dispatcher assigns only tenant A Driver');
    await endRuntimeClient(foreignRead.raw);
    markLocal('0115 tenant isolation: older eligible tenant-B Driver is invisible and never receives tenant-A redelivery');

    const lockCheck = await observer.client.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name LIKE 'campaign-011%' AND wait_event_type='Lock'`);
    assert.equal(lockCheck.rows[0].n, 0, 'no campaign transaction remains waiting on a lock');
    markLocal('all API/PG operations settled; no lingering lock waits');

    // 0191: the domain makes the Restaurant authoritative for assignment; a
    // Motoboy cannot freely accept an unassigned Delivery. Exercise the
    // equivalent legitimate race: two independently authenticated Restaurant
    // sessions assign the same UI/sync-created opportunity to different
    // eligible Drivers while an explicit PostgreSQL row-lock barrier holds
    // both requests. Then two distinct Driver-linked sessions race acceptance;
    // only the assigned identity may append the execution event.
    const assignmentPair = await seedEligibilityPair(migrator, schema, f, 'eligible');
    const riders = await seedIndependentRiders(migrator, schema, f, [assignmentPair.firstId, assignmentPair.secondId]);
    const currentSettings = await fetchJson(origin, '/api/restaurant-driver-queue', sessions[0]);
    assert.equal(currentSettings.status, 200, JSON.stringify(currentSettings.body));
    const manualMode0191 = await fetchJson(origin, '/api/restaurant-driver-queue/settings', sessions[0], { method: 'POST', body: {
      mode: 'manual', expectedRevision: currentSettings.body.settings.revision } });
    assert.equal(manualMode0191.status, 200, JSON.stringify(manualMode0191.body));
    const raceFixture = readyDeliveryPacket(f);
    const raceCreate = await fetchJson(origin, '/api/sync/push', sessions[0], { method: 'POST', body: raceFixture.packet });
    assert.equal(raceCreate.status, 200, JSON.stringify(raceCreate.body));
    const createdDeliveryResult = raceCreate.body.operationResults.find(row => row.entity === 'Delivery');
    assert.equal(createdDeliveryResult.status, 'accepted', JSON.stringify(raceCreate.body));
    const localDelivery = raceFixture.packet.data.deliveries[0];
    const assignmentAttempt = (driverId, packetId) => {
      const now = new Date().toISOString();
      const delivery = { ...localDelivery, driverId, status: 'ASSIGNED', assignedAt: now,
        updatedAt: now, version: 2, baseVersion: 1 };
      return { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId,
        deviceId: raceFixture.packet.deviceId, source: raceFixture.packet.source, createdAt: now,
        data: { orders: [], drivers: [], deliveries: [delivery], routes: [], deliveryEvents: [],
          locationUpdates: [], proofs: [], earnings: [], tombstones: [] } };
    };
    const assignmentPackets = [
      assignmentAttempt(assignmentPair.firstId, `pkt_${UUID()}`),
      assignmentAttempt(assignmentPair.secondId, `pkt_${UUID()}`)
    ];
    const raceBarrier = await connectOperation('campaign-0191-assignment-race-barrier');
    try {
      await raceBarrier.client.query('BEGIN');
      await raceBarrier.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
      const lockedDelivery = await raceBarrier.client.query(`SELECT record_id FROM ${schema}.domain_records
        WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' FOR UPDATE`,
      [f.companyId, createdDeliveryResult.canonicalId]);
      assert.equal(lockedDelivery.rowCount, 1, 'the legitimate created Delivery is locked before the race');
      const barrierPid = Number((await raceBarrier.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const raceRequests = assignmentPackets.map((packet, index) => fetchJson(origin, '/api/sync/push',
        sessions[index], { method: 'POST', body: packet }));
      const blockedRacePids = await waitForBlockedRequest(observer, 'campaign-0112-api', barrierPid, 2);
      assert.equal(blockedRacePids.length, 2, 'two independent authenticated requests contend on the same canonical Delivery lock');
      await raceBarrier.client.query('COMMIT');
      const raceResponses = await Promise.all(raceRequests);
      assert(raceResponses.every(response => response.status === 200), JSON.stringify(raceResponses));
      const raceOutcomes = raceResponses.map(response => response.body.operationResults?.[0]);
      const acceptedAssignments = raceOutcomes.filter(result => result?.status === 'accepted');
      const losingAssignments = raceOutcomes.filter(result => result?.status === 'conflict');
      assert.equal(acceptedAssignments.length, 1, `exactly one candidate assignment wins: ${JSON.stringify(raceOutcomes)}`);
      assert.equal(losingAssignments.length, 1, `the losing request receives a domain conflict: ${JSON.stringify(raceOutcomes)}`);
      assert.equal(losingAssignments[0].error?.code, 'REVISION_CONFLICT');
      const assignmentRead = await openRuntimeClient({ schema, tenantId: f.companyId,
        applicationName: 'campaign-0191-assignment-race-readback' });
      const canonicalAssignment = await assignmentRead.client.query(`SELECT payload,version FROM ${schema}.domain_records
        WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`, [f.companyId, createdDeliveryResult.canonicalId]);
      assert.equal(canonicalAssignment.rowCount, 1);
      assert.equal(canonicalAssignment.rows[0].payload.status, 'ASSIGNED');
      assert([assignmentPair.firstId, assignmentPair.secondId].includes(canonicalAssignment.rows[0].payload.driverId));
      assert.equal(Number(canonicalAssignment.rows[0].version), 2);
      const assignmentOutbox = await assignmentRead.client.query(`SELECT count(*)::int AS n,
        count(*) FILTER(WHERE payload->'payload'->>'version'='2')::int AS assignment_events
        FROM ${schema}.sync_outbox WHERE company_id=$1 AND payload->>'entityId'=$2`,
      [f.companyId, createdDeliveryResult.canonicalId]);
      assert.deepEqual(assignmentOutbox.rows[0], { n: 2, assignment_events: 1 },
        'one create event and exactly one canonical assignment update are published');
      await endRuntimeClient(assignmentRead.raw);
      for (const [index, packet] of assignmentPackets.entries()) {
        const replay = await fetchJson(origin, '/api/sync/push', sessions[index], { method: 'POST', body: packet });
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.equal(replay.body.duplicate, true, 'both winner and loser packet replays are idempotent');
      }
      const acceptPackets = riders.map(rider => {
        const now = new Date().toISOString(), eventId = UUID();
        const event = { id: eventId, eventId, entity: 'Delivery', entityId: createdDeliveryResult.canonicalId,
          type: 'DELIVERY_ACCEPTED', occurredAt: now, actor: { type: 'driver', id: rider.driverId },
          payload: {}, protocolVersion: 1 };
        return { protocol: 'rotamoto-sync', protocolVersion: 1, schemaVersion: 1, packetId: `pkt_${UUID()}`,
          deviceId: `campaign-0191-${rider.installationId}`, source: { deviceId: `campaign-0191-${rider.installationId}` },
          createdAt: now, data: { orders: [], drivers: [], deliveries: [], routes: [], deliveryEvents: [event],
            locationUpdates: [], proofs: [], earnings: [], tombstones: [] } };
      });
      const acceptBarrier = await connectOperation('campaign-0191-accept-race-barrier');
      let acceptResponses;
      try {
        await acceptBarrier.client.query('BEGIN');
        await acceptBarrier.client.query("SELECT set_config('app.tenant_id',$1,true)", [f.companyId]);
        await acceptBarrier.client.query(`SELECT record_id FROM ${schema}.domain_records
          WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery' FOR UPDATE`,
        [f.companyId, createdDeliveryResult.canonicalId]);
        const acceptBarrierPid = Number((await acceptBarrier.client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
        const acceptRequests = acceptPackets.map((packet, index) => fetchJson(origin, '/api/sync/push',
          riders[index].session, { method: 'POST', body: packet }));
        const blockedAcceptPids = await waitForBlockedRequest(observer, 'campaign-0112-api', acceptBarrierPid, 2);
        assert.equal(blockedAcceptPids.length, 2, 'two distinct Driver-linked sessions contend on the same Delivery row');
        await acceptBarrier.client.query('COMMIT');
        acceptResponses = await Promise.all(acceptRequests);
      } finally {
        await acceptBarrier.client.query('ROLLBACK').catch(() => {});
        await endRuntimeClient(acceptBarrier.raw);
      }
      assert(acceptResponses.every(response => response.status === 200), JSON.stringify(acceptResponses));
      const acceptOutcomes = acceptResponses.map(response => response.body.operationResults?.[0]);
      const acceptedByWinner = acceptOutcomes.filter(result => result?.status === 'accepted');
      const rejectedByAssignment = acceptOutcomes.filter(result => result?.error?.code === 'DRIVER_NOT_ASSIGNED');
      assert.equal(acceptedByWinner.length, 1, `only the assigned Driver may accept: ${JSON.stringify(acceptOutcomes)}`);
      assert.equal(rejectedByAssignment.length, 1, `the other Driver receives a coherent ownership rejection: ${JSON.stringify(acceptOutcomes)}`);
      const acceptanceRead = await openRuntimeClient({ schema, tenantId: f.companyId,
        applicationName: 'campaign-0191-accept-race-readback' });
      const acceptedProjection = await acceptanceRead.client.query(`SELECT payload,version FROM ${schema}.domain_records
        WHERE company_id=$1 AND record_id=$2 AND entity_type='Delivery'`, [f.companyId, createdDeliveryResult.canonicalId]);
      assert.equal(acceptedProjection.rows[0]?.payload.status, 'ACCEPTED');
      const executionEventCount = await acceptanceRead.client.query(`SELECT count(*)::int AS n FROM ${schema}.domain_records
        WHERE company_id=$1 AND entity_type='DeliveryEvent' AND related_record_id=$2`,
      [f.companyId, createdDeliveryResult.canonicalId]);
      assert.equal(executionEventCount.rows[0].n, 1, 'one canonical acceptance fact was appended');
      await endRuntimeClient(acceptanceRead.raw);
      const acceptedIndex = acceptOutcomes.findIndex(result => result?.status === 'accepted');
      for (const index of [0, 1]) {
        const replay = await fetchJson(origin, '/api/sync/push', riders[index].session,
          { method: 'POST', body: acceptPackets[index] });
        assert.equal(replay.status, 200, JSON.stringify(replay.body));
        assert.equal(replay.body.duplicate, true, 'driver acceptance replay does not append another fact');
      }
      await fixture.update({ tenants: [
        { id: f.companyId, counts: { companies: 1, users: 3, sessions: 4, memberships: 3, roles: 1, drivers: 3 } },
        { id: f.otherCompanyId, counts: { companies: 1, drivers: 1 } }
      ], records: { schemas: [schema], companies: [f.companyId, f.otherCompanyId], users: [f.userId, ...riders.map(row => row.userId)],
        roles: [f.roleId], memberships: [f.membershipId, ...riders.map(row => row.membershipId)],
        sessions: [...f.sessions.map(row => row.id), ...riders.map(row => row.session.id)],
        drivers: [f.driverId, f.otherDriverId, assignmentPair.firstId, assignmentPair.secondId],
        orders: [...f.deliveries.map(row => row.orderId), raceFixture.packet.data.orders[0].id],
        deliveries: [...f.deliveries.map(row => row.id), createdDeliveryResult.canonicalId], routes: [],
        evidence: ['two-session PostgreSQL concurrency trace', '0191 same-Delivery assignment race', '0191 two distinct Driver-linked session acceptance race']
      } });
      markLocal(`0191 assignment race: one of two eligible Drivers assigned; loser REVISION_CONFLICT; one version-2 outbox event; retries idempotent`);
      markLocal(`0191 acceptance race: Driver ${riders[acceptedIndex].driverId} accepted; other session rejected DRIVER_NOT_ASSIGNED; one DeliveryEvent; retries idempotent`);
    } finally {
      await raceBarrier.client.query('ROLLBACK').catch(() => {});
      await endRuntimeClient(raceBarrier.raw);
    }

    console.log(JSON.stringify({ result: 'PASS_E2E_SCENARIOS_0160_FIFO_ELIGIBILITY', database: DATABASE, schemaSandbox: 'isolated migration-derived schema retained; manifest records ownership',
      fixtureRunId: fixture.runId, fixtureManifest: fixture.file,
      independentlyBlockedTransactions: blockedByA.length + blockedByB.length + blockedByD2.length + blockedSessions.length,
      scenarios: { A: 'PASS', B: 'PASS', C: 'PASS_REAL_AUTOMATIC_CREATED_DISPATCH_BOTH_INTERLEAVINGS', D: 'PASS', E: 'PASS', F: 'PASS',
        '0115_offline_occupied_expired_locked_fifo': 'PASS', '0115_retry_artifacts': 'PASS', '0115_tenant_isolation': 'PASS' },
      timeline: trace }));
    completed = true;
    await endRuntimeClient(observer.raw);
  } finally {
    if (httpHost) { httpHost.closeAllConnections?.(); await new Promise(resolve => httpHost.close(resolve)); }
    if (pool) await pool.end();
    await Promise.all([...runtimeClients].map(endRuntimeClient));
    if (schemaCommitted) markLocal('isolated schema retained; no fixture or audit cleanup performed', schema);
    await fixture.update({ status: schemaCommitted ? 'RETAINED' : 'FAILED', databaseCommitted: schemaCommitted,
      retentionReason: schemaCommitted ? 'Campaign 0160 isolated schema, tenant fixtures, and audit rows retained; no DROP, TRUNCATE, or cleanup is authorized.' : null,
      evidence: [{ kind: 'test_result', result: completed ? 'PASS' : 'FAILED_OR_INTERRUPTED' }],
      lastError: completed ? null : schemaCommitted ? 'Runner failed or was interrupted; committed schema and fixtures remain retained for inspection.' : 'No isolated schema commit was recorded; inspect database before recovery.' });
    if (migratorConnected) await migrator.end();
  }
}

main().catch(error => {
  console.error(`Concurrency trace: ${JSON.stringify(timeline)}`);
  console.error(`Availability concurrency E2E: FAIL: ${error.message}`);
  process.exitCode = 1;
});
