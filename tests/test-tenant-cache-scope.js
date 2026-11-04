'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../tenant-cache-scope.js'), 'utf8');
const window = {};
vm.runInNewContext(source, { window, Object, Array });
const rows = [
  { id: 'own', companyId: 'tenant-a' },
  { id: 'foreign', companyId: 'tenant-b' },
  { id: 'unscoped' },
  { id: 'legacy-local', companyId: 'company_local' }
];
assert.deepEqual(window.RotaMotoTenantCacheScope.forCompany(rows, 'tenant-a').map(row => row.id), ['own']);
assert.deepEqual([...window.RotaMotoTenantCacheScope.forCompany(rows, null)], []);
assert.deepEqual(window.RotaMotoTenantCacheScope.forCompany(rows, 'tenant-missing'), []);
console.log('Tenant cache scope: PASS (foreign, unscoped and local-only records stay hidden from authenticated tenant views)');
