'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const sql=fs.readFileSync(require.resolve('../backend/postgres/admin/provider-runtime-role-bootstrap.sql'),'utf8');
assert.match(sql,/rolname=current_user AND rolsuper/u);
assert.match(sql,/CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u);
assert.match(sql,/rotamoto_provider_resolver/u);
assert.match(sql,/rotamoto_provider_worker/u);
assert.match(sql,/pg_auth_members/u);
assert.doesNotMatch(sql,/PASSWORD\s+['"]/iu,'bootstrap must never contain credentials');
assert.doesNotMatch(sql,/rotamoto_migrator[^;]*(?:CREATEROLE|BYPASSRLS)/iu);
process.stdout.write('Provider runtime role bootstrap: idempotent least privilege and no embedded credentials PASS\n');
