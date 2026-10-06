'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClient } = require('../backend/postgres/connection');
const { e2eMigrationConnectionString, getMigrations } = require('../backend/postgres/migrate');
const { createTerritorialAnalyticsService } = require('../backend/analytics/territorial-service');

const id = () => crypto.randomUUID();
async function main() {
  const connectionString = e2eMigrationConnectionString(process.env);
  const client = createClient({ connectionString, application_name:'rotamoto-territorial-e2e-test', statement_timeout:10000 });
  await client.connect();
  const schema = `territorial_${crypto.randomUUID().replaceAll('-','')}`;
  try {
    const identity = (await client.query(`SELECT current_user AS role,current_database() AS database,
      (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`)).rows[0];
    assert.deepEqual(identity,{role:'rotamoto_migrator',database:'rotamoto_e2e',elevated:false},'only the E2E migration role is used; no elevated attributes');
    const applicationRoles = await client.query(`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
      FROM pg_roles WHERE rolname IN ('rotamoto_app','rotamoto_migrator') ORDER BY rolname`);
    assert.deepEqual(applicationRoles.rows,[
      {rolname:'rotamoto_app',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false},
      {rolname:'rotamoto_migrator',rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false}
    ],'runtime and migrator remain unprivileged and NOBYPASSRLS');
    await client.query('BEGIN');
    try {
      for (const migration of getMigrations()) await client.query(migration.up.replace(/\brotamoto\b/gu,schema));
      const security = await client.query(`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege('rotamoto_app',$1||'.delivery_geo_snapshots','SELECT') AS app_select,
        has_table_privilege('rotamoto_app',$1||'.delivery_geo_snapshots','DELETE') AS app_delete,
        has_column_privilege('rotamoto_app',$1||'.delivery_geo_snapshots','latitude','INSERT') AS app_insert,
        has_table_privilege('rotamoto_app',$1||'.delivery_geo_snapshots','UPDATE') AS app_table_update,
        (SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policy_count
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='delivery_geo_snapshots'`,[schema]);
      assert.deepEqual(security.rows[0],{relrowsecurity:true,relforcerowsecurity:true,owner:'rotamoto_migrator',app_select:true,app_delete:false,app_insert:true,app_table_update:false,policy_count:1});
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='delivery_geo_snapshots' AND con.contype='f'`,[schema])).rows[0].count,4);
      const tenants=[id(),id()], user=id(), installations=[id(),id()], orders=[id(),id()], deliveries=[id(),id()];
      for (let i=0;i<2;i++) {
        await client.query('SELECT set_config($1,$2,true)',[`app.tenant_id`,tenants[i]]);
        await client.query(`INSERT INTO ${schema}.companies(id,name,status) VALUES($1,$2,'active')`,[tenants[i],`QA geo ${i}`]);
        if(i===0) await client.query(`INSERT INTO ${schema}.users(id,email) VALUES($1,$2)`,[user,`geo-${user}@example.invalid`]);
        await client.query(`INSERT INTO ${schema}.sync_installations(id,company_id,app_key,local_device_id) VALUES($1,$2,'restaurante',$3)`,[installations[i],tenants[i],`geo-${i}-${installations[i]}`]);
        const at=new Date();
        await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,payload,version,created_at,updated_at)
          VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,$5,$5)`,[tenants[i],orders[i],installations[i],JSON.stringify({id:orders[i],createdAt:at.toISOString(),type:'DELIVERY',status:'FINALIZADA'}),at]);
        await client.query(`INSERT INTO ${schema}.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,related_entity_type,related_record_id,payload,version,created_at,updated_at)
          VALUES($1,$2,'Delivery','restaurante',$3,'Order',$4,$5::jsonb,1,$6,$6)`,[tenants[i],deliveries[i],installations[i],orders[i],JSON.stringify({id:deliveries[i],orderId:orders[i],status:'DELIVERED'}),at]);
        await client.query(`INSERT INTO ${schema}.delivery_geo_snapshots(company_id,delivery_id,latitude,longitude,provenance,accuracy_m,resolved_at,algorithm_version,created_by,updated_by)
          VALUES($1,$2,-23.55,-46.63,'manual',12,now(),'destination-v1',$3,$3)`,[tenants[i],deliveries[i],user]);
      }
      await client.query('SELECT set_config($1,$2,true)',['app.tenant_id',tenants[1]]);
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.delivery_geo_snapshots`)).rows[0].count,1,'FORCE RLS limits snapshots to active tenant');
      await client.query('SAVEPOINT cross_tenant_geo');
      await assert.rejects(client.query(`INSERT INTO ${schema}.delivery_geo_snapshots(company_id,delivery_id,latitude,longitude,provenance,resolved_at,algorithm_version,created_by,updated_by)
        VALUES($1,$2,0,0,'manual',now(),'destination-v1',$3,$3)`,[tenants[0],id(),user]));
      await client.query('ROLLBACK TO SAVEPOINT cross_tenant_geo'); await client.query('RELEASE SAVEPOINT cross_tenant_geo');
      await client.query('SAVEPOINT invalid_coordinates');
      await assert.rejects(client.query(`INSERT INTO ${schema}.delivery_geo_snapshots(company_id,delivery_id,latitude,longitude,provenance,resolved_at,algorithm_version,created_by,updated_by)
        VALUES($1,$2,91,0,'manual',now(),'destination-v1',$3,$3)`,[tenants[1],id(),user]));
      await client.query('ROLLBACK TO SAVEPOINT invalid_coordinates'); await client.query('RELEASE SAVEPOINT invalid_coordinates');
      await client.query('SELECT set_config($1,$2,true)',['app.tenant_id',tenants[0]]);
      const tenantClient={query:(sql,values)=>client.query(sql.replace(/\brotamoto\b/gu,schema),values)};
      const territorial=createTerritorialAnalyticsService({clock:()=>new Date()});
      const heatmap=await territorial.heatmap(tenantClient,{company_id:tenants[0]},{period:'7',metric:'volume'});
      assert.equal(heatmap.totalEligible,1); assert.equal(heatmap.withLocation,1);
      assert.equal(heatmap.cells.length,0,'a one-delivery cell remains suppressed');
      const metadata=await territorial.destinationStatus(tenantClient,{company_id:tenants[0]},deliveries[0]);
      assert.deepEqual({exists:metadata.exists,version:metadata.version,provenance:metadata.provenance},{exists:true,version:1,provenance:'manual'});
      assert.equal(Object.hasOwn(metadata,'latitude'),false,'single-snapshot status never returns coordinates');
      const updated=await territorial.setDestination(tenantClient,{company_id:tenants[0],user_id:user},deliveries[0],
        {latitude:-23.56,longitude:-46.64,accuracyM:20,confirmDestination:true,expectedVersion:1});
      assert.equal(updated.version,2);
      await assert.rejects(territorial.setDestination(tenantClient,{company_id:tenants[0],user_id:user},deliveries[0],
        {latitude:-23.57,longitude:-46.65,confirmDestination:true,expectedVersion:1}),{code:'REVISION_CONFLICT'});
      await client.query('ROLLBACK');
    } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    assert.equal((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount,0,'transactional E2E schema is removed');
    console.log('Territorial PostgreSQL migration/RLS checks: OK (rotamoto_e2e transaction rolled back)');
  } finally { await client.end(); }
}
main().catch(error=>{ process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode=1; });
