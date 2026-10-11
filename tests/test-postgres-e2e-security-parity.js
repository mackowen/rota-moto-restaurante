'use strict';

const assert = require('node:assert/strict');
const { createClient } = require('../backend/postgres/connection');
const { getMigrations } = require('../backend/postgres/migrate');

const ROLE_FLAGS = `SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
  FROM pg_roles WHERE rolname IN ('rotamoto_app','rotamoto_migrator') ORDER BY rolname`;

function validateE2eMigratorTarget(value) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Leitura do ledger E2E exige NODE_ENV=test.');
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('URL do ledger E2E inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== 'rotamoto_migrator' ||
      parsed.password || parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' || parsed.pathname !== '/rotamoto_e2e' ||
      parsed.search || parsed.hash) throw new Error('Ledger E2E aceita somente rotamoto_migrator em loopback sem senha.');
  return value;
}

function validateTarget(value, database) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Auditoria E2E exige NODE_ENV=test.');
  if (!value) throw new Error(`URL de auditoria ${database} ausente.`);
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error(`URL de auditoria ${database} inválida.`); }
  const role = database === 'rotamoto' ? 'rotamoto_auditor' : database === 'rotamoto_e2e' ? 'rotamoto_app' : '';
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== role || parsed.password ||
      parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' || parsed.pathname !== `/${database}` ||
      parsed.search || parsed.hash) throw new Error(`Alvo de auditoria ${database} rejeitado.`);
  return value;
}

