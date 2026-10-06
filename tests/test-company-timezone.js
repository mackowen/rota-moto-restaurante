'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createAdminHttpHandler } = require('../backend/admin/http');
const { createAdminService } = require('../backend/admin/service');

const migration = fs.readFileSync(path.join(__dirname, '../backend/postgres/migrations/0016_company_timezone.up.sql'), 'utf8');
assert.match(migration, /ADD COLUMN time_zone text/);
assert.match(migration, /time_zone IS NULL/);
assert.match(migration, /GRANT SELECT \(time_zone\).*rotamoto_app/s);
assert.match(migration, /GRANT UPDATE \(time_zone, updated_at\).*rotamoto_app/s);
assert.doesNotMatch(migration, /GRANT .* ON ALL TABLES|BYPASSRLS|FORCE ROW LEVEL SECURITY/);

async function call(handler, timeZone, { csrf = true } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify({ timeZone }))]);
  req.method = 'PUT'; req.url = '/api/admin/company';
  req.headers = { 'content-type': 'application/json', cookie: '__Host-rotamoto_session=' + 's'.repeat(43), ...(csrf ? { 'x-csrf-token': 'c'.repeat(43) } : {}) };
  req.socket = { remoteAddress: '127.0.0.1', encrypted: true };
  let status; let payload;
  const res = { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } };
  await handler(req, res);
  return { status, payload };
}

async function main() {
  const calls = [];
  const repository = { updateCompanyTimeZone: async (_client, principal, value) => { calls.push({ company: principal.company_id, value }); return { timeZone: value, updatedAt: '2026-10-06T00:00:00Z' }; } };
  const adminService = createAdminService({ repository });
  const identityService = {
    async withAuthenticatedTenant(token, operation, permission) {
      assert.equal(token, 's'.repeat(43));
      assert.equal(permission, 'company.manage', 'write gate stays on the privileged Company permission (which requires MFA in identity service)');
      return operation({ csrfValid: true }, { company_id: 'tenant-a', user_id: 'user-a' });
    },
    async verifyCsrf(client, _principal, token) { assert.equal(token, 'c'.repeat(43)); return client.csrfValid; }
  };
  const handler = createAdminHttpHandler({ identityService, adminService, allowedOrigin: 'https://restaurant.test' });
  const valid = await call(handler, 'America/Manaus');
  assert.equal(valid.status, 200);
  assert.equal(valid.payload.timeZone, 'America/Manaus');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].company, 'tenant-a');
  assert.equal(calls[0].value, 'America/Manaus');
  const fixedOffset = await call(handler, '+03:00');
  assert.equal(fixedOffset.status, 400);
  const bogus = await call(handler, 'Not/AZone');
  assert.equal(bogus.status, 400);
  assert.equal(calls.length, 1, 'invalid zones never reach the repository');
  const noCsrf = await call(handler, 'UTC', { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(calls.length, 1, 'CSRF failure never writes');
  const cleared = await call(handler, null);
  assert.equal(cleared.status, 200);
  assert.equal(calls.at(-1).value, null, 'legacy unconfigured Company remains explicitly nullable');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
