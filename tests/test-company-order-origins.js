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
assert.match(app, /Adicionar à lista/u, 'the add action explains that the catalog still needs the explicit save');
const addFlow = app.slice(app.indexOf('Nova origem local'), app.indexOf('data-canonical-origin-cancel'));
assert.doesNotMatch(addFlow, /Identificador estável|name="id"/u,
  'the restaurant is not asked to enter an internal catalog identifier');
assert.match(app, /function orderOriginIdForName\(name,origins=\[\]\)/u);
assert.match(app, /normalize\('NFKD'\).*toLocaleLowerCase\('pt-BR'\)/u,
  'local IDs are generated from names, including Portuguese accents');
assert.match(app, /Nome da origem/u);
assert.match(ui, /Classifica pedidos registrados manualmente no painel/u);
assert.match(ui, /data-canonical-origin-save \$\{state\.settings\.orderOriginDraft&&canManage\?'':'disabled'\}/u,
  'save remains disabled before an edit');
assert.match(app, /canonical=state\.settings\.orderOriginCatalog\?\.origins/u,
  'manual order channel options consume the canonical company catalog');
assert.match(app, /orderOriginsRequest\('PUT'/u);
assert.match(app, /Alterações salvas e confirmadas pelo servidor/u,
  'origin save confirmation is displayed inline after the API readback instead of covering navigation controls');
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

assert.match(logistics, /Custo fixo estimado por entrega/u);
assert.match(logistics, /Custo estimado por quilômetro/u);
assert.match(logistics, /não definem a taxa cobrada do cliente nem o repasse ao motoboy/u,
  'logistics estimates are explicitly separated from delivery fees and driver payout');
assert.match(logistics, /Política de comparação/u);
assert.match(logistics, /data-logistics-cost-status role="status"/u);
assert.match(logistics, /Política salva e confirmada pelo servidor/u);
assert.match(logistics, /Não foi possível salvar a política da rota\. Seus valores foram mantidos/u);
assert.doesNotMatch(logistics.slice(logistics.indexOf('const routeFormMarkup='), logistics.indexOf('function providerList')), /window\.RotaMotoApp\?\.toast/u,
  'route save success and errors stay with the form instead of covering other controls');
const intelligenceSettingsUi = logistics.slice(logistics.indexOf('async function loadIntelligenceSettings'), logistics.indexOf('async function loadRouteSettings'));
assert.doesNotMatch(intelligenceSettingsUi, /Order\.value|Earning|Perfil v\$\{settings\.version\}/u,
  'internal field names and revision numbers are not presented in Logistics');
const css = fs.readFileSync(require.resolve('../styles.css'), 'utf8');
assert.match(css, /\.source-setting-fields\{grid-template-columns:minmax\(0,1fr\);/u,
  'origin name input has one responsive column instead of splitting its label from the field');
assert.match(css, /\.source-toggle\{max-width:100%;white-space:normal!important;/u,
  'activation status can wrap without widening a card');

console.log('Order origins API validation, tenant/company permissions and Logistics/company-location UI contract: PASS');
