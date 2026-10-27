'use strict';
const assert = require('node:assert/strict');
const { createLogisticsService } = require('../backend/logistics/service');

(async () => {
  const companyId = 'tenant-readonly-test';
  const calls = [];
  const client = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes('FROM rotamoto.delivery_fulfillments f JOIN rotamoto.logistics_providers')) return { rows: [] };
    if (sql.includes('WITH commands AS')) return { rows: [{ provider_id: 'p1', code: 'internal_fleet', display_name: 'Frota própria',
      provider_class: 'internal_fleet', quote_requests: 0, quotes_received: 0, quotes_selected: 0, quotes_expired: 0,
      dispatch_requested: 0, dispatch_confirmed: 0, dispatch_failed: 0, dispatch_unknown: 0,
      cancellation_requests: 0, cancellation_unknown: 0, retries: 0, reconciliation_requests: 0, operator_review: 0 }] };
    if (sql.includes('canonical_deliveries')) return { rows: [{ canonical_deliveries: 3, completed_deliveries: 2,
      deliveries_without_allocation: 1, orders_without_delivery: 4 }] };
    throw new Error('Unexpected analytics SQL');
  } };
  const result = await createLogisticsService().analytics(client, { company_id: companyId, user_id: 'user-readonly-test' });
  assert.deepEqual(result.scope, { source: 'postgresql', basis: 'company-history', filtersApplied: false });
  assert.deepEqual(result.coverage, { canonicalDeliveries: 3, completedDeliveries: 2, deliveriesWithoutAllocation: 1, ordersWithoutDelivery: 4 });
  assert.equal(result.integrations[0].code, 'internal_fleet', 'stable internal provider identifier is preserved');
  assert.equal(result.integrations[0].displayName, 'Frota própria', 'user-facing provider name is available separately');
  assert.equal(result.integrations[0].dispatchRequested, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.values?.[0] === companyId), 'each read remains scoped to the authenticated company');
  assert.ok(calls.every(call => /company_id=\$1/u.test(call.sql)), 'all three report queries keep company RLS scope explicit');
  assert.ok(calls.every(call => !/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE\s+TABLE)\b/iu.test(call.sql)), 'report analytics are read-only');
  console.log('Logistics analytics coverage, scope and provider display contract: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
