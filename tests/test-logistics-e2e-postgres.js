'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClient } = require('../backend/postgres/connection');
const { e2eMigrationConnectionString, getMigrations } = require('../backend/postgres/migrate');
const { createLogisticsService } = require('../backend/logistics/service');
const { createProviderIntegrationService } = require('../backend/logistics/provider-integration');
const { createProviderWorker } = require('../backend/logistics/provider-worker');
const { createFakeLogisticsProvider } = require('./helpers/fake-logistics-provider');

function id() { return crypto.randomUUID(); }
async function rejected(client, name, query) {
  await client.query(`SAVEPOINT ${name}`);
  await assert.rejects(query);
  await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
  await client.query(`RELEASE SAVEPOINT ${name}`);
}

async function main() {
  const connectionString = e2eMigrationConnectionString(process.env);
  const client = createClient({ connectionString, application_name: 'rotamoto-logistics-e2e-test', statement_timeout: 5000 });
  await client.connect();
  try {
    const identity = (await client.query(`SELECT current_user AS role,current_database() AS database,
      (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass`)).rows[0];
    assert.deepEqual(identity, { role: 'rotamoto_migrator', database: 'rotamoto_e2e', bypass: false });
    const migration = await client.query(`SELECT migration_id FROM rotamoto.schema_migrations
      WHERE migration_id IN ('0017_logistics_fulfillment','0018_delivery_geo_snapshots','0019_logistics_provider_secret_least_privilege','0020_provider_integration_runtime','0021_provider_claim_tenant_scope','0022_provider_ambiguous_lease_recovery','0023_provider_worker_least_privilege','0024_provider_tracking_status_grant','0025_provider_event_worker_grants','0026_provider_fulfillment_event_grants','0027_logistics_intelligence_settings','0028_external_account_secret_least_privilege','0029_logistics_human_decisions','0030_logistics_decision_stale_approval','0031_logistics_decision_worker_projection','0032_logistics_route_origin_settings')
      ORDER BY migration_id`);
    assert.deepEqual(migration.rows.map(row => row.migration_id), [
      '0017_logistics_fulfillment','0018_delivery_geo_snapshots','0019_logistics_provider_secret_least_privilege','0020_provider_integration_runtime','0021_provider_claim_tenant_scope','0022_provider_ambiguous_lease_recovery','0023_provider_worker_least_privilege','0024_provider_tracking_status_grant','0025_provider_event_worker_grants','0026_provider_fulfillment_event_grants','0027_logistics_intelligence_settings','0028_external_account_secret_least_privilege','0029_logistics_human_decisions','0030_logistics_decision_stale_approval','0031_logistics_decision_worker_projection','0032_logistics_route_origin_settings'
    ], 'E2E schema includes the tested logistics, geography and least-privilege migrations');
    const catalog = await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
      has_table_privilege('rotamoto_app',c.oid,'SELECT') AS app_select,
      has_table_privilege('rotamoto_app',c.oid,'DELETE') AS app_delete
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [['logistics_providers','delivery_fulfillments','dispatch_attempts','logistics_decisions','logistics_route_settings']]);
    assert.equal(catalog.rowCount, 5);
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
    const workerRole=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rotamoto_provider_worker') AS worker_exists`);
    if(workerRole.rows[0].worker_exists){const decisionWorkerAcl=await client.query(`SELECT
      has_table_privilege('rotamoto_provider_worker','rotamoto.logistics_decisions','SELECT') AS table_select,
      has_column_privilege('rotamoto_provider_worker','rotamoto.logistics_decisions','company_id','SELECT') AS tenant_select,
      has_column_privilege('rotamoto_provider_worker','rotamoto.logistics_decisions','execution_result','SELECT') AS result_select,
      has_column_privilege('rotamoto_provider_worker','rotamoto.logistics_decisions','snapshot','SELECT') AS snapshot_select,
      has_column_privilege('rotamoto_provider_worker','rotamoto.logistics_decisions','status','UPDATE') AS status_update,
      has_column_privilege('rotamoto_provider_worker','rotamoto.logistics_decisions','version','UPDATE') AS version_update,
      has_column_privilege('rotamoto_provider_worker','rotamoto.logistics_decisions','decided_by','UPDATE') AS actor_update`);
      assert.deepEqual(decisionWorkerAcl.rows[0],{table_select:false,tenant_select:true,result_select:true,snapshot_select:false,status_update:true,
        version_update:true,actor_update:false},'worker decision projection grants only fields needed for async state transitions');}

    const cleanSchema = `logistics_sandbox_${crypto.randomUUID().replaceAll('-', '')}`;
    await client.query('BEGIN');
    try {
      for (const migration of getMigrations()) await client.query(migration.up.replace(/\brotamoto\b/gu, cleanSchema));
      const intelligenceTable = await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege('rotamoto_app',c.oid,'SELECT') AS app_select,has_table_privilege('rotamoto_app',c.oid,'DELETE') AS app_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='logistics_intelligence_settings'`, [cleanSchema]);
      assert.deepEqual(intelligenceTable.rows[0], { relrowsecurity: true, relforcerowsecurity: true, owner: 'rotamoto_migrator',
        app_select: true, app_delete: false }, 'economic settings are tenant scoped and runtime least privilege applies');
      const intelligencePolicy = await client.query(`SELECT policyname,qual,with_check FROM pg_policies
        WHERE schemaname=$1 AND tablename='logistics_intelligence_settings'`, [cleanSchema]);
      assert.equal(intelligencePolicy.rowCount, 1);
      assert.equal(intelligencePolicy.rows[0].policyname, 'tenant_isolation');
      assert.match(intelligencePolicy.rows[0].qual, /current_tenant_id/u);
      assert.match(intelligencePolicy.rows[0].with_check, /current_tenant_id/u);
      const routeSettingsTable=await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege('rotamoto_app',c.oid,'SELECT') AS app_select,has_table_privilege('rotamoto_app',c.oid,'DELETE') AS app_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='logistics_route_settings'`,[cleanSchema]);
      assert.deepEqual(routeSettingsTable.rows[0],{relrowsecurity:true,relforcerowsecurity:true,owner:'rotamoto_migrator',app_select:true,app_delete:false},
        'route origin settings are tenant isolated and non-destructive for runtime');
      const routeSettingsPolicy=await client.query(`SELECT policyname,qual,with_check FROM pg_policies WHERE schemaname=$1 AND tablename='logistics_route_settings'`,[cleanSchema]);
      assert.equal(routeSettingsPolicy.rowCount,1);assert.equal(routeSettingsPolicy.rows[0].policyname,'tenant_isolation');
      assert.match(routeSettingsPolicy.rows[0].qual,/current_tenant_id/u);assert.match(routeSettingsPolicy.rows[0].with_check,/current_tenant_id/u);
      const routeSettingsConstraints=await client.query(`SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=($1||'.logistics_route_settings')::regclass`,[cleanSchema]);
      assert.ok(routeSettingsConstraints.rows.some(row=>row.contype==='c'&&/origin_latitude.*-90/u.test(row.definition)));
      assert.ok(routeSettingsConstraints.rows.some(row=>row.contype==='c'&&/origin_mode/u.test(row.definition)));
      const decisionTable=await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege('rotamoto_app',c.oid,'SELECT') AS app_select,has_table_privilege('rotamoto_app',c.oid,'DELETE') AS app_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='logistics_decisions'`,[cleanSchema]);
      assert.deepEqual(decisionTable.rows[0],{relrowsecurity:true,relforcerowsecurity:true,owner:'rotamoto_migrator',app_select:true,app_delete:false},
        'decision persistence uses forced tenant RLS and non-destructive runtime grants');
      const decisionPolicy=await client.query(`SELECT policyname,qual,with_check FROM pg_policies WHERE schemaname=$1 AND tablename='logistics_decisions'`,[cleanSchema]);
      assert.equal(decisionPolicy.rowCount,1);assert.equal(decisionPolicy.rows[0].policyname,'tenant_isolation');
      assert.match(decisionPolicy.rows[0].qual,/current_tenant_id/u);assert.match(decisionPolicy.rows[0].with_check,/current_tenant_id/u);
      const decisionConstraints=await client.query(`SELECT contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=($1||'.logistics_decisions')::regclass`,[cleanSchema]);
      assert.ok(decisionConstraints.rows.some(row=>row.contype==='f'&&/FOREIGN KEY \(company_id, delivery_id\)/u.test(row.definition)));
      assert.ok(decisionConstraints.rows.some(row=>row.contype==='c'&&/status/u.test(row.definition)));
      const decisionIndexes=await client.query(`SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND tablename='logistics_decisions'`,[cleanSchema]);
      assert.ok(decisionIndexes.rows.some(row=>/UNIQUE.*\(company_id, execution_key\)/u.test(row.indexdef)));
      const intelligenceConstraints = await client.query(`SELECT conname,contype,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid=($1||'.logistics_intelligence_settings')::regclass`, [cleanSchema]);
      assert.ok(intelligenceConstraints.rows.some(row => row.contype === 'f' && /FOREIGN KEY \(company_id, internal_provider_id\)/u.test(row.definition)),
        'economic profile references internal provider within its tenant');
      const cleanProvider = await client.query(`SELECT
        has_table_privilege('rotamoto_app',$1||'.logistics_providers','SELECT') AS table_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','provider_id','SELECT') AS id_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','SELECT') AS secret_select,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','UPDATE') AS secret_update`, [cleanSchema]);
      assert.deepEqual(cleanProvider.rows[0], { table_select: false, id_select: true, secret_select: false, secret_update: false },
        'clean install through 0020 keeps secret_ref inaccessible to runtime');
      const providerTables = await client.query(`SELECT count(*)::int AS total,
        count(*) FILTER(WHERE relrowsecurity AND relforcerowsecurity)::int AS forced
        FROM pg_class WHERE oid IN ('${cleanSchema}.provider_quotes'::regclass,'${cleanSchema}.provider_command_outbox'::regclass,
          '${cleanSchema}.provider_event_inbox'::regclass,'${cleanSchema}.provider_tracking_snapshots'::regclass)`);
      assert.deepEqual(providerTables.rows[0], { total: 4, forced: 4 }, 'all provider integration tables enforce tenant RLS');
      const providerColumns = await client.query(`SELECT c.relname,a.attname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attname`,
      [cleanSchema,['provider_quotes','provider_command_outbox','provider_event_inbox','provider_tracking_snapshots']]);
      const columns = new Map();
      for (const row of providerColumns.rows) columns.set(row.relname,[...(columns.get(row.relname)||[]),row.attname]);
      for (const [table, required] of Object.entries({
        provider_quotes:['company_id','delivery_id','fulfillment_id','provider_id','external_quote_id','currency','amount_minor','eta_at','issued_at','expires_at','selected_at','provider_snapshot','version'],
        provider_command_outbox:['company_id','provider_id','delivery_id','fulfillment_id','operation','idempotency_key','payload','status','attempts','next_attempt_at','lease_token','lease_until','last_error_class','correlation_id'],
        provider_event_inbox:['company_id','provider_id','external_event_id','body_digest','normalized_event','status','received_at','processed_at'],
        provider_tracking_snapshots:['company_id','fulfillment_id','delivery_id','provider_id','provenance','status','eta_at','provider_updated_at','last_event_id']
      })) for (const column of required) assert.ok(columns.get(table)?.includes(column), `${table}.${column} is part of the durable provider contract`);
      const providerPolicies = await client.query(`SELECT tablename,policyname FROM pg_policies WHERE schemaname=$1 AND tablename=ANY($2::text[])`,
        [cleanSchema,['provider_quotes','provider_command_outbox','provider_event_inbox','provider_tracking_snapshots']]);
      assert.deepEqual(providerPolicies.rows.map(row=>`${row.tablename}:${row.policyname}`).sort(),
        ['provider_command_outbox:tenant_isolation','provider_event_inbox:tenant_isolation','provider_quotes:tenant_isolation','provider_tracking_snapshots:tenant_isolation'],
        'each provider persistence table has its tenant isolation policy');
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
      const migration0020 = getMigrations()[19];
      assert.equal(migration0020.id, '0020_provider_integration_runtime');
      await client.query(migration0020.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0021 = getMigrations()[20];
      assert.equal(migration0021.id, '0021_provider_claim_tenant_scope');
      await client.query(migration0021.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0022 = getMigrations()[21];
      assert.equal(migration0022.id, '0022_provider_ambiguous_lease_recovery');
      await client.query(migration0022.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0023 = getMigrations()[22];
      assert.equal(migration0023.id, '0023_provider_worker_least_privilege');
      await client.query(migration0023.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const claimAcl = await client.query(`SELECT has_function_privilege('rotamoto_app',$1||'.claim_provider_command(uuid,uuid,integer)','EXECUTE') AS app_execute`, [upgradeSchema]);
      assert.equal(claimAcl.rows[0].app_execute, false, 'application runtime cannot claim cross-tenant provider commands');
      const migration0024 = getMigrations()[23];
      assert.equal(migration0024.id, '0024_provider_tracking_status_grant');
      await client.query(migration0024.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0025 = getMigrations()[24];
      assert.equal(migration0025.id, '0025_provider_event_worker_grants');
      await client.query(migration0025.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0026 = getMigrations()[25];
      assert.equal(migration0026.id, '0026_provider_fulfillment_event_grants');
      await client.query(migration0026.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0027 = getMigrations()[26];
      assert.equal(migration0027.id, '0027_logistics_intelligence_settings');
      await client.query(migration0027.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0028 = getMigrations()[27];
      assert.equal(migration0028.id, '0028_external_account_secret_least_privilege');
      await client.query(migration0028.up.replace(/\brotamoto\b/gu, upgradeSchema));
      const migration0029=getMigrations()[28];
      assert.equal(migration0029.id,'0029_logistics_human_decisions');
      await client.query(migration0029.up.replace(/\brotamoto\b/gu,upgradeSchema));
      const migration0030=getMigrations()[29];
      assert.equal(migration0030.id,'0030_logistics_decision_stale_approval');
      await client.query(migration0030.up.replace(/\brotamoto\b/gu,upgradeSchema));
      const decisionLifecycleConstraint=await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=($1||'.logistics_decisions')::regclass AND conname='logistics_decisions_decision_actor_state_check'`,[upgradeSchema]);
      assert.equal(decisionLifecycleConstraint.rowCount,1);
      assert.match(decisionLifecycleConstraint.rows[0].definition,/status = 'stale'[\s\S]*decided_by IS NOT NULL/u,
        'approved proposals can become stale while retaining operator provenance');
      const migration0031=getMigrations()[30];
      assert.equal(migration0031.id,'0031_logistics_decision_worker_projection');
      await client.query(migration0031.up.replace(/\brotamoto\b/gu,upgradeSchema));
      const decisionStatuses=await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid=($1||'.logistics_decisions')::regclass AND conname='logistics_decisions_status_check'`,[upgradeSchema]);
      assert.match(decisionStatuses.rows[0].definition,/cancelled/u,'decision lifecycle can record provider cancellation confirmation');
      const migration0032=getMigrations()[31];assert.equal(migration0032.id,'0032_logistics_route_origin_settings');
      await client.query(migration0032.up.replace(/\brotamoto\b/gu,upgradeSchema));
      const routeSettingsSecurity=await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege('rotamoto_app',c.oid,'SELECT') AS runtime_read,has_table_privilege('rotamoto_app',c.oid,'DELETE') AS runtime_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='logistics_route_settings'`,[upgradeSchema]);
      assert.deepEqual(routeSettingsSecurity.rows[0],{relrowsecurity:true,relforcerowsecurity:true,owner:'rotamoto_migrator',runtime_read:true,runtime_delete:false});
      const routeSettingsPolicy=await client.query(`SELECT qual,with_check FROM pg_policies WHERE schemaname=$1 AND tablename='logistics_route_settings'`,[upgradeSchema]);
      assert.equal(routeSettingsPolicy.rowCount,1);assert.match(routeSettingsPolicy.rows[0].qual,/current_tenant_id/u);assert.match(routeSettingsPolicy.rows[0].with_check,/current_tenant_id/u);
      const after0020 = await client.query(`SELECT has_table_privilege('rotamoto_app',$1||'.provider_command_outbox','SELECT') AS command_read,
        has_table_privilege('rotamoto_app',$1||'.provider_command_outbox','DELETE') AS command_delete,
        has_column_privilege('rotamoto_app',$1||'.logistics_providers','secret_ref','SELECT') AS secret_read,
        (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid=($1||'.provider_event_inbox')::regclass) AS inbox_forced`, [upgradeSchema]);
      assert.deepEqual(after0020.rows[0], { command_read: true, command_delete: false, secret_read: false, inbox_forced: true },
        'upgrade 0019→0020 adds durable provider runtime tables without secret access');
    } finally { await client.query('ROLLBACK'); }
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [upgradeSchema])).rowCount, 0,
      'upgrade sandbox is rolled back');

    const from0022Schema=`logistics_upgrade_0022_${crypto.randomUUID().replaceAll('-','')}`;
    await client.query('BEGIN');
    try{
      for(const migration of getMigrations().slice(0,22))await client.query(migration.up.replace(/\brotamoto\b/gu,from0022Schema));
      for(const migration of getMigrations().slice(22))await client.query(migration.up.replace(/\brotamoto\b/gu,from0022Schema));
      const upgradedRouteSettings=await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege('rotamoto_app',c.oid,'DELETE') AS runtime_delete FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname='logistics_route_settings'`,[from0022Schema]);
      assert.deepEqual(upgradedRouteSettings.rows[0],{relrowsecurity:true,relforcerowsecurity:true,owner:'rotamoto_migrator',runtime_delete:false},
        'clean install and upgrade 0022→latest creates tenant-scoped operational route configuration');
      const companyLocationColumns=await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='companies'
        AND column_name=ANY($2::text[]) ORDER BY column_name`,[from0022Schema,['support_phone','operational_address','operational_latitude','operational_longitude',
        'operational_location_provenance','operational_location_version','company_settings_version']]);
      assert.deepEqual(companyLocationColumns.rows.map(row=>row.column_name),['company_settings_version','operational_address','operational_latitude',
        'operational_location_provenance','operational_location_version','operational_longitude','support_phone'],
        'clean install and upgrade 0022→0033 contains the canonical Company identity and operational location contract');
      const companyLocationSecurity=await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        has_column_privilege('rotamoto_app',c.oid,'operational_latitude','SELECT') AS location_read,
        has_column_privilege('rotamoto_app',c.oid,'operational_latitude','UPDATE') AS location_update,
        has_column_privilege('rotamoto_app',c.oid,'name','UPDATE') AS company_name_update,
        EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname=$1 AND p.tablename='companies' AND p.qual LIKE '%current_tenant_id%') AS tenant_policy
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='companies'`,[from0022Schema]);
      assert.deepEqual(companyLocationSecurity.rows[0],{relrowsecurity:true,relforcerowsecurity:true,owner:'rotamoto_migrator',
        location_read:true,location_update:true,company_name_update:true,tenant_policy:true},
        'Company location remains RLS/forced, migrator-owned, tenant-scoped and exposes only the authorized operational write fields');
    }finally{await client.query('ROLLBACK')}
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[from0022Schema])).rowCount,0,'0022 upgrade sandbox rolled back');

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
      const externalFulfillmentId=id();
      await client.query(`INSERT INTO rotamoto.delivery_fulfillments(company_id,fulfillment_id,delivery_id,provider_id,mode,driver_id,status,selected_by,updated_by,revision)
        VALUES($1,$2,$3,$4,'internal',$5,'selected',$6,$6,1),($1,$7,$8,$9,'external',NULL,'selected',$6,$6,1)`,
      [tenantA, id(), sourceDelivery, internalProvider, driverA, actor, externalFulfillmentId, externalDelivery, partner]);
      await client.query(`UPDATE rotamoto.logistics_providers SET integration_mode='api',api_enabled=true,secret_ref='local-v1:00000000-0000-4000-8000-000000000099',capabilities=ARRAY['manual_assignment','quote','dispatch','cancel','tracking']::text[] WHERE company_id=$1 AND provider_id=$2`, [tenantA,partner]);
      const staleDispatchId=id(), staleQuoteId=id(), lease=id();
      await client.query(`INSERT INTO rotamoto.provider_command_outbox(company_id,command_id,provider_id,delivery_id,fulfillment_id,operation,idempotency_key,payload,status,attempts,lease_token,lease_until,correlation_id)
        VALUES($1,$2,$3,$4,$5,'DISPATCH_REQUEST',$6,$7::jsonb,'leased',1,$8,now()-interval '1 minute',$9),
          ($1,$10,$3,$4,$5,'QUOTE_REQUEST',$11,$12::jsonb,'leased',1,$8,now()-interval '1 minute',$13)`,
      [tenantA,staleDispatchId,partner,externalDelivery,externalFulfillmentId,`dispatch-${staleDispatchId}`,JSON.stringify({deliveryId:externalDelivery}),lease,id(),staleQuoteId,`quote-${staleQuoteId}`,JSON.stringify({deliveryId:externalDelivery}),id()]);
      const claimed = await client.query('SELECT * FROM rotamoto.claim_provider_command($1,$2,$3)', [tenantA,id(),45]);
      assert.equal(claimed.rowCount,1);
      assert.equal(claimed.rows[0].command_id,staleQuoteId,'a read-safe expired lease is reclaimed');
      const ambiguous = await client.query(`SELECT status,last_error_class,lease_token FROM rotamoto.provider_command_outbox WHERE company_id=$1 AND command_id=$2`, [tenantA,staleDispatchId]);
      assert.deepEqual(ambiguous.rows[0], {status:'unknown_outcome',last_error_class:'UNKNOWN_OUTCOME',lease_token:null},
        'expired dispatch lease becomes ambiguous and is never blindly reclaimed');
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

      const providerIntegration = createProviderIntegrationService();
      const logistics = createLogisticsService({ providerIntegration });
      const principal = { company_id: tenantA, user_id: actor };
      const manualKey = `manual-dispatch-${crypto.randomUUID()}`;
      const manualAttempt = await logistics.requestDispatch(client, principal, externalDelivery, { idempotencyKey:manualKey });
      assert.equal(manualAttempt.status,'requested');
      assert.equal((await logistics.requestDispatch(client, principal, externalDelivery, { idempotencyKey:manualKey })).duplicate,true,
        'manual dispatch retry is idempotent');
      const serviceDelivery = id();
      const serviceOrder = id();
      const externalOrderReference = id();
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantA, serviceOrder, appInstall,
        JSON.stringify({ id: serviceOrder, companyId: tenantA, source: 'ifood', externalId: externalOrderReference })]);
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Delivery','restaurante',$3,$4::jsonb,1,now(),now())`, [tenantA, serviceDelivery, appInstall,
        JSON.stringify({ id: serviceDelivery, companyId: tenantA, orderId: serviceOrder, status: 'CREATED', driverId: null })]);
      const economicSettings = await logistics.updateIntelligenceSettings(client, principal, { expectedVersion: 0,
        fixedCostPerDeliveryMinor: 500, variableCostPerKmMinor: 100, currency: 'BRL', defaultPolicy: 'lowest_cost' });
      assert.equal(economicSettings.settings.version, 1);
      const comparison = await logistics.compareLogisticsAlternatives(client, principal, serviceDelivery);
      assert.equal(comparison.inputs.commercialOrderValueUsed, false);
      assert.equal(comparison.inputs.earningUsedAsTotalCost, false);
      assert.equal(comparison.alternatives.find(item => item.mode === 'internal').cost.status, 'insufficient_data',
        'a configured variable cost with unknown distance is not silently treated as zero');
      assert.equal(comparison.recommendation.status, 'insufficient_data', 'no valid external quote means abstain');
      const staleByFleet=await logistics.evaluateLogisticsDecision(client,principal,serviceDelivery,'lowest_cost');
      const staleRoute=id();
      await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=version+1,updated_at=now()
        WHERE company_id=$1 AND record_id=$2`,[tenantA,driverA,JSON.stringify({id:driverA,companyId:tenantA,status:'AVAILABLE',capacity:{unit:'deliveries',limit:2}})]);
      await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
        VALUES($1,$2,'Route','restaurante',$3,$4::jsonb,1,now(),now())`,[tenantA,staleRoute,appInstall,JSON.stringify({id:staleRoute,companyId:tenantA,status:'PLANNED',deliveryIds:[]})]);
      const staleResult=await logistics.approveLogisticsDecision(client,principal,staleByFleet.decision.id,{expectedVersion:1,
        alternativeId:staleByFleet.decision.snapshot.alternatives.find(item=>item.eligible).id});
      assert.equal(staleResult.stale,true,'capacity/route changes stale an unapproved recommendation');
      assert.equal(staleResult.decision.status,'stale');
      const recalculated=await logistics.recalculateLogisticsDecision(client,principal,staleByFleet.decision.id,{expectedVersion:2});
      assert.equal(recalculated.decision.status,'proposed','recalculation creates a new immutable proposal');
      const rejectedDecision=await logistics.rejectLogisticsDecision(client,principal,recalculated.decision.id,{expectedVersion:1});
      assert.equal(rejectedDecision.decision.status,'rejected');
      const staleAfterApproval=await logistics.evaluateLogisticsDecision(client,principal,serviceDelivery,'lowest_cost');
      const approvedThenStale=await logistics.approveLogisticsDecision(client,principal,staleAfterApproval.decision.id,{expectedVersion:1,
        alternativeId:staleAfterApproval.decision.snapshot.alternatives.find(item=>item.eligible).id});
      assert.equal(approvedThenStale.decision.status,'approved');
      await client.query(`UPDATE rotamoto.domain_records SET version=version+1,updated_at=now() WHERE company_id=$1 AND record_id=$2 AND entity_type='Driver'`,[tenantA,driverA]);
      const staleExecution=await logistics.executeLogisticsDecision(client,principal,staleAfterApproval.decision.id,{expectedVersion:2,confirmExecution:true,
        idempotencyKey:`stale-approved-${staleAfterApproval.decision.id}`,alternativeId:'deliberately-not-executed'});
      assert.equal(staleExecution.stale,true,'state changes after approval prevent execution');
      assert.equal(staleExecution.decision.status,'stale');
      assert.equal(staleExecution.decision.decidedBy,actor,'stale approval keeps the approving actor for audit reconstruction');
      await assert.rejects(logistics.updateIntelligenceSettings(client, principal, { expectedVersion: 0,
        fixedCostPerDeliveryMinor: 500, variableCostPerKmMinor: 100, currency: 'BRL', defaultPolicy: 'lowest_cost' }),
      error => error.code === 'REVISION_CONFLICT', 'stale economic profile revision is rejected');
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

      const quoteRequest = await logistics.requestProviderQuote(client, principal, serviceDelivery, { providerId: partner, idempotencyKey: `quote-${crypto.randomUUID()}` });
      assert.equal(quoteRequest.status,'queued');
      const fake = createFakeLogisticsProvider({ clock: () => Date.now() });
      const fakeRegistryAdapter = { ...fake, async quote(context) { return { quote: await fake.quote(context) }; } };
      const workerClient = { async query(sql,params) {
        if (sql === 'BEGIN') return client.query('SAVEPOINT provider_worker_scope');
        if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT provider_worker_scope');
        if (sql === 'ROLLBACK') { await client.query('ROLLBACK TO SAVEPOINT provider_worker_scope'); return client.query('RELEASE SAVEPOINT provider_worker_scope'); }
        return client.query(sql,params);
      }, release(){} };
      const worker = createProviderWorker({ pool: { query:(sql,params)=>client.query(sql,params), async connect(){ return workerClient; } },
        adapterRegistry:{ get:()=>fakeRegistryAdapter }, credentialResolver:async()=>({clientId:'test',clientSecret:'test'}), tenantResolver:async()=>[tenantA],
        providerIntegration, logger:()=>{} });
      assert.equal(await worker.runOnce(),true,'fake worker handles queued quote');
      const quoteCommandState = await client.query(`SELECT status,last_error_class FROM rotamoto.provider_command_outbox WHERE company_id=$1 AND command_id=$2`,[tenantA,quoteRequest.commandId]);
      assert.equal(quoteCommandState.rows[0]?.status,'succeeded',`fake quote command should complete (${quoteCommandState.rows[0]?.last_error_class || 'no error class'})`);
      let availableQuotes = await logistics.listProviderQuotes(client,principal,serviceDelivery);
      assert.equal(availableQuotes.quotes.length,1);
      assert.equal(availableQuotes.quotes[0].amountMinor,1290);
      const staleByQuote=await logistics.evaluateLogisticsDecision(client,principal,serviceDelivery,'lowest_cost');
      await providerIntegration.selectQuote(client,principal,availableQuotes.quotes[0].id,availableQuotes.quotes[0].version);
      const staleQuoteResult=await logistics.approveLogisticsDecision(client,principal,staleByQuote.decision.id,{expectedVersion:1,
        alternativeId:staleByQuote.decision.snapshot.alternatives.find(item=>item.eligible&&item.mode==='external_api').id});
      assert.equal(staleQuoteResult.stale,true,'quote status/version changes stale an unapproved decision');
      await client.query(`UPDATE rotamoto.provider_quotes SET status='available',selected_at=NULL,version=version+1,updated_at=now()
        WHERE company_id=$1 AND quote_id=$2`,[tenantA,availableQuotes.quotes[0].id]);
      availableQuotes=await logistics.listProviderQuotes(client,principal,serviceDelivery);
      const proposed=await logistics.evaluateLogisticsDecision(client,principal,serviceDelivery,'lowest_cost');
      assert.equal(proposed.decision.status,'proposed');
      assert.ok(proposed.decision.snapshot.alternatives.some(item=>item.mode==='external_api'&&item.eligible),
        'valid provider quote is preserved among decision alternatives');
      const approved=await logistics.approveLogisticsDecision(client,principal,proposed.decision.id,{expectedVersion:1,
        alternativeId:`quote:${availableQuotes.quotes[0].id}`});
      assert.equal(approved.decision.status,'approved');
      assert.equal(approved.decision.decidedBy,actor);
      assert.equal(approved.decision.selectedAlternativeId,`quote:${availableQuotes.quotes[0].id}`,'human approval pins the exact alternative to execute');
      assert.equal((await logistics.approveLogisticsDecision(client,principal,proposed.decision.id,{expectedVersion:1,
        alternativeId:`quote:${availableQuotes.quotes[0].id}`})).duplicate,true,'repeated approval of the same alternative is idempotent');
      await rejected(client,'decision_cannot_execute_unapproved_alternative',()=>logistics.executeLogisticsDecision(client,principal,proposed.decision.id,
        {expectedVersion:2,confirmExecution:true,idempotencyKey:`wrong-alt-${proposed.decision.id}`,alternativeId:'internal:unapproved'}));
      const decisionFulfillmentId=id();
      const decisionExecution=await logistics.executeLogisticsDecision(client,principal,proposed.decision.id,{expectedVersion:2,confirmExecution:true,
        idempotencyKey:`decision-${proposed.decision.id}`,alternativeId:`quote:${availableQuotes.quotes[0].id}`,quoteId:availableQuotes.quotes[0].id,
        expectedQuoteVersion:availableQuotes.quotes[0].version,expectedFulfillmentRevision:external.fulfillment.revision,fulfillmentId:decisionFulfillmentId});
      assert.equal(decisionExecution.decision.status,'execution_requested','external command remains pending after durable request');
      assert.equal(decisionExecution.action.status,'pending','provider dispatch response is 202-like pending, not confirmation');
      assert.equal((await logistics.executeLogisticsDecision(client,principal,proposed.decision.id,{expectedVersion:2,confirmExecution:true,
        idempotencyKey:`decision-${proposed.decision.id}`,alternativeId:`quote:${availableQuotes.quotes[0].id}`,quoteId:availableQuotes.quotes[0].id,
        expectedQuoteVersion:availableQuotes.quotes[0].version,expectedFulfillmentRevision:external.fulfillment.revision,fulfillmentId:decisionFulfillmentId})).duplicate,true,
        'repeat execution with the same idempotency key does not create a second attempt');
      await rejected(client,'decision_idempotency_payload_conflict',()=>logistics.executeLogisticsDecision(client,principal,proposed.decision.id,
        {expectedVersion:2,confirmExecution:true,idempotencyKey:`decision-${proposed.decision.id}`,alternativeId:'different-alternative'}));
      const apiDispatch=decisionExecution.action;
      const selectedQuote={fulfillment:{id:(await client.query(`SELECT fulfillment_id FROM rotamoto.provider_quotes WHERE company_id=$1 AND quote_id=$2`,[tenantA,availableQuotes.quotes[0].id])).rows[0].fulfillment_id}};
      await worker.runOnce();
      const confirmedAttempt = await client.query(`SELECT status FROM rotamoto.dispatch_attempts WHERE company_id=$1 AND attempt_id=$2`,[tenantA,apiDispatch.attemptId]);
      assert.equal(confirmedAttempt.rows[0].status,'accepted','fake adapter confirmation updates its linked dispatch attempt');
      const eventTime = new Date().toISOString();
      const rawEvent = Buffer.from(JSON.stringify({ id:'evt-internal-1',orderId:externalOrderReference,fullCode:'REQUEST_DRIVER_SUCCESS',createdAt:eventTime }));
      const normalizedEvent = { externalEventId:'evt-internal-1',externalOrderId:externalOrderReference,occurredAt:eventTime,status:'accepted',externalStatus:'REQUEST_DRIVER_SUCCESS' };
      const inboxFirst = await providerIntegration.ingestEvent(client,{companyId:tenantA,providerId:partner,event:normalizedEvent,rawBody:rawEvent});
      const inboxDuplicate = await providerIntegration.ingestEvent(client,{companyId:tenantA,providerId:partner,event:normalizedEvent,rawBody:rawEvent});
      assert.equal(inboxFirst.duplicate,false);
      assert.equal(inboxDuplicate.duplicate,true,'duplicate event ID and digest is idempotent');
      const trackingRequest = await logistics.requestProviderTracking(client,principal,serviceDelivery,{idempotencyKey:`tracking-${crypto.randomUUID()}`});
      assert.equal(trackingRequest.status,'queued'); await worker.runOnce();
      const processedEvent = await client.query(`SELECT status,processed_at FROM rotamoto.provider_event_inbox WHERE company_id=$1 AND event_id=$2`,[tenantA,inboxFirst.event_id]);
      assert.equal(processedEvent.rows[0].status,'processed'); assert.ok(processedEvent.rows[0].processed_at);
      assert.equal((await logistics.getFulfillment(client,principal,serviceDelivery)).fulfillments.find(row=>row.id===selectedQuote.fulfillment.id).status,'accepted',
        'asynchronous event projection confirms only the matching tenant/provider external fulfillment');
      assert.equal((await logistics.listLogisticsDecisions(client,principal,serviceDelivery)).decisions.find(item=>item.id===proposed.decision.id).status,'executed',
        'decision history reflects confirmation only after the normalized provider event projected');
      const qualityReport=await logistics.logisticsDecisionQuality(client,principal);
      const qualityDecision=qualityReport.decisions.find(item=>item.id===proposed.decision.id);
      assert.ok(qualityDecision,'decision quality includes the immutable recommendation snapshot');
      assert.equal(qualityDecision.outcome.status,'pending','provider acceptance is not treated as delivery completion');
      assert.equal(qualityDecision.outcome.finalReconciledCost,null,'missing reconciled cost stays unknown');
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantB]);
      const tenantBQuality=await logistics.logisticsDecisionQuality(client,{company_id:tenantB,user_id:actor});
      assert.equal(tenantBQuality.decisions.some(item=>item.id===proposed.decision.id),false,'decision quality is isolated by tenant');
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenantA]);
      await worker.runOnce();
      const tracking = await client.query(`SELECT status,eta_at,provenance FROM rotamoto.provider_tracking_snapshots WHERE company_id=$1 AND fulfillment_id=$2`,[tenantA,selectedQuote.fulfillment.id]);
      assert.equal(tracking.rows[0].status,'in_progress'); assert.equal(tracking.rows[0].provenance,'external_provider');
      const cancelRequest = await logistics.requestProviderCancel(client,principal,serviceDelivery,{idempotencyKey:`cancel-${crypto.randomUUID()}`});
      await worker.runOnce();
      assert.equal((await client.query(`SELECT status FROM rotamoto.provider_command_outbox WHERE company_id=$1 AND command_id=$2`,[tenantA,cancelRequest.commandId])).rows[0].status,'succeeded',
        'provider cancel request acknowledgement is tracked separately from cancellation confirmation');
      const reconcileRequest = await logistics.requestProviderReconciliation(client,principal,serviceDelivery,{idempotencyKey:`reconcile-${crypto.randomUUID()}`});
      await worker.runOnce();
      assert.equal((await client.query(`SELECT operation FROM rotamoto.provider_command_outbox WHERE company_id=$1 AND command_id=$2`,[tenantA,reconcileRequest.commandId])).rows[0].operation,'RECONCILE');

      const afterRequest = await logistics.getFulfillment(client, principal, serviceDelivery);
      assert.equal(afterRequest.delivery.orderSource, 'ifood', 'commercial source is exposed separately from the logistics provider');
      await rejected(client, 'active_external_reassignment', () => logistics.selectFulfillment(client, principal, serviceDelivery, {
        providerId: marketplace, mode: 'external', driverId: null, fulfillmentId: id(), expectedRevision: afterRequest.fulfillments[0].revision }));
      await rejected(client, 'stale_fulfillment_revision', () => logistics.updateFulfillment(client, principal, serviceDelivery,
        { expectedRevision: afterRequest.fulfillments[0].revision - 1, status: 'accepted' }));

      assert.equal(afterRequest.fulfillments.find(row=>row.id===selectedQuote.fulfillment.id).status,'accepted');
      const accepted = afterRequest;
      await logistics.updateFulfillment(client, principal, serviceDelivery, { expectedRevision: accepted.fulfillments[0].revision, status: 'in_progress' });
      const logisticsReport = await logistics.analytics(client, principal);
      const partnerReport = logisticsReport.providers.find(item => item.providerId === partner);
      assert.equal(partnerReport.reconciledCostCount, 0);
      assert.equal(partnerReport.reconciledCostCoverage, 0, 'no reconciled cost is claimed while external cancellation is pending');
      assert.equal(partnerReport.estimatedCostCoverage,0.5,'provider quote contributes one known estimated cost from two partner allocations');
      assert.equal(partnerReport.estimatedCosts[0].amountMinor,1290,'provider quote estimate is recorded in native currency');

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
main().catch(error => { console.error(`Logistics PostgreSQL E2E failed: ${error.stack || error.message}`); process.exitCode = 1; });
