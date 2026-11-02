'use strict';

const assert = require('node:assert/strict');
const { createAdminRepository } = require('../backend/admin/repository');
const { AUTHORIZED_DRIVER_STATUSES } = require('../backend/domain/driver-access');

const companyId = '10000000-0000-4000-8000-000000000001';
const membershipId = '20000000-0000-4000-8000-000000000002';
const driverId = '30000000-0000-4000-8000-000000000003';
const principal = { company_id: companyId, user_id: '40000000-0000-4000-8000-000000000004' };

function membershipClient({ driverStatus = 'ACTIVE', currentDriverId = null, activeDelivery = false,
  availabilityChanged = true, presenceEnded = true, uniqueConflict = false } = {}) {
  const calls = [];
  const client = { async query(sql, values) {
    const text = String(sql);
    calls.push({ text, values });
    if (text.includes('SELECT m.id::text,m.driver_id::text,m.status,u.disabled_at')) {
      return { rowCount: 1, rows: [{ id: membershipId, driver_id: currentDriverId, status: 'active', disabled_at: null,
        email_verified_at: new Date(), sync_permissions: true }] };
    }
    if (text.includes('SELECT payload->>\'status\' AS status FROM rotamoto.domain_records')) {
      return driverStatus == null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ status: driverStatus }] };
    }
    if (text.includes('SELECT id::text,driver_id::text FROM rotamoto.memberships')) {
      return { rowCount: 1, rows: [{ id: membershipId, driver_id: currentDriverId }] };
    }
    if (text.includes('SELECT record_id FROM rotamoto.domain_records') && text.includes("entity_type='Driver'")) {
      return { rowCount: 1, rows: [{ record_id: driverId }] };
    }
    if (text.includes("entity_type='Delivery'")) {
      return { rowCount: activeDelivery ? 1 : 0, rows: activeDelivery ? [{ record_id: 'delivery-active' }] : [] };
    }
    if (text.includes('UPDATE rotamoto.driver_availability')) return { rowCount: availabilityChanged ? 1 : 0, rows: [] };
    if (text.includes('UPDATE rotamoto.restaurant_driver_presence')) return { rowCount: presenceEnded ? 1 : 0, rows: [] };
    if (text.includes('UPDATE rotamoto.memberships SET driver_id=$3')) {
      if (uniqueConflict) throw Object.assign(new Error('unique violation'), { code: '23505' });
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  } };
  return { client, calls };
}

async function main() {
  const repository = createAdminRepository();
  const inactive = membershipClient({ driverStatus: 'DISABLED' });
  await assert.rejects(repository.associateMembershipDriver(inactive.client, principal, membershipId, driverId),
    error => error.code === 'DRIVER_INACTIVE');
  assert.equal(inactive.calls.some(call => call.text.includes('UPDATE rotamoto.memberships SET driver_id=$3')), false,
    'an operationally inactive Driver is never linked');

  const missingStatus = membershipClient({ driverStatus: null });
  await assert.rejects(repository.associateMembershipDriver(missingStatus.client, principal, membershipId, driverId),
    error => error.code === 'DRIVER_NOT_FOUND');

  const linked = membershipClient();
  assert.deepEqual(await repository.associateMembershipDriver(linked.client, principal, membershipId, driverId),
    { membershipId, driverId, changed: true });
  assert(linked.calls.some(call => call.text.includes("entity_type='Driver'") && call.text.includes('FOR UPDATE')),
    'link operation locks the tenant-scoped canonical Driver before association');

  const duplicate = membershipClient({ uniqueConflict: true });
  await assert.rejects(repository.associateMembershipDriver(duplicate.client, principal, membershipId, driverId),
    error => error.code === 'DRIVER_ALREADY_LINKED');

  const busy = membershipClient({ currentDriverId: driverId, activeDelivery: true });
  await assert.rejects(repository.disassociateMembershipDriver(busy.client, principal, membershipId),
    error => error.code === 'DRIVER_HAS_ACTIVE_DELIVERIES');
  assert.equal(busy.calls.some(call => call.text.includes('UPDATE rotamoto.memberships SET driver_id=NULL')), false,
    'an active delivery prevents unlink');
  assert.equal(busy.calls.some(call => call.text.includes('UPDATE rotamoto.driver_availability')), false,
    'a blocked unlink leaves availability unchanged');

  const unlinked = membershipClient({ currentDriverId: driverId, availabilityChanged: true, presenceEnded: true });
  const result = await repository.disassociateMembershipDriver(unlinked.client, principal, membershipId);
  assert.deepEqual(result, { membershipId, driverId: null, previousDriverId: driverId, changed: true,
    availabilityEnded: true, presenceEnded: true });
  assert(unlinked.calls.some(call => call.text.includes("SET status='offline'") && call.values[1] === driverId),
    'unlink ends an online availability lease');
  assert(unlinked.calls.some(call => call.text.includes('SET is_present=false') && call.values[1] === driverId),
    'unlink checks out a present Driver so dispatch cannot keep selecting an orphaned account');
  assert(unlinked.calls.some(call => call.text.includes('UPDATE rotamoto.memberships SET driver_id=NULL')),
    'link removal is persisted only after the active delivery guard');

  const idempotent = membershipClient({ currentDriverId: null });
  assert.deepEqual(await repository.disassociateMembershipDriver(idempotent.client, principal, membershipId),
    { membershipId, driverId: null, changed: false });
  assert.equal(idempotent.calls.some(call => call.text.includes('UPDATE rotamoto.driver_availability')), false);

  const driverAccessSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '../identity-ui.js'), 'utf8');
  const statusMatch = driverAccessSource.match(/const linkableStatuses=new Set\(\[([\s\S]*?)\]\);/u);
  assert(statusMatch, 'Motoboy link selector defines the statuses accepted by the access service');
  const uiStatuses = new Set(require('node:vm').runInNewContext(`[${statusMatch[1]}]`));
  assert.deepEqual([...uiStatuses].sort(), [...AUTHORIZED_DRIVER_STATUSES].sort(),
    'UI eligibility matches the server-side Driver access contract');

  process.stdout.write('Admin driver links validate operational identity, prevent active-delivery unlink, end availability/presence, and preserve idempotency: PASS\n');
}

main().catch(error => { process.stderr.write(`Admin driver links: FAIL: ${error.stack || error}\n`); process.exitCode = 1; });