async function snapshot(client, expectedDatabase, expectedRole) {
  await client.query('BEGIN READ ONLY');
  try {
    const identity = (await client.query(`SELECT current_database() AS database,current_user AS role,
      inet_server_addr()::text AS server_address`)).rows[0];
    assert.deepEqual(identity, { database: expectedDatabase, role: expectedRole, server_address: '127.0.0.1/32' });
    const database = (await client.query(`SELECT pg_get_userbyid(d.datdba) AS owner,
      has_database_privilege('rotamoto_app',d.oid,'CONNECT') AS app_connect,
      has_database_privilege('rotamoto_app',d.oid,'CREATE') AS app_create,
      has_database_privilege('rotamoto_app',d.oid,'TEMPORARY') AS app_temp,
      has_database_privilege('rotamoto_migrator',d.oid,'CONNECT') AS migrator_connect,
      has_database_privilege('rotamoto_migrator',d.oid,'CREATE') AS migrator_create,
      has_database_privilege('rotamoto_migrator',d.oid,'TEMPORARY') AS migrator_temp,
      (SELECT array_agg(privilege_type ORDER BY privilege_type) FROM aclexplode(
        COALESCE(d.datacl,acldefault('d'::\"char\",d.datdba))) WHERE grantee=0) AS public_grants
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    const roles = (await client.query(ROLE_FLAGS)).rows;
    const membership = (await client.query(`SELECT pg_has_role('rotamoto_app','rotamoto_migrator','MEMBER') AS app_member_of_migrator,
      pg_has_role('rotamoto_app','rotamoto_migrator','USAGE') AS app_can_set_migrator`)).rows[0];
    const schema = (await client.query(`SELECT pg_get_userbyid(n.nspowner) AS owner,
      has_schema_privilege('rotamoto_app',n.oid,'USAGE') AS app_usage,
      has_schema_privilege('rotamoto_app',n.oid,'CREATE') AS app_create,
      (SELECT array_agg(privilege_type ORDER BY privilege_type) FROM aclexplode(
        COALESCE(n.nspacl,acldefault('n'::\"char\",n.nspowner))) WHERE grantee=0) AS public_grants
      FROM pg_namespace n WHERE n.nspname='rotamoto'`)).rows[0];
    const relations = (await client.query(`SELECT c.relkind,c.relname,pg_get_userbyid(c.relowner) AS owner,
      c.relrowsecurity AS rls,c.relforcerowsecurity AS force_rls,
      CASE WHEN c.relkind='S' THEN ARRAY[
        has_sequence_privilege('rotamoto_app',c.oid,'USAGE'),has_sequence_privilege('rotamoto_app',c.oid,'SELECT'),has_sequence_privilege('rotamoto_app',c.oid,'UPDATE')]
      ELSE ARRAY[has_table_privilege('rotamoto_app',c.oid,'SELECT'),has_table_privilege('rotamoto_app',c.oid,'INSERT'),
        has_table_privilege('rotamoto_app',c.oid,'UPDATE'),has_table_privilege('rotamoto_app',c.oid,'DELETE'),
        has_table_privilege('rotamoto_app',c.oid,'TRUNCATE'),has_table_privilege('rotamoto_app',c.oid,'REFERENCES'),
        has_table_privilege('rotamoto_app',c.oid,'TRIGGER')] END AS app_privileges,
      (SELECT array_agg(privilege_type ORDER BY privilege_type) FROM aclexplode(COALESCE(c.relacl,
        acldefault(CASE WHEN c.relkind='S' THEN 'S' ELSE 'r' END::\"char\",c.relowner))) WHERE grantee=0) AS public_grants
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relkind,c.relname`)).rows;
    const columns = (await client.query(`SELECT c.relname AS relation,a.attname AS column,
      ARRAY[has_column_privilege('rotamoto_app',c.oid,a.attnum,'SELECT'),
        has_column_privilege('rotamoto_app',c.oid,a.attnum,'INSERT'),
        has_column_privilege('rotamoto_app',c.oid,a.attnum,'UPDATE'),
        has_column_privilege('rotamoto_app',c.oid,a.attnum,'REFERENCES')] AS app_privileges,
      (SELECT array_agg(privilege_type ORDER BY privilege_type) FROM aclexplode(a.attacl) WHERE grantee=0) AS public_grants
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`)).rows;
    const functions = (await client.query(`SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS signature,
      pg_get_userbyid(p.proowner) AS owner,has_function_privilege('rotamoto_app',p.oid,'EXECUTE') AS app_execute,
      p.prosecdef AS security_definer,
      (SELECT array_agg(privilege_type ORDER BY privilege_type) FROM aclexplode(COALESCE(p.proacl,
        acldefault('f'::\"char\",p.proowner))) WHERE grantee=0) AS public_grants
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='rotamoto'
      ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`)).rows;
    const policies = (await client.query(`SELECT schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
      FROM pg_policies WHERE schemaname='rotamoto' ORDER BY tablename,policyname`)).rows;
    const constraints = (await client.query(`SELECT rel.relname AS relation,con.conname AS name,con.contype AS type,
      con.convalidated AS validated,pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
      JOIN pg_namespace n ON n.oid=rel.relnamespace
      WHERE n.nspname='rotamoto' ORDER BY rel.relname,con.conname`)).rows;
    const indexes = (await client.query(`SELECT tbl.relname AS relation,idx.relname AS name,ix.indisunique AS is_unique,
      ix.indisprimary AS is_primary,ix.indisvalid AS is_valid,pg_get_indexdef(ix.indexrelid) AS definition
      FROM pg_index ix JOIN pg_class tbl ON tbl.oid=ix.indrelid JOIN pg_class idx ON idx.oid=ix.indexrelid
      JOIN pg_namespace n ON n.oid=tbl.relnamespace WHERE n.nspname='rotamoto'
      ORDER BY tbl.relname,idx.relname`)).rows;
    const defaultPublic = (await client.query(`SELECT COALESCE(n.nspname,'<global>') AS schema,d.defaclobjtype,
      pg_get_userbyid(d.defaclrole) AS grantor,a.privilege_type,a.is_grantable
      FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE a.grantee=0 ORDER BY 1,2,4`)).rows;
    const ledger = (await client.query(`SELECT pg_get_userbyid(c.relowner) AS owner,
      has_table_privilege('rotamoto_app',c.oid,'SELECT') AS app_select,
      has_table_privilege('rotamoto_app',c.oid,'INSERT') AS app_insert,
      has_table_privilege('rotamoto_app',c.oid,'UPDATE') AS app_update,
      has_table_privilege('rotamoto_app',c.oid,'DELETE') AS app_delete
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'`)).rows[0];
    const applied = expectedRole === 'rotamoto_auditor' &&
      (await client.query("SELECT has_schema_privilege(current_user,'rotamoto','USAGE') AS allowed")).rows[0].allowed
      ? (await client.query('SELECT migration_id,checksum_sha256,applied_at FROM rotamoto.schema_migrations ORDER BY migration_id')).rows
      : null;
    const auditor = expectedRole === 'rotamoto_auditor' ? (await client.query(`SELECT
      r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,r.rolinherit,
      EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole=r.oid
        AND s.setdatabase=0 AND 'default_transaction_read_only=on'=ANY(s.setconfig)) AS default_read_only_global,
      EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole=r.oid
        AND s.setdatabase=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
        AND 'default_transaction_read_only=on'=ANY(s.setconfig)) AS default_read_only_database,
      has_database_privilege(current_user,current_database(),'CONNECT') AS can_connect,
      has_database_privilege(current_user,current_database(),'CREATE') AS can_create_database_objects,
      has_database_privilege(current_user,current_database(),'TEMPORARY') AS can_create_temp,
      has_schema_privilege(current_user,'rotamoto','USAGE') AS schema_usage,
      has_schema_privilege(current_user,'rotamoto','CREATE') AS schema_create,
      COALESCE((SELECT has_any_column_privilege(current_user,c.oid,'SELECT') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'),false) AS ledger_any_select,
      COALESCE((SELECT has_column_privilege(current_user,c.oid,a.attnum,'SELECT') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='rotamoto' AND c.relname='schema_migrations' AND a.attname='migration_id'),false) AS ledger_migration_id,
      COALESCE((SELECT has_column_privilege(current_user,c.oid,a.attnum,'SELECT') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='rotamoto' AND c.relname='schema_migrations' AND a.attname='checksum_sha256'),false) AS ledger_checksum,
      COALESCE((SELECT has_column_privilege(current_user,c.oid,a.attnum,'SELECT') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname='rotamoto' AND c.relname='schema_migrations' AND a.attname='applied_at'),false) AS ledger_applied_at,
      COALESCE((SELECT has_table_privilege(current_user,c.oid,'INSERT') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'),false) AS ledger_insert,
      COALESCE((SELECT has_table_privilege(current_user,c.oid,'UPDATE') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'),false) AS ledger_update,
      COALESCE((SELECT has_table_privilege(current_user,c.oid,'DELETE') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'),false) AS ledger_delete,
      COALESCE((SELECT has_table_privilege(current_user,c.oid,'TRUNCATE') FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='rotamoto' AND c.relname='schema_migrations'),false) AS ledger_truncate,
      NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AS no_role_memberships,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='rotamoto' AND c.relkind IN ('r','p','v','m','f')
          AND c.relname<>'schema_migrations' AND (has_table_privilege(current_user,c.oid,'SELECT')
            OR has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE')
            OR has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE')))
        AS no_operational_table_privileges,
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='rotamoto' AND c.relkind='S' AND
          (has_sequence_privilege(current_user,c.oid,'USAGE') OR has_sequence_privilege(current_user,c.oid,'SELECT')
            OR has_sequence_privilege(current_user,c.oid,'UPDATE'))) AS no_sequence_privileges,
      NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='rotamoto' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE'))
        AS no_security_definer_execution
      FROM pg_roles r WHERE r.rolname=current_user`)).rows[0] : null;
    if (expectedRole === 'rotamoto_auditor') {
      const readOnly = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
      assert.equal(readOnly, 'on', 'auditor connection is inside a read-only transaction');
    }
    return { database, roles, membership, schema, relations, columns, functions, policies, constraints, indexes,
      defaultPublic, ledger, applied, auditor };
  } finally { await client.query('ROLLBACK'); }
}

async function main() {
  const officialUrl = validateTarget(process.env.ROTAMOTO_AUDIT_DATABASE_URL, 'rotamoto');
  const e2eUrl = validateTarget(process.env.E2E_RUNTIME_DATABASE_URL, 'rotamoto_e2e');
  const results = [];
  for (const [url, database] of [[officialUrl,'rotamoto'],[e2eUrl,'rotamoto_e2e']]) {
    const client = createClient({ connectionString: url, connectionTimeoutMillis: 5000 });
    const expectedRole = database === 'rotamoto' ? 'rotamoto_auditor' : 'rotamoto_app';
    try { await client.connect(); results.push(await snapshot(client,database,expectedRole)); }
    finally { await client.end().catch(()=>{}); }
  }
  const [official,e2e] = results;
  const e2eMigratorUrl = validateE2eMigratorTarget(process.env.E2E_MIGRATOR_DATABASE_URL);
  const e2eMigrator = createClient({ connectionString: e2eMigratorUrl, connectionTimeoutMillis: 5000 });
  let e2eApplied;
  try {
    await e2eMigrator.connect();
    await e2eMigrator.query('BEGIN READ ONLY');
    try {
      const identity = (await e2eMigrator.query('SELECT current_database() AS database,current_user AS role')).rows[0];
      assert.deepEqual(identity, { database: 'rotamoto_e2e', role: 'rotamoto_migrator' });
      assert.equal((await e2eMigrator.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
      e2eApplied = (await e2eMigrator.query('SELECT migration_id,checksum_sha256 FROM rotamoto.schema_migrations ORDER BY migration_id')).rows;
    } finally { await e2eMigrator.query('ROLLBACK'); }
  } finally { await e2eMigrator.end().catch(()=>{}); }
  assert(official.auditor.rolcanlogin && !official.auditor.rolsuper && !official.auditor.rolcreatedb &&
    !official.auditor.rolcreaterole && !official.auditor.rolreplication && !official.auditor.rolbypassrls &&
    official.auditor.can_connect && !official.auditor.can_create_database_objects &&
    !official.auditor.can_create_temp && !official.auditor.schema_create && official.auditor.no_role_memberships &&
    official.auditor.no_operational_table_privileges && official.auditor.no_sequence_privileges &&
    official.auditor.no_security_definer_execution, 'official audit login is non-privileged and has no operational data access');
  assert(official.auditor.default_read_only_global || official.auditor.default_read_only_database,
    'official audit login must default to read-only at role or database scope');
  if (official.auditor.schema_usage) {
    assert(official.auditor.ledger_any_select && official.auditor.ledger_migration_id && official.auditor.ledger_checksum &&
      official.auditor.ledger_applied_at && !official.auditor.ledger_insert && !official.auditor.ledger_update &&
      !official.auditor.ledger_delete && !official.auditor.ledger_truncate,
    'official auditor ledger access must be limited to migration metadata columns');
  } else {
    assert.equal(official.auditor.ledger_any_select, false, 'without schema USAGE, the auditor cannot read migration metadata');
    assert.equal(official.applied, null, 'migration history comparison is intentionally unavailable without schema USAGE');
  }
  const migrations=getMigrations(),custodyMigration=migrations.find(item=>item.id==='0041_delivery_custody_return');
  assert(custodyMigration,'known additive custody migration is present in the local migration set');
  assert.deepEqual(e2e.roles,official.roles,'role attributes differ');
  assert.deepEqual(e2e.membership,official.membership,'runtime role membership differs');
  assert.deepEqual(e2e.schema,official.schema,'schema grants/ownership differ');
  assert.deepEqual(e2e.relations.filter(row=>row.relname!=='delivery_custody_operations'),official.relations,
    'base table/sequence privileges, ownership or RLS flags differ outside additive migration 0041');
  assert.deepEqual(e2e.columns.filter(row=>row.relation!=='delivery_custody_operations'),official.columns,
    'base column privileges differ outside additive migration 0041');
  assert.deepEqual(e2e.functions,official.functions,'function privileges/ownership differ');
  assert.deepEqual(e2e.policies.filter(row=>row.tablename!=='delivery_custody_operations'),official.policies,
    'base RLS policies differ outside additive migration 0041');
  const baseConstraints = rows => rows.filter(row => row.relation !== 'delivery_custody_operations' &&
    !['domain_records_check1','domain_records_related_entity_type_check'].includes(row.name));
  assert.deepEqual(baseConstraints(e2e.constraints),baseConstraints(official.constraints),
    'base constraints differ outside the documented 0041 custody/RETURN delta');
  const known0041Indexes = new Set(['delivery_custody_operations_pkey','domain_one_return_delivery_per_original_uq']);
  assert.deepEqual(e2e.indexes.filter(row=>!known0041Indexes.has(row.name)),official.indexes,
    'base indexes differ outside the documented 0041 custody/RETURN delta');
  assert.deepEqual(e2e.defaultPublic,official.defaultPublic,'PUBLIC default ACL differs');
  assert.deepEqual(e2e.ledger,official.ledger,'migration ledger ownership/access differs');
  const normalizedLedger=rows=>rows.map(row=>({migration_id:row.migration_id,checksum_sha256:row.checksum_sha256.trim()}));
  const localLedger=migrations.map(({id,checksum})=>({migration_id:id,checksum_sha256:checksum}));
  if (official.applied) assert.deepEqual(normalizedLedger(official.applied),localLedger.slice(0,localLedger.findIndex(row=>row.migration_id===custodyMigration.id)),
    'official ledger must remain at the migration immediately preceding additive custody migration 0041');
  assert.deepEqual(normalizedLedger(e2eApplied),localLedger,
    'E2E migrator read-only ledger must match every local migration ID and checksum');
  const custodyTable=e2e.relations.find(row=>row.relname==='delivery_custody_operations');
  assert(custodyTable,'E2E additive migration 0041 creates its custody operation ledger');
  assert.equal(custodyTable.owner,'rotamoto_migrator');assert.equal(custodyTable.rls,true);assert.equal(custodyTable.force_rls,true);
  assert.deepEqual(custodyTable.app_privileges,[true,true,false,false,false,false,false],
    'runtime custody ledger access is SELECT/INSERT only');
  assert.deepEqual(e2e.policies.filter(row=>row.tablename==='delivery_custody_operations').map(row=>row.policyname),['tenant_isolation']);
  const custodyPolicy=e2e.policies.find(row=>row.tablename==='delivery_custody_operations');
  assert(custodyPolicy.qual?.includes('current_tenant_id')&&custodyPolicy.with_check?.includes('current_tenant_id'),
    'additive custody operation table remains tenant isolated');
  assert.equal(e2e.database.app_connect,official.database.app_connect);
  assert.equal(e2e.database.app_create,official.database.app_create);
  assert.equal(e2e.database.app_temp,official.database.app_temp);
  assert.equal(e2e.database.migrator_connect,true);
  assert.equal(e2e.database.migrator_create,true);
  assert.equal(e2e.database.migrator_temp,true);
  assert.deepEqual(e2e.database.public_grants,official.database.public_grants,'PUBLIC database grants differ');
  assert.equal(e2e.database.owner,'rotamoto_migrator','E2E database owner is not the dedicated migrator');
  assert.notEqual(e2e.database.owner,'rotamoto_app','runtime role must not own E2E database');
  assert.equal(e2e.membership.app_member_of_migrator,false,'runtime role can inherit migration role');
  assert.equal(e2e.membership.app_can_set_migrator,false,'runtime role can SET ROLE to migration role');
  assert(official.roles.every(role=>!role.rolsuper&&!role.rolcreatedb&&!role.rolcreaterole&&!role.rolreplication&&!role.rolbypassrls),
    'a protected role has an elevated attribute');
  for (const snapshot of [official,e2e]) {
    const intent = snapshot.relations.find(row => row.relname === 'proof_media_upload_intents');
    assert(intent, 'staged media intent table exists');
    assert.equal(intent.owner, 'rotamoto_migrator');
    assert.equal(intent.rls, true); assert.equal(intent.force_rls, true);
    assert.deepEqual(intent.app_privileges, [true,true,true,true,false,false,false], 'runtime media intent grant is least privilege');
    assert(snapshot.policies.some(policy => policy.tablename === 'proof_media_upload_intents' && policy.policyname === 'tenant_isolation' &&
      policy.qual.includes('current_tenant_id') && policy.with_check.includes('current_tenant_id')), 'upload intents have tenant isolation policy');
  }
  console.log(`PostgreSQL metadata parity: PASS for common schema/security metadata; documented production delta remains: official=${official.applied?.at(-1)?.migration_id || 'ledger unavailable'}, E2E=${e2eApplied.at(-1)?.migration_id}, local checksums and E2E 0041 delta verified. Official transaction was read-only.`);
}

if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={validateTarget,validateE2eMigratorTarget,snapshot,main};
