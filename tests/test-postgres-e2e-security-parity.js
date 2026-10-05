'use strict';

const assert = require('node:assert/strict');
const { Client } = require('pg');
const { getMigrations } = require('../backend/postgres/migrate');

const ROLE_FLAGS = `SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
  FROM pg_roles WHERE rolname IN ('rotamoto_app','rotamoto_migrator') ORDER BY rolname`;

function validateTarget(value, database) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Auditoria E2E exige NODE_ENV=test.');
  if (!value) throw new Error(`URL de auditoria ${database} ausente.`);
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error(`URL de auditoria ${database} inválida.`); }
  const role = database === 'rotamoto' || database === 'rotamoto_e2e' ? 'rotamoto_migrator' : '';
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== role || parsed.password ||
      parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' || parsed.pathname !== `/${database}` ||
      parsed.search || parsed.hash) throw new Error(`Alvo de auditoria ${database} rejeitado.`);
  return value;
}

async function snapshot(client, expectedDatabase) {
  await client.query('BEGIN READ ONLY');
  try {
    const identity = (await client.query(`SELECT current_database() AS database,current_user AS role,
      inet_server_addr()::text AS server_address`)).rows[0];
    assert.deepEqual(identity, { database: expectedDatabase, role: 'rotamoto_migrator', server_address: '127.0.0.1/32' });
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
    const applied = (await client.query('SELECT migration_id,checksum_sha256 FROM rotamoto.schema_migrations ORDER BY migration_id')).rows;
    return { database, roles, membership, schema, relations, columns, functions, policies, defaultPublic, ledger, applied };
  } finally { await client.query('ROLLBACK'); }
}

async function main() {
  const officialUrl = validateTarget(process.env.MIGRATOR_DATABASE_URL, 'rotamoto');
  const e2eUrl = validateTarget(process.env.E2E_MIGRATOR_DATABASE_URL, 'rotamoto_e2e');
  const results = [];
  for (const [url, database] of [[officialUrl,'rotamoto'],[e2eUrl,'rotamoto_e2e']]) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    try { await client.connect(); results.push(await snapshot(client,database)); }
    finally { await client.end().catch(()=>{}); }
  }
  const [official,e2e] = results;
  assert.deepEqual(e2e.roles,official.roles,'role attributes differ');
  assert.deepEqual(e2e.membership,official.membership,'runtime role membership differs');
  assert.deepEqual(e2e.schema,official.schema,'schema grants/ownership differ');
  assert.deepEqual(e2e.relations,official.relations,'table/sequence privileges, ownership or RLS flags differ');
  assert.deepEqual(e2e.columns,official.columns,'column privileges differ');
  assert.deepEqual(e2e.functions,official.functions,'function privileges/ownership differ');
  assert.deepEqual(e2e.policies,official.policies,'RLS policies differ');
  assert.deepEqual(e2e.defaultPublic,official.defaultPublic,'PUBLIC default ACL differs');
  assert.deepEqual(e2e.ledger,official.ledger,'migration ledger ownership/access differs');
  assert.deepEqual(e2e.applied.map(row=>({...row,checksum_sha256:row.checksum_sha256.trim()})),
    getMigrations().map(({id,checksum})=>({migration_id:id,checksum_sha256:checksum})),
    'E2E ledger does not match the local additive migration set');
  assert.equal(e2e.applied.length,getMigrations().length,'E2E ledger must contain exactly the local migrations');
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
  console.log(`E2E security parity: PASS (effective runtime ACLs, PUBLIC ACLs, ownership, RLS/FORCE, policies, ledger; ${getMigrations().length} checksums)`);
}

if (require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={validateTarget,snapshot,main};
