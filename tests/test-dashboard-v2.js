'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('app.js', 'utf8');
const preview = fs.readFileSync('dashboard-v2.js', 'utf8');
const css = fs.readFileSync('dashboard-v2.css', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

const context = {window:{}};
vm.runInNewContext(`${preview}\nthis.render=window.RotaMotoDashboardV2.render;`, context);
const safeHtml = context.render({
  restaurantName: '<Empresa>', connected: null, canCreate: true,
  kpis: [{label:'Em rota', value:2, detail:'entregas', icon:'route', tone:'info'}],
  orders: [{id:'e2e-order-1',number:'E2E-1',customer:'Cliente sintético <um>',address:'Rua Exemplo, 10',driver:'Motoboy E2E',fee:'Não informada',status:'Aguardando',statusTone:'',createdAt:0}],
  dailyVolume: [], sources: [], analyticsAvailable: false
});
assert.match(safeHtml, /Cliente sintético &lt;um&gt;/, 'presentation escapes domain text');
assert.match(safeHtml, /aria-label="Impressão disponível no fluxo atual, fora da prévia"/, 'print stays unavailable in read-only preview');
assert.match(safeHtml, /QR seguro disponível no fluxo atual, fora da prévia/, 'secure QR is not triggered from preview');
assert.match(safeHtml, /Data indisponível/, 'missing timestamps never render Invalid Date');
assert.match(safeHtml, /data-detail="e2e-order-1"/, 'opening a delivery links to existing operational flow');
assert.match(safeHtml, /data-new/, 'create action delegates to existing create flow');
assert.match(context.render({orders:[]}), /Nenhuma entrega para revisar/, 'empty state is explicit');
assert.match(app, /state\.tab==='dashboard'&&new URLSearchParams\(location\.search\)\.get\('preview'\)==='dashboard-v2'&&canModule\('dashboard'\)/, 'preview requires dashboard module permission and explicit preview query');
assert.match(app, /const tenantOrders=companyId\?\(state\.orders\|\|\[\]\)\.filter\(order=>canonicalOrderCompany\(order\)===companyId\):\[\]/, 'preview fails closed without an active tenant and filters orders by Company');
assert.match(app, /aggregate\(\{orders:tenantOrders,deliveries,deliveryEvents,earnings,bikes:\[\]\}/, 'analytics receives only tenant-scoped delivery data and no unrelated fleet records');
assert.match(app, /classList\.toggle\('dashboard-v2-shell',Boolean\(previewV2\)\)/, 'tablet navigation override is scoped to the active preview');
assert.match(app, /main\.innerHTML=previewV2\?dashboardV2Preview\(\):views\[state\.tab\]/, 'default Inicio renderer is preserved unless preview is explicitly selected');
assert.match(app, /data-dv2-exit[\s\S]*?searchParams\.delete\('preview'\)/, 'preview has a direct exit back to current Inicio');
assert.match(index, /dashboard-v2\.js\?v=0299\.1/, 'isolated dashboard module is loaded');
assert.match(css, /@media\(max-width:767px\)/, 'phone layout uses a dedicated responsive breakpoint');
assert.match(css, /@media\(max-width:1023px\)/, 'tablet layout collapses the insights workspace');
assert.match(css, /@media \(min-width:600px\) and \(max-width:800px\)[\s\S]*dashboard-v2-shell \.sidebar\{\s*display:flex/, 'tablet preview restores a compact sidebar only in the preview');
assert.match(css, /min-height:44px/, 'interactive controls target a 44px minimum hit area');
assert.match(css, /overflow-wrap:anywhere/, 'long names and addresses wrap instead of becoming vertical');
console.log('Dashboard v2 preview isolation and presentation tests passed.');
