'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { PROVIDERS, publicCatalog, classifyProviderFailure, sanitizeProviderError, retryDelayMs, createBlockedAdapter } = require('../backend/integrations/registry');
const { createAdminRepository } = require('../backend/admin/repository');
const { ROUTES: ADMIN_ROUTES } = require('../backend/admin/http');
const { create99FoodService } = require('../99food-service');
const { createKeetaService } = require('../keeta-service');

assert.deepEqual(PROVIDERS.map(provider => provider.key), ['ifood', '99food', 'keeta']);
const catalog = publicCatalog([{ provider: 'ifood', status: 'active', externalAccount: { displayName: 'Conta', linkStatus: 'confirmed', confirmedAt: '2026-01-01' } }]);
assert.equal(catalog.length, 3);
assert(catalog.every(item => item.capability === 'blocked_external' && item.connectionVerified === false));
assert.deepEqual(catalog[0].capabilities.orders, { DOCUMENTED: true, IMPLEMENTED: true, RUNTIME_WIRED: false, LOCAL_TESTED: true, SANDBOX_TESTED: false, PRODUCTION_AUTHORIZED: false });
assert.equal(catalog[0].capabilityContract.orders, 'SUPPORTED', 'contract availability is separated from runtime connection');
assert.deepEqual(catalog[0].capabilities.homologation, { DOCUMENTED: true, IMPLEMENTED: false, RUNTIME_WIRED: false, LOCAL_TESTED: false, SANDBOX_TESTED: false, PRODUCTION_AUTHORIZED: false });
assert.deepEqual(catalog[2].capabilities.account, { DOCUMENTED: true, IMPLEMENTED: true, RUNTIME_WIRED: false, LOCAL_TESTED: true, SANDBOX_TESTED: false, PRODUCTION_AUTHORIZED: false });
assert.equal(catalog[2].capabilityContract.platformDelivery, 'NOT_SUPPORTED', 'Keeta merchant fulfillment is not represented as a platform courier API');
assert(catalog.every(item => item.actions.connect === false && item.actions.reconnect === false));
assert.equal(catalog[0].state, 'authorized_unverified', 'an account link does not assert a successful provider health check');
assert.equal(publicCatalog([{ provider: 'ifood', status: 'disabled' }])[0].state, 'disabled');
assert.equal(JSON.stringify(catalog).includes('secret_ref'), false);
assert.equal(/"(?:access_?token|refresh_?token|client_?secret|secret_ref)"\s*:/iu.test(JSON.stringify(catalog)), false);
assert.equal(ADMIN_ROUTES['/api/admin/integrations'].permission, 'integrations.manage');

assert.deepEqual(classifyProviderFailure({ status: 429, retryAfterSeconds: 5000 }), {
  class: 'transient', retryable: true, retryAfterSeconds: 3600
});
assert.equal(classifyProviderFailure({ status: 401 }).class, 'reauth_required');
assert.equal(classifyProviderFailure({ status: 422 }).retryable, false);
assert.equal(retryDelayMs({ status: 503 }, 0, () => 0.5), 1000);
assert.equal(retryDelayMs({ status: 503 }, 8), null, 'retry policy stops after its bounded attempt count');
assert.equal(retryDelayMs({ status: 422 }, 0), null, 'permanent errors are not retried');
assert.equal(retryDelayMs({ status: 429, retryAfterSeconds: 4 }, 0), 4000);
assert.deepEqual(sanitizeProviderError({ code: 'PROVIDER_ERROR', message: 'secret token and PII', data: { token: 'x' } }), {
  code: 'PROVIDER_ERROR', class: 'permanent', retryable: false, retryAfterSeconds: null
});

(async () => {
  const adminRepository = createAdminRepository();
  const adminCatalog = await adminRepository.integrations({ async query(sql) {
    assert.match(sql, /company_id=\$1/u);
    assert.doesNotMatch(sql, /secret_ref|metadata/u);
    return { rows: [{ provider: '99food', status: 'active', display_name: 'Conta', link_status: 'confirmed', confirmed_at: new Date() }] };
  } }, 'tenant-id');
  assert.equal(adminCatalog.integrations.length, 3);
  assert.equal(adminCatalog.integrations.find(item => item.provider === '99food').connectionVerified, false);
  assert.equal(adminCatalog.integrations.find(item => item.provider === '99food').state, 'authorized_unverified');
  assert.equal(adminCatalog.integrations[0].lastEventAt, null, 'the current schema does not assert a provider synchronization timestamp');
  for (const provider of PROVIDERS) {
    const adapter = createBlockedAdapter(provider.key);
    assert.equal(adapter.diagnostics().connectionVerified, false);
    for (const action of ['connect', 'poll', 'acknowledge', 'execute']) {
      await assert.rejects(adapter[action](), error => error.code === 'PROVIDER_BLOCKED_EXTERNAL');
    }
  }
  const food99 = create99FoodService({ FOOD99_BASE_URL: 'https://example.invalid', FOOD99_CLIENT_SECRET: 'synthetic' });
  const keeta = createKeetaService({ KEETA_BASE_URL: 'https://example.invalid', KEETA_CLIENT_SECRET: 'synthetic' });
  assert.deepEqual(food99.verifyWebhook('{}', 'a'.repeat(64)), { configured: false, valid: null });
  await assert.rejects(food99.orders(), error => error.code === 'PROVIDER_BLOCKED_EXTERNAL');
  await assert.rejects(keeta.poll(), error => error.code === 'PROVIDER_BLOCKED_EXTERNAL');
  for (const [file, globalName, method] of [
    ['ifood-integration.js', 'RotaMotoIFood', 'status'],
    ['99food-integration.js', 'RotaMoto99Food', 'orders'],
    ['keeta-integration.js', 'RotaMotoKeeta', 'poll']
  ]) {
    const context = { window: {} };
    vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8'), context);
    assert.equal(context.window[globalName].available(), false);
    assert.equal(context.window[globalName].diagnostics().connectionVerified, false);
    await assert.rejects(context.window[globalName][method](), error => error.code === 'PROVIDER_BLOCKED_EXTERNAL');
    if (globalName === 'RotaMotoIFood') {
      const sample = context.window[globalName].simulateOrder();
      assert.equal(sample.order.sync.state, 'local-simulation');
      assert.equal(context.window[globalName].diagnostics().lab, 'local_simulation');
    }
  }
  assert.throws(() => createBlockedAdapter('unknown'), /Provider desconhecido/u);
  console.log('integration boundary tests: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
