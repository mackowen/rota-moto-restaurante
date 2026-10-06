'use strict';

const assert = require('node:assert/strict');
const { createLogisticsProviderAdapterRegistry } = require('../backend/logistics/provider-adapters');

const id = '00000000-0000-4000-8000-000000000001';
const calls = [];
const ifoodAdapter = {
  capabilities: ['quote','dispatch','cancel','tracking','webhook'],
  async quote(input) { calls.push(['quote',input]); return { provider:'ifood', externalQuoteReference:id, currency:'BRL', amountMinor:1200, createdAt:'2026-01-01T00:00:00.000Z', expiresAt:'2026-01-01T00:05:00.000Z', etaAt:null }; },
  async dispatch(input) { calls.push(['dispatch',input]); return { provider:'ifood', status:'requested', confirmation:'pending' }; },
  async cancel(input) { calls.push(['cancel',input]); return { provider:'ifood', status:'requested', confirmation:'pending' }; },
  async tracking(input) { calls.push(['tracking',input]); return { provider:'ifood', expectedDelivery:null, latitude:1, longitude:2, trackedAt:null }; }
};
const registry = createLogisticsProviderAdapterRegistry({ ifoodAdapter });
assert.deepEqual(registry.codes(), ['ifood']);
assert.equal(registry.get('99food'), null);
assert.equal(registry.get('keeta'), null);

(async () => {
  const adapter = registry.get('ifood');
  await assert.rejects(adapter.quote({ companyId:id, payload:{} }), error => error.code === 'EXTERNAL_ORDER_REFERENCE_MISSING');
  const payload = { externalOrderId:id, externalQuoteId:id };
  const quote = await adapter.quote({ companyId:id, payload, credentials:{clientId:'test',clientSecret:'test'} });
  assert.equal(quote.quote.currency, 'BRL');
  assert.equal((await adapter.dispatch({ companyId:id, payload, credentials:{clientId:'test',clientSecret:'test'} })).status, 'requested');
  assert.equal((await adapter.cancel({ companyId:id, payload, credentials:{clientId:'test',clientSecret:'test'} })).confirmation, 'pending');
  await adapter.tracking({ companyId:id, payload, credentials:{clientId:'test',clientSecret:'test'} });
  assert.equal(calls.length,4);
  assert.equal(calls[0][1].orderId,id);
  assert.equal(calls[1][1].quoteId,id);
  assert.equal(calls.some(([,input]) => input.credentials.clientSecret === 'test'),true);
  process.stdout.write('Provider adapter registry boundaries and normalized operations: PASS\n');
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
