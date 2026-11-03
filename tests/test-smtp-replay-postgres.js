'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClient, createPool } = require('../backend/postgres/connection');

async function main() {
  if (!process.env.MIGRATOR_DATABASE_URL || !process.env.DATABASE_URL || !process.env.E2E_RUNTIME_DATABASE_URL)
    throw new Error('Set exact rotamoto and rotamoto_e2e runtime/migrator URLs through pgpass.');
  const migrator = createClient({ connectionString: process.env.MIGRATOR_DATABASE_URL });
  const official = createPool({ connectionString: process.env.DATABASE_URL, max: 10 });
  const e2e = createPool({ connectionString: process.env.E2E_RUNTIME_DATABASE_URL,
    options: '-c role=rotamoto_app', max: 2 });
  const capability = crypto.randomBytes(32).toString('base64url');
  const digest = crypto.createHash('sha256').update(capability).digest();
  let inserted = false;
  try {
    await migrator.connect();
    const target = await migrator.query(`SELECT current_database() AS db,current_user AS role,
      (SELECT checksum_sha256 FROM rotamoto.schema_migrations WHERE migration_id='0069_bootstrap_smtp_test_replay') AS checksum`);
    assert.deepEqual({ db: target.rows[0].db, role: target.rows[0].role }, { db: 'rotamoto', role: 'rotamoto_migrator' });
    assert.match(target.rows[0].checksum, /^[a-f0-9]{64}$/u);
    const issued = await migrator.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
      VALUES($1,'rotamoto',now()+interval '5 minutes')`, [digest]);
    assert.equal(issued.rowCount, 1); inserted = true;
    const accepted = await Promise.all(Array.from({ length: 8 }, () => official.query(
      'SELECT rotamoto.platform_admin_record_bootstrap_smtp_test($1,$2::uuid) AS accepted', [digest, crypto.randomUUID()])));
    assert.equal(accepted.filter(result => result.rows[0].accepted).length, 5, 'concurrent requests respect the persistent 5/15-minute limit');
    const replayId = crypto.randomUUID();
    const replayFirst = await official.query('SELECT rotamoto.platform_admin_record_bootstrap_smtp_test($1,$2::uuid) AS accepted', [digest, replayId]);
    assert.equal(replayFirst.rows[0].accepted, false, 'limit remains closed after five accepted requests');
    const admin = await official.query('SELECT rotamoto.platform_admin_record_smtp_admin_test($1::uuid,$2::uuid) AS accepted',
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', crypto.randomUUID()]);
    assert.equal(admin.rows[0].accepted, false, 'a non-founder UUID cannot record an admin SMTP attempt');
    const isolated = await e2e.query('SELECT session_user,current_user,current_database(),rotamoto.platform_admin_record_bootstrap_smtp_test($1,$2::uuid) AS accepted',
      [digest, crypto.randomUUID()]);
    assert.deepEqual({ session: isolated.rows[0].session_user, role: isolated.rows[0].current_user, db: isolated.rows[0].current_database, accepted: isolated.rows[0].accepted },
      { session: 'rotamoto_e2e_app', role: 'rotamoto_app', db: 'rotamoto_e2e', accepted: false }, 'E2E role/database cannot use official SMTP test authority');
    const privileges = await migrator.query(`SELECT has_table_privilege('rotamoto_app','rotamoto.bootstrap_smtp_test_attempts','SELECT') AS direct_read,
      (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='rotamoto.bootstrap_smtp_test_attempts'::regclass) AS forced_rls`);
    assert.deepEqual(privileges.rows[0], { direct_read: false, forced_rls: true });
    console.log('SMTP replay PostgreSQL: concurrency limit, exact roles, cross-database isolation, direct-table denial and FORCE RLS: PASS');
  } finally {
    await official.end().catch(() => {}); await e2e.end().catch(() => {});
    if (inserted) {
      await migrator.query('DELETE FROM rotamoto.bootstrap_smtp_test_attempts WHERE authorization_digest=$1', [digest]).catch(() => {});
      await migrator.query('DELETE FROM rotamoto.bootstrap_authorizations WHERE token_digest=$1', [digest]).catch(() => {});
    }
    digest.fill(0); await migrator.end().catch(() => {});
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
