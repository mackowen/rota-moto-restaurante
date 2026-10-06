'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../backend/logistics/domain');
const migration = fs.readFileSync(path.join(__dirname, '../backend/postgres/migrations/0017_logistics_fulfillment.up.sql'), 'utf8');

assert.deepEqual(D.CAPABILITIES, ['manual_assignment']);
assert.deepEqual(D.PROVIDER_CLASSES, ['partner', 'marketplace']);
assert.equal(D.validateCode('lastmile_partner'), 'lastmile_partner');
assert.throws(() => D.validateCode('internal_fleet'), { code: 'INVALID_INPUT' });
assert.equal(D.validateName(' Parceiro local '), 'Parceiro local');
assert.throws(() => D.validateName('x\nheader'), { code: 'INVALID_INPUT' });
assert.deepEqual(D.validateConfiguration({ dispatchInstructions: 'Portal do parceiro', portalUrl: 'https://partner.example.invalid/orders' }),
  { dispatchInstructions: 'Portal do parceiro', portalUrl: 'https://partner.example.invalid/orders' });
assert.throws(() => D.validateConfiguration({ password: 'nope' }), { code: 'INVALID_INPUT' });
assert.throws(() => D.validateConfiguration({ portalUrl: 'https://user:pass@partner.example.invalid' }), { code: 'INVALID_INPUT' });
assert.deepEqual(D.safeMoney(1234, 'BRL', 'cost'), { amountMinor: 1234, currency: 'BRL' });
assert.throws(() => D.safeMoney(1.2, 'BRL', 'cost'), { code: 'INVALID_INPUT' });
assert.throws(() => D.safeMoney(1, 'bad', 'cost'), { code: 'INVALID_INPUT' });
assert.equal(D.assertFulfillmentTransition('selected', 'dispatch_requested'), true);
assert.throws(() => D.assertFulfillmentTransition('completed', 'in_progress'), { code: 'INVALID_STATE_TRANSITION' });
assert.deepEqual(D.validateFulfillmentPatch({ expectedRevision: 3, status: 'completed', finalCostMinor: 1200, finalCostCurrency: 'BRL' }),
  { expectedRevision: 3, status: 'completed', finalCostMinor: 1200, finalCostCurrency: 'BRL' });
assert.throws(() => D.validateFulfillmentPatch({ expectedRevision: 0, status: 'completed' }), { code: 'INVALID_INPUT' });
assert.throws(() => D.validateFulfillmentPatch({ expectedRevision: 1, estimatedCostMinor: 100 }), { code: 'INVALID_INPUT' });
assert.throws(() => D.validateFulfillmentPatch({ expectedRevision: 1, status: 'superseded' }), { code: 'INVALID_INPUT' });

for (const table of ['logistics_providers', 'delivery_fulfillments', 'dispatch_attempts']) {
  assert.match(migration, new RegExp(`CREATE TABLE rotamoto\\.${table}\\s*\\(`));
  assert.match(migration, new RegExp(`ALTER TABLE rotamoto\\.${table} ENABLE ROW LEVEL SECURITY`));
  assert.match(migration, new RegExp(`ALTER TABLE rotamoto\\.${table} FORCE ROW LEVEL SECURITY`));
  assert.match(migration, new RegExp(`CREATE POLICY tenant_isolation ON rotamoto\\.${table}`));
  assert.match(migration, new RegExp(`GRANT SELECT ON TABLE rotamoto\\.${table} TO rotamoto_app`));
  assert.match(migration, new RegExp(`GRANT INSERT \\([\\s\\S]*?\\)\\s+ON TABLE rotamoto\\.${table} TO rotamoto_app`));
  assert.match(migration, new RegExp(`GRANT UPDATE \\([\\s\\S]*?\\)\\s+ON TABLE rotamoto\\.${table} TO rotamoto_app`));
  assert.doesNotMatch(migration, new RegExp(`GRANT[^;]*DELETE[^;]*${table}`, 'i'));
}
assert.match(migration, /UNIQUE \(company_id, provider_id, idempotency_key\)/u);
assert.match(migration, /UNIQUE \(company_id, delivery_id, revision\)/u);
assert.match(migration, /mode='external' AND driver_id IS NULL/u);
assert.match(migration, /configuration - ARRAY\['dispatchInstructions','portalUrl'\]/u);
assert.doesNotMatch(migration, /BYPASSRLS|CREATE ROLE|ALTER ROLE/iu);
console.log('Logistics domain and migration security checks: OK');
