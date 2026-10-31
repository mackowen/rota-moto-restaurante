'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ROUTES, validateOrderOrigins } = require('../backend/admin/http');

assert.equal(ROUTES['/api/admin/order-origins'].method, 'GET');
assert.equal(ROUTES['/api/admin/order-origins'].permission, 'company.manage');
const valid = validateOrderOrigins({ expectedVersion: 1, origins: [{ id: 'phone_orders', name: 'Pedidos por telefone', active: true }] });
assert.deepEqual(valid, { expectedVersion: 1, origins: [{ id: 'phone_orders', name: 'Pedidos por telefone', active: true }] });
for (const invalid of [
  { expectedVersion: 0, origins: [] },
  { expectedVersion: 1, origins: [{ id: 'ifood', name: 'iFood local', active: true }] },
  { expectedVersion: 1, origins: [{ id: 'phone_orders', name: 'Canal', active: true }, { id: 'phone_orders', name: 'Outro', active: true }] },
  { expectedVersion: 1, origins: [{ id: 'phone_orders', name: 'Canal', active: true }, { id: 'other_source', name: ' canal ', active: true }] },
  { expectedVersion: 1, origins: [{ id: 'phone_orders', name: 'Canal', active: 'true' }] },
  { expectedVersion: 1, origins: [{ id: 'phone_orders', name: 'Can\nal', active: true }] }
]) assert.throws(() => validateOrderOrigins(invalid), error => error.code === 'INVALID_INPUT');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const ui = app.slice(app.indexOf('function renderOrdersIntegrationsSettings'), app.indexOf('function settingsPanel'));
assert.match(ui, /Origens locais/u);
assert.match(ui, /Integrações externas/u);
assert.match(ui, /data-canonical-origin-save/u);
assert.match(ui, /data-canonical-origin-save \$\{state\.settings\.orderOriginDraft&&canManage\?'':'disabled'\}/u,
  'save remains disabled before an edit');
assert.match(app, /canonical=state\.settings\.orderOriginCatalog\?\.origins/u,
  'manual order channel options consume the canonical company catalog');
assert.match(app, /orderOriginsRequest\('PUT'/u);
assert.match(app, /REVISION_CONFLICT/u);
assert.match(app, /baseOrigins:structuredClone\(state\.settings\.orderOriginCatalog\.origins\)/u);
assert.match(app, /Carregar valores atuais/u, 'revision conflicts offer an explicit safe reload instead of silently discarding the draft');
assert.match(app, /READBACK_MISMATCH/u);
assert.match(app, /Desativada — referências históricas preservadas/u);
assert.match(app, /orderOriginIntegrationStatus/u,
  'an integration permission/fetch failure is kept separate from the local origins response');
assert.doesNotMatch(ui, /iFood.*local|Keeta.*local|99Food.*local/iu,
  'external marketplace providers are not seeded as local sources');

const logistics = fs.readFileSync(require.resolve('../logistics-ui.js'), 'utf8');
const routeForm = logistics.slice(logistics.indexOf('const routeFormMarkup='), logistics.indexOf('root.innerHTML=routeFormMarkup'));
assert.doesNotMatch(routeForm, /name="(?:originMode|latitude|longitude)"/u,
  'Logistics does not render separate editable company coordinates');
assert.match(routeForm, /data-settings-open="geral"/u,
  'the canonical company location has a direct edit action');
assert.match(routeForm, /localização canônica da empresa/u);

console.log('Order origins API validation, tenant/company permissions and Logistics/company-location UI contract: PASS');
