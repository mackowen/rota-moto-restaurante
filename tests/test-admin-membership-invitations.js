'use strict';

const assert = require('node:assert/strict');
const { createAdminRepository } = require('../backend/admin/repository');

const companyId = '00000000-0000-4000-8000-000000000001';
const expiresAt = new Date('2026-11-02T12:00:00.000Z');
let statement = '';
let parameters;
const rows = [
  { id: 'membership-invited', user_id: 'user-invited', driver_id: null, email: 'invite@example.invalid',
    email_verified: false, disabled_at: null, status: 'invited', role_id: 'role-operator', role_key: 'operator',
    display_name: 'Operador', created_at: new Date('2026-11-01T12:00:00.000Z'), activated_at: null,
    created_at_cursor: '2026-11-01T12:00:00.000000Z', permissions: ['orders.read'], invitation_expires_at: expiresAt },
  { id: 'membership-active', user_id: 'user-active', driver_id: null, email: 'active@example.invalid',
    email_verified: true, disabled_at: null, status: 'active', role_id: 'role-operator', role_key: 'operator',
    display_name: 'Operador', created_at: new Date('2026-10-31T12:00:00.000Z'), activated_at: new Date('2026-10-31T12:01:00.000Z'),
    created_at_cursor: '2026-10-31T12:00:00.000000Z', permissions: ['orders.read'], invitation_expires_at: null }
];
const client = { async query(sql, values) {
  statement = sql;
  parameters = values;
  return { rows, rowCount: rows.length };
} };

async function main() {
  const result = await createAdminRepository().memberships(client, companyId, { limit: 2, cursor: null });
  assert.match(statement, /LEFT JOIN LATERAL[\s\S]*rotamoto\.identity_tokens/u);
  assert.match(statement, /it\.company_id=m\.company_id AND it\.user_id=m\.user_id/u);
  assert.match(statement, /it\.purpose='membership_invitation' AND it\.consumed_at IS NULL/u);
  assert.match(statement, /invitation\.invitation_expires_at/u,
    'the membership DTO query returns the pending invitation expiration timestamp');
  assert.deepEqual(parameters, [companyId, 3]);
  assert.equal(result.members[0].invitationExpiresAt, expiresAt);
  assert.equal(result.members[1].invitationExpiresAt, null);
  assert.equal(result.members[1].status, 'active');
  const revocationQueries = [];
  const revocationClient = { async query(sql, values) {
    revocationQueries.push({ sql: String(sql), values });
    if (/SELECT user_id::text,status FROM rotamoto\.memberships/u.test(sql)) {
      return { rowCount: 1, rows: [{ user_id: 'user-invited', status: 'invited' }] };
    }
    if (/SELECT m\.id::text,m\.user_id::text,m\.role_id::text,m\.status,r\.role_key/u.test(sql)) {
      return { rowCount: 1, rows: [{ id: 'membership-invited', user_id: 'user-invited', role_id: 'role-operator',
        status: 'invited', role_key: 'operator', disabled_at: null, email_verified_at: null, password_phc: null,
        mfa_required: null }] };
    }
    if (/SELECT permission_key FROM rotamoto\.role_permissions/u.test(sql)) {
      return { rowCount: 1, rows: [{ permission_key: 'orders.read' }] };
    }
    return { rowCount: 1, rows: [] };
  } };
  const changed = await createAdminRepository().updateMembership(revocationClient,
    { company_id: companyId, user_id: 'qa-admin', role_id: 'role-admin' }, 'membership-invited', { status: 'revoked' });
  assert.equal(changed.status, 'revoked');
  const consumeInvite = revocationQueries.find(item => /UPDATE rotamoto\.identity_tokens SET consumed_at=coalesce\(consumed_at,now\(\)\)/u.test(item.sql));
  assert.deepEqual(consumeInvite?.values, [companyId, 'user-invited'],
    'revoking a pending membership consumes outstanding invite tokens in the same transaction');
  const consumeIndex = revocationQueries.indexOf(consumeInvite);
  const membershipLockIndex = revocationQueries.findIndex(item => /SELECT m\.id::text,m\.user_id::text,m\.role_id::text,m\.status,r\.role_key[\s\S]*FOR UPDATE OF m/u.test(item.sql));
  assert(consumeIndex >= 0 && membershipLockIndex > consumeIndex,
    'revocation locks/consumes invitation token before locking membership, matching acceptance order');
  process.stdout.write('Admin invitation expiry DTO tenant scope and active-token filter: PASS\n');
  process.stdout.write('Admin invitation revocation consumes pending tokens: PASS\n');
}

main().catch(error => {
  process.stderr.write(`Admin invitation expiry DTO: FAIL: ${error.stack || error}\n`);
  process.exitCode = 1;
});
