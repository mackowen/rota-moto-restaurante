'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const app = fs.readFileSync('app.js', 'utf8');
const view = fs.readFileSync('dashboard-v2.js', 'utf8');
const css = fs.readFileSync('dashboard-v2.css', 'utf8');
const ds = fs.readFileSync('design-system.css', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');

const renderContext = {window:{}};
vm.runInNewContext(`${view}\nthis.render=window.RotaMotoDashboardV2.render;`, renderContext);
const html = renderContext.render({
  restaurantName:'<Empresa>', canCreate:true, canOrders:true, canEvents:true, canReports:true,
  kpis:[{label:'Em rota',value:2,detail:'entregas',icon:'route',tone:'info'}],
  orders:[{id:'order-a',number:'A-1',customer:'Cliente <um>',address:'Rua Exemplo, 10',source:'iFood',driver:'Motoboy A',fee:'Não informada',distance:'Não informada',status:'Aguardando',statusTone:'',createdAt:0,canOpen:true,canPrint:true,qrEligible:true,canQr:true}],
  dailyVolume:[],sources:[],analyticsAvailable:false
});
assert.match(html,/Cliente &lt;um&gt;/u,'presentation escapes tenant domain text');
assert.match(html,/Data indisponível/u,'missing timestamps never render Invalid Date');
assert.match(html,/data-detail="order-a"/u,'open uses the existing delivery details handler');
assert.match(html,/data-print-order="order-a"/u,'print calls the existing print preview handler');
assert.match(html,/data-qr-open="order-a"/u,'eligible secure QR calls the existing signed QR handler');
assert.match(html,/data-new/u,'new race delegates to the existing create flow');
assert.match(html,/data-tab="orders"/u,'view all uses the existing orders navigation');
assert.match(html,/data-tab="reports"/u,'reports action uses the existing reports destination');
assert.match(html,/data-tab="events"/u,'notification action uses the existing events and notifications destination');
assert.match(html,/Origem[\s\S]*Motoboy[\s\S]*Taxa[\s\S]*Distância estimada/u,'cards show commercial origin, assigned driver, known fee and known distance');
assert.match(html,/id="syncStatusPanel"[\s\S]*data-sync-label[\s\S]*data-sync-detail[\s\S]*data-sync-now/u,'dashboard status reuses the canonical live synchronization feedback and retry handler');
const denied = renderContext.render({canOrders:false,canEvents:false,canReports:false,orders:[{id:'x',number:'x',canOpen:false,canPrint:false,printUnavailable:'Sem permissão',qrEligible:true,canQr:false}]});
assert.match(denied,/disabled[^>]*title="Seu perfil não tem acesso a pedidos"/u,'restricted actions explain the RBAC denial');
assert.doesNotMatch(denied,/data-print-order="x"/u,'print is not exposed when orders permission is absent');
assert.match(renderContext.render({orders:[]}),/Nenhuma entrega para revisar/u,'empty state is explicit');

const model = app.match(/function dashboardV2Model\(\)\{[\s\S]*?\n\}/u)?.[0];
assert(model,'production dashboard exposes one adapter over existing domain state');
const captured={};
const companyA='company-a',companyB='company-b';
const orderA={id:'order-a',companyId:companyA,num:'A-1',status:'AGUARDANDO',createdAt:100,deliveryId:'delivery-a',sourceId:'manual',km:null};
const orderB={id:'order-b',companyId:companyB,num:'B-1',status:'AGUARDANDO',createdAt:100,deliveryId:'delivery-b',sourceId:'manual'};
const deliveryA={id:'delivery-a',companyId:companyA,orderId:'order-a',status:'ASSIGNED',driverId:'driver-a',estimatedDistanceM:null};
const deliveryB={id:'delivery-b',companyId:companyB,orderId:'order-b',status:'ASSIGNED',driverId:'driver-b'};
const analytics={total:1,deliveryStatusCounts:{ASSIGNED:1},completedCount:0,cancelledCount:0,sourceCounts:{manual:1},dailyVolume:[],actualDistance:{average:null},driverPayout:{count:0,total:null},coverage:{actualDistance:{available:0,total:1},earning:{available:0,total:1}}};
const context={
  syncSession:{companyId:companyA,timeZone:'America/Sao_Paulo'},
  state:{orders:[orderA,orderB],deliveries:[deliveryA,deliveryB],deliveryEvents:[],earnings:[],bikes:[{id:'driver-a',companyId:companyA,name:'Motoboy A'},{id:'driver-b',companyId:companyB,name:'Motoboy B'}],syncState:[],settings:{global:{companyId:companyA,companyName:'Empresa A'},company:{name:'Empresa A'},orders:{sources:[{id:'manual',name:'Manual'}]},printing:{enabled:true}}},
  activeRestaurantCompanyId:()=>companyA,
  canonicalOrderCompany:order=>order.companyId,
  ordersWithCanonicalDeliveryStatus:orders=>orders,
  canAssignOwnDelivery:()=>true,
  window:{RotaMotoAnalytics:{aggregate:input=>{Object.assign(captured,input);return analytics}}},
  can:()=>true,canModule:module=>module==='orders'||module==='events'||module==='reports',
  canonicalDeliveryProjection:delivery=>delivery,deliveryForOrder:order=>order.id==='order-a'?deliveryA:deliveryB,
  knownDeliveryFeeBRL:()=>null,money:value=>`BRL ${value}`,channelLabel:value=>value,orderSourceLabel:()=> 'Manual',statusLabel:value=>value,
  Date,Intl,Number,String,Boolean,Math
};
vm.runInNewContext(`${model}\nthis.model=dashboardV2Model;`,context);
const data=context.model();
assert.equal(captured.orders.length,1,'analytics sees orders in the authenticated tenant only');
assert.equal(captured.deliveries.length,1,'analytics sees only deliveries linked to the active tenant');
assert.equal(captured.bikes.length,1,'analytics receives fleet data scoped to the active tenant');
assert.deepEqual(Array.from(data.orders,order=>order.id),['order-a'],'home queue and the authenticated company share the same scoped order source');
assert.equal(data.orders[0].distance,null,'unknown distance remains unknown instead of becoming zero');
assert.equal(data.kpis[1].value,1,'assigned deliveries remain in the waiting/acceptance KPI from canonical analytics status counts');
assert.equal(data.restaurantName,'Empresa A','dashboard uses the active company name');

assert.match(app,/function dashboard\(\)\{return dashboardV2Official\(\)\}/u,'DashboardV2 is the official Início renderer');
assert.match(app,/function dashboardLegacyReference\(\)/u,'old composition is retained only as a rollback reference');
assert.match(app,/main\.innerHTML=views\[state\.tab\]\?views\[state\.tab\]\(\)/u,'normal app routing renders the official dashboard view without a preview query');
assert.doesNotMatch(app,/searchParams\.get\('preview'\)===?'dashboard-v2'/u,'official dashboard no longer depends on preview mode');
assert.match(app,/state\.tab==='dashboard'&&canModule\('dashboard'\)&&window\.RotaMotoDashboardV2/u,'dashboard-specific tablet presentation still respects RBAC');
assert.match(app,/data-nav-more-close/u,'More sheet has an accessible close control');
assert.match(app,/function orderQuickFilterMarkup\(\)[\s\S]*aria-pressed=/u,'orders quick filters expose their selected state accessibly');
assert.match(app,/data-orders-clear/u,'orders search provides a working clear action');
assert.match(app,/const quick=ORDER_QUICK_STATUS\[ordersQuickFilter\]/u,'orders filtering applies the selected canonical status group');
assert.match(app,/bindOrderRowActions\(el\)/u,'filtered rows rebind open, print and eligible QR actions after replacing the list');
assert.match(app,/main\.dataset\.module=state\.tab/u,'shared module styling receives the active route without changing module behavior');
assert.match(ds,/#main\[data-module="orders"\] \.order-quick-filters/u,'orders controls use scoped responsive Design System primitives');
assert.match(ds,/order-card-actions>\.order-open-btn\{grid-column:1\/-1\}/u,'mobile delivery cards prioritize Open and pair secondary print and QR actions');
assert.match(ds,/order-card-actions>\.order-qr-wrap\{width:100%;min-width:0;max-width:none;min-height:44px/u,'eligible QR action uses the same accessible mobile touch target as print');
assert.match(app,/aria-modal="true" aria-labelledby="navMoreTitle"/u,'More sheet is exposed as a labelled modal dialog');
assert.match(app,/function openMoreMenu\(\)[\s\S]*aria-expanded','true'[\s\S]*data-nav-more-close/u,'opening More announces state and moves focus inside');
assert.match(app,/event\.key==='Escape'[\s\S]*closeMoreMenu\(\)/u,'Escape closes More and restores focus');
assert.match(app,/if\(event\.target===overlay\)closeMoreMenu\(\)/u,'outside tap closes More');
assert.match(app,/const menuIcon=\(\)=>'[^']*M4 6h16M4 12h16M4 18h16/u,'More uses a local three-line SVG icon independent of icon fonts');
assert.match(ds,/nav-more-menu:not\(\[hidden\]\)[\s\S]*border-radius:20px 20px 0 0/u,'mobile More is a rounded bottom sheet');
assert.match(ds,/nav-more-groups[\s\S]*overflow:auto/u,'More destinations scroll inside the available viewport');
assert.match(css,/dv2-connection-panel\[data-state="syncing"\]/u,'connection state distinguishes active synchronization');
assert.match(css,/dv2-connection-panel\[data-state="offline"\]/u,'connection state distinguishes offline service');
assert.match(index,/dashboard-v2\.js\?v=0300\.2/u,'official component bundle is versioned for 0300');
assert.match(sw,/CACHE_PREFIX\}v91/u,'service worker shell cache is advanced for the integrated release');
assert.match(index,/app\.js\?v=0301\.2/u,'official app script uses a fresh cache key');
console.log('Official Dashboard v2 integration, tenant projection, actions and More navigation: PASS');

assert.match(app,/const session=await restoreSyncSession\(\);if\(session\)\{const editing=[\s\S]*?if\(!editing\)render\(\);scheduleServerSync\(0\)\}/u,'authenticated startup reprojects local state after restoring the tenant without replacing an in-progress form');
