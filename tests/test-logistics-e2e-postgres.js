'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { e2eMigrationConnectionString, getMigrations } = require('../backend/postgres/migrate');
const { createLogisticsService } = require('../backend/logistics/service');

function id() { return crypto.randomUUID(); }
async function rejected(client, name, query) {
  await client.query(`SAVEPOINT ${name}`);
  await assert.rejects(query);
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  await client.query(`RELEASE SAVEPOINT ${name}`);
}

async function main() {
  const connectionString = e2eMigrationConnectionString(process.env);
  const client = new Client({ connectionString, application_name: 'rotamoto-logistics-e2e-test', statement_timeout: 5000 });
  await client.connect();
  try {
    const identity = (await client.query(`SELECT current_user AS role,current_database() AS database,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass`)).rows[0];
    assert.deepEqual(identity, { role: 'rotamoto_migrator', database: 'rotamoto_e2e', bypass: false });
    const migration = await client.query(`SELECT migration_id FROM rotamoto.schema_migrations
      WHERE migration_id IN ('0017_logistics_fulfillment','0018_delivery_geo_snapshots','0019_logistics_provider_secret_least_privilege')
      ORDER BY migration_id`);
    assert.deepEqual(migration.rows.map(row => row.migration_id), [
      '0017_logistics_fulfillment','0018_delivery_geo_snapshots','0019_logistics_provider_secret_least_privilege'
    ], 'E2E schema includes the tested logistics, geography and least-privilege migrations');
    const catalog = await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
      has_table_privilege('rotamoto_app',c.oid,'SELECT') AS app_select,
      has_table_privilege('rotamoto_app',c.oid,'DELETE') AS app_delete
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
    [['logistics_providers','delivery_fulfillments','dispatch_attempts']]);
    assert.equal(catalog.rowCount, 3);
    for (const row of catalog.rows) {
      assert.equal(row.relrowsecurity, true); assert.equal(row.relforcerowsecurity, true);
      assert.equal(row.owner, 'rotamoto_migrator'); assert.equal(row.app_delete, false);
      assert.equal(row.app_select, row.relname !== 'logistics_providers',
        'provider table access is column-scoped while fulfillment and attempt reads stay operational');
    }
    const appPrivileges = await client.query(`SELECT
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','provider_id','INSERT') AS provider_insert,
      has_table_privilege('rotamoto_app','rotamoto.logistics_providers','SELECT') AS provider_table_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','provider_id','SELECT') AS provider_id_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','configuration','SELECT') AS provider_configuration_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','secret_ref','SELECT') AS provider_secret_select,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','provider_class','UPDATE') AS provider_class_update,
      has_column_privilege('rotamoto_app','rotamoto.logistics_providers','secret_ref','UPDATE') AS provider_secret_update,
      has_column_privilege('rotamoto_app','rotamoto.delivery_fulfillments','mode','INSERT') AS fulfillment_insert,
      has_column_privilege('rotamoto_app','rotamoto.dispatch_attempts','status','UPDATE') AS attempts_update`);
    assert.deepEqual(appPrivileges.rows[0], { provider_insert: true, provider_table_select: false, provider_id_select: true,
      provider_configuration_select: true, provider_secret_select: false, provider_class_update: false,
      provider_secret_update: false, fulfillment_insert: true, attempts_update: true });

    const cleanSchema = `logistics_sandbox_${crypto.randomUUID().replaceAll('-', '')}`;
    await client.query('BEGIN');
    try {
      for (const migration of getMigrations()) await client.query(migration.up.replace(/\brotamoto\b/gu, cleanSchema));
      const objects = await client.query(`SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname=$1`, [cleanSchema]);
      assert.equal(objects.rows[0].tables, 24, 'clean install includes all migration tables through 0019');
      const forced = await client.query(`SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relrowsecurity AND c.relforcerowsecurity`, [cleanSchema]);
      assert.equal(forced.rows[0].count, 17, 'clean install FORCE-enables RLS on all tenant tables');
      const foreignKeys = await client.query(`SELECT count(*)::int AS count FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
        WHERE n.nspname=$1 AND c.contype='f'`, [cleanSchema]);
      assert.equal(foreignKeys.rows[0].count, 54, 'clean install creates logistics, geography and canonical foreign keys');
      const cleanProvider = await client.query(`SELECT
        has_table_privilege('rotamoto_app',$1||'.logistics_providers','SELECT') AS table_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','provider_id','SELECT') AS id_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','SELECT') AS secret_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','UPDATE') AS secret_update`, [cleanSchema]);
      assert.deepEqual(cleanProvider.rows[0], { table_select: false, id_select: true, secret_select: false, secret_update: false },
        'clean install 0001→0019 keeps secret_ref inaccessible to runtime');
    } finally { await client.query('ROLLBACK'); }
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [cleanSchema])).rowCount, 0,
      'clean-install schema sandbox was rolled back');

    const upgradeSchema = `logistics_upgrade_${crypto.randomUUID().replaceAll('-', '')}`;
    await client.query('BEGIN');
    try {
      for (const migration of getMigrations().slice(0, 18))
        await client.query(migration.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const before0019 = await client.query(`SELECT has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','SELECT') AS secret_select`, [upgradeSchema]);
      assert.equal(before0019.rows[0].secret_select, true, 'upgrade precondition reproduces the 0018 table grant');
      const migration0019 = getMigrations()[18];
      assert.equal(migration0019.id, '0019_logistics_provider_secret_least_privilege');
      await client.query(migration0019.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const after0019 = await client.query(`SELECT
        has_table_privilege('rotamoto_app',$1||'.logistics_providers','SELECT') AS table_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','provider_id','SELECT') AS id_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','SELECT') AS secret_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','UPDATE') AS secret_update`, [upgradeSchema]);
      assert.deepEqual(after0019.rows[0], { table_select: false, id_select: true, secret_select: false, secret_update: false },
        'upgrade 0018→0019 revokes broad SELECT without weakening operational column reads');
    } finally { await client.query('ROLLBACK'); }
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [upgradeSchema])).rowCount, 0,
      'upgrade sandbox is rolled back');

    await client.query('BEGIN');
    try {
      const tenantA=id(), tenantB=id(), actor=id(), appInstall=id(), sourceDelivery=id(), externalDelivery=id(), driverA=id(), driverB=id();
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await client.query(`INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'QA logistics A','active')`, [tenantA]);
      await client.query(`INSERT INTO rotamoto.users(id,email) VALUES($1,$2)`, [actor, `qa-${actor}@example.invalid`]);
      await client.query(`INSERT INTO rotamoto.sync_installations(id,company_id,app_key,local_device_id)
        VALUES($1,$2,'restaurante',$3)`, [appInstall, tenantA, `qa-${appInstall}`]);
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Driver','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantA, driverA, appInstall, JSON.stringify({ id: driverA, companyId: tenantA })]);
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantA, sourceDelivery, appInstall, JSON.stringify({ id: sourceDelivery, companyId: tenantA, status: 'ASSIGNED', driverId: driverA })]);
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantA, externalDelivery, appInstall, JSON.stringify({ id: externalDelivery, companyId: tenantA, status: 'ASSIGNED', driverId: null })]);
      const internalProvider=id(), partner=id(), partnerB=id(), marketplace=id();
      await client.query(`INSERT INTO rotamoto.logistics_providers(company_id,provider_id,code,display_name,provider_class,created_by,updated_by)
        VALUES($1,$2,'internal_fleet','Frota própria','internal_fleet',$3,$3),($1,$4,'qa_partner','Parceiro QA','partner',$3,$3),
          ($1,$5,'qa_marketplace','Marketplace QA','marketplace',$3,$3)`, [tenantA, internalProvider, actor, partner, marketplace]);
      await client.query(`INSERT INTO rotamoto.delivery_fulfillments(company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,status,selected_by,updated_by,revision)
        VALUES($1,$2,$3,$4,'internal',$5,'selected',$6,$6,1),($1,$7,$8,$9,'external',NULL,'selected',$6,$6,1)`,
      [tenantA, id(), sourceDelivery, internalProvider, driverA, actor, id(), externalDelivery, partner]);
      await rejected(client, 'external_driver_guard', () => client.query(`INSERT INTO rotamoto.delivery_fulfillments
        (company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,status,selected_by,updated_by,revision)
        VALUES($1,$2,$3,$4,'external',$5,'selected',$6,$6,2)`, [tenantA,id(),externalDelivery,partner,driverA,actor]));
      await rejected(client, 'duplicate_active_guard', () => client.query(`INSERT INTO rotamoto.delivery_fulfillments
        (company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,status,selected_by,updated_by,revision)
        VALUES($1,$2,$3,$4,'external',NULL,'selected',$5,$5,2)`, [tenantA,id(),externalDelivery,partner,actor]));
      const attemptId=id(), digest=crypto.createHash('sha256').update('manual-request').digest();
      await client.query(`INSERT INTO rotamoto.dispatch_attempts(company_id,attempt_id,fulfillment_id,delivery_id,provider_id,idempotency_key,request_digest,attempt_number,status,requested_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,1,'requested',$8)`, [tenantA,attemptId,
        (await client.query(`SELECT fulfillment_id FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2`,[tenantA,externalDelivery])).rows[0].fulfillment_id,
        externalDelivery,partner,`key-${crypto.randomUUID()}`,digest,actor]);
      await rejected(client, 'duplicate_idempotency_guard', () => client.query(`INSERT INTO rotamoto.dispatch_attempts(company_id,attempt_id,fulfillment_id,delivery_id,provider_id,idempotency_key,request_digest,attempt_number,status,requested_by)
        SELECT company_id,$2,fulfillment_id,delivery_id,provider_id,idempotency_key,request_digest,2,'requested',$3
        FROM rotamoto.dispatch_attempts WHERE company_id=$1 AND attempt_id=$4`, [tenantA,id(),actor,attemptId]));
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantB]);
      await client.query(`INSERT INTO rotamoto.companies(id,name,status) VALUES($1,'QA logistics B','active')`, [tenantB]);
      await client.query(`INSERT INTO rotamoto.logistics_providers(company_id,provider_id,code,display_name,provider_class)
        VALUES($1,$2,'tenant_b_partner','Partner B','partner')`, [tenantB, partnerB]);
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Driver','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantB, driverB,
        (await client.query(`INSERT INTO rotamoto.sync_installations(id,company_id,app_key,local_device_id) VALUES($1,$2,'restaurante',$3) RETURNING id`,
          [id(),tenantB,`qa-${id()}`])).rows[0].id, JSON.stringify({ id: driverB, companyId: tenantB })]);
      const hidden = await client.query(`SELECT count(*)::int AS count FROM rotamoto.logistics_providers`);
      assert.equal(hidden.rows[0].count, 1, 'tenant B sees only its own provider, not tenant A providers');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      await rejected(client, 'cross_tenant_provider_fk', () => client.query(`INSERT INTO rotamoto.delivery_fulfillments
        (company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,status,selected_by,updated_by,revision)
        VALUES($1,$2,$3,$4,'external',NULL,'selected',$5,$5,2)`, [tenantA,id(),externalDelivery,partnerB,actor]));
      await rejected(client, 'cross_tenant_driver_fk', () => client.query(`INSERT INTO rotamoto.delivery_fulfillments
        (company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,status,selected_by,updated_by,revision)
        VALUES($1,$2,$3,$4,'internal',$5,'selected',$6,$6,2)`, [tenantA,id(),externalDelivery,internalProvider,driverB,actor]));
      const visible = await client.query(`SELECT count(*)::int AS count FROM rotamoto.logistics_providers`);
      assert.equal(visible.rows[0].count, 3);

      const logistics = createLogisticsService({ clock: () => new Date('2026-10-06T12:00:00.000Z') });
      const principal = { company_id: tenantA, user_id: actor };
      const serviceDelivery = id();
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantA, serviceDelivery, appInstall,
        JSON.stringify({ id: serviceDelivery, companyId: tenantA, status: 'CREATED', driverId: null })]);
      const internalAllocationId = id();
      const internal = await logistics.selectFulfillment(client, principal, serviceDelivery, { providerId: internalProvider, mode: 'internal',
        driverId: driverA, fulfillmentId: internalAllocationId, expectedRevision: 0 });
      assert.equal(internal.fulfillment.mode, 'internal');
      assert.equal((await client.query(`SELECT payload->>'driverId' AS driver FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2`, [tenantA, serviceDelivery])).rows[0].driver, driverA);

      const externalAllocationId = id();
      const external = await logistics.selectFulfillment(client, principal, serviceDelivery, { providerId: partner, mode: 'external',
        driverId: null, fulfillmentId: externalAllocationId, expectedRevision: internal.fulfillment.revision });
      assert.equal(external.fulfillment.mode, 'external');
      assert.equal((await client.query(`SELECT payload->>'driverId' AS driver FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2`, [tenantA, serviceDelivery])).rows[0].driver, null,
        'external allocations clear Driver and never invent an entity');
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM rotamoto.delivery_fulfillments WHERE company_id=$1 AND delivery_id=$2 AND status='superseded'`, [tenantA, serviceDelivery])).rows[0].n, 1,
        'internal allocation is retained as superseded history');

      const idempotencyKey = `manual-dispatch-${crypto.randomUUID()}`;
      const attempt = await logistics.requestDispatch(client, principal, serviceDelivery, { idempotencyKey });
      assert.equal(attempt.status, 'requested');
      assert.equal((await logistics.requestDispatch(client, principal, serviceDelivery, { idempotencyKey })).duplicate, true,
        'manual dispatch retry is idempotent');
      const afterRequest = await logistics.getFulfillment(client, principal, serviceDelivery);
      await rejected(client, 'active_external_reassignment', () => logistics.selectFulfillment(client, principal, serviceDelivery, {
        providerId: marketplace, mode: 'external', driverId: null, fulfillmentId: id(), expectedRevision: afterRequest.fulfillments[0].revision }));
      await rejected(client, 'stale_fulfillment_revision', () => logistics.updateFulfillment(client, principal, serviceDelivery,
        { expectedRevision: afterRequest.fulfillments[0].revision - 1, status: 'accepted' }));

      await logistics.updateFulfillment(client, principal, serviceDelivery, { expectedRevision: afterRequest.fulfillments[0].revision,
        status: 'accepted', externalReference: 'ref-QA-1' });
      const accepted = await logistics.getFulfillment(client, principal, serviceDelivery);
      await logistics.updateFulfillment(client, principal, serviceDelivery, { expectedRevision: accepted.fulfillments[0].revision, status: 'in_progress' });
      const progressing = await logistics.getFulfillment(client, principal, serviceDelivery);
      await logistics.updateFulfillment(client, principal, serviceDelivery, { expectedRevision: progressing.fulfillments[0].revision,
        status: 'completed', finalCostMinor: 1250, finalCostCurrency: 'BRL' });
      const completed = await logistics.getFulfillment(client, principal, serviceDelivery);
      assert.equal(completed.fulfillments[0].finalCost.amountMinor, 1250);
      assert.equal((await client.query(`SELECT payload->>'status' AS status FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2`, [tenantA, serviceDelivery])).rows[0].status, 'DELIVERED');

      const fallbackDelivery = id();
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantA, fallbackDelivery, appInstall,
        JSON.stringify({ id: fallbackDelivery, companyId: tenantA, status: 'CREATED', driverId: null })]);
      const extA = await logistics.selectFulfillment(client, principal, fallbackDelivery, { providerId: partner, mode: 'external',
        driverId: null, fulfillmentId: id(), expectedRevision: 0 });
      const extFailed = await logistics.updateFulfillment(client, principal, fallbackDelivery,
        { expectedRevision: extA.fulfillment.revision, status: 'failed' });
      const extB = await logistics.selectFulfillment(client, principal, fallbackDelivery, { providerId: marketplace, mode: 'external',
        driverId: null, fulfillmentId: id(), expectedRevision: extFailed.fulfillment.revision });
      assert.equal(extB.fulfillment.providerId, marketplace, 'partner to marketplace fallback is manual and versioned');
      const extBCancelled = await logistics.updateFulfillment(client, principal, fallbackDelivery,
        { expectedRevision: extB.fulfillment.revision, status: 'cancelled' });
      const internalFallback = await logistics.selectFulfillment(client, principal, fallbackDelivery, { providerId: internalProvider, mode: 'internal',
        driverId: driverA, fulfillmentId: id(), expectedRevision: extBCancelled.fulfillment.revision });
      assert.equal(internalFallback.fulfillment.mode, 'internal', 'external to internal fallback is manual and versioned');

      const disabledProvider = id();
      await client.query(`INSERT INTO rotamoto.logistics_providers(company_id,provider_id,code,display_name,provider_class,enabled)
        VALUES($1,$2,'disabled_qa','Disabled QA','partner',false)`, [tenantA, disabledProvider]);
      await rejected(client, 'disabled_provider_rejected', () => logistics.selectFulfillment(client, principal, fallbackDelivery,
        { providerId: disabledProvider, mode: 'external', driverId: null, fulfillmentId: id(), expectedRevision: internalFallback.fulfillment.revision }));
    } finally { await client.query('ROLLBACK'); }
    console.log('Logistics PostgreSQL E2E schema, RLS, FK, active-allocation and idempotency guards: PASS (transaction rolled back)');
  } finally { await client.end(); }
}
main().catch(error => { console.error(`Logistics PostgreSQL E2E failed: ${error.message}`); process.exitCode = 1; });
