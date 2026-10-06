'use strict';
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createLogisticsService } = require('../backend/logistics/service');
const { createProviderIntegrationService, resolveTestProviderConfiguration } = require('../backend/logistics/provider-integration');
const { createProviderWorker } = require('../backend/logistics/provider-worker');

const previous = process.env.NODE_ENV;
try {
  process.env.NODE_ENV = 'production';
  const resolver = () => ({ companyId:'tenant-a', providerId:'provider-a', providerCode:'ifood', adapter:'fake', capabilities:['quote'] });
  assert.throws(() => createLogisticsService({ testProvider:resolver }), /NODE_ENV=test/u);
  assert.throws(() => createProviderIntegrationService({ testProvider:resolver }), /NODE_ENV=test/u);
  assert.throws(() => createProviderWorker({ pool:{}, adapterRegistry:{}, credentialResolver:async()=>({}), tenantResolver:async()=>[], testProvider:resolver }), /NODE_ENV=test/u);
  const child = spawnSync(process.execPath, ['-e', "require('./tests/e2e-support/provider-browser-runtime')"], {
    cwd:process.cwd(), encoding:'utf8', env:{ ...process.env, NODE_ENV:'production' }
  });
  assert.notEqual(child.status, 0, 'the E2E provider runtime refuses import outside test');
  assert.match(child.stderr, /NODE_ENV=test/u);
  process.env.NODE_ENV = 'test';
  const config = Object.freeze({ companyId:'tenant-a', providerId:'provider-a', providerCode:'ifood', adapter:'fake', capabilities:['quote','dispatch'] });
  const scoped = (companyId, providerId) => companyId === config.companyId && providerId === config.providerId ? config : null;
  assert.deepEqual(resolveTestProviderConfiguration(scoped,'tenant-a','provider-a').capabilities,['quote','dispatch']);
  assert.equal(resolveTestProviderConfiguration(scoped,'tenant-b','provider-a'),null,'test override cannot cross tenants');
  assert.throws(() => resolveTestProviderConfiguration(() => ({ ...config, companyId:'tenant-b' }),'tenant-a','provider-a'), /invalid or cross-tenant/u);
  assert.throws(() => resolveTestProviderConfiguration(() => ({ ...config, providerCode:'99food' }),'tenant-a','provider-a'), /invalid or cross-tenant/u);
  process.stdout.write('Provider E2E hook environment and tenant isolation guards: PASS\n');
} finally {
  if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
}
