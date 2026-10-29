'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard-v2.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const designSystem = fs.readFileSync(path.join(root, 'design-system.css'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'identity-ui.js'), 'utf8');
const identityCss = fs.readFileSync(path.join(root, 'identity-ui.css'), 'utf8');

const destinations = ['dashboard', 'orders', 'bikes', 'routes', 'reports', 'events', 'settings', 'help', 'integrationLab', 'admin'];
for (const destination of destinations) {
  assert.match(app, new RegExp(`\\['${destination}'`, 'u'), `module ${destination} remains registered`);
}
assert.match(app, /primaryIds=\['dashboard','orders','routes','bikes'\]/u,
  'the mobile primary destinations follow the approved operation order');
assert.match(app, /id="navMoreMenu"[\s\S]*role="dialog"[\s\S]*data-nav-more-close/u,
  'all non-primary permitted destinations have a labelled, dismissible More dialog');
assert.match(app, /id="navMoreOverlay"[^>]*hidden[\s\S]*id="navMoreMenu"[^>]*aria-modal="true"/u,
  'the More panel is an accessible modal bottom sheet');
assert.match(app, /function navigationGroups\(items\)[\s\S]*Administração[\s\S]*Suporte/u,
  'More groups all authorized destinations by Administration and Support');
assert.match(app, /const menuIcon=\(\)=>'[^']*M4 6h16M4 12h16M4 18h16/u,
  'the Mais item uses a bundled three-line SVG icon, not a font glyph or emoji');
assert.match(app, /function navigationGroups\(items\)[\s\S]*Operação[\s\S]*Gestão[\s\S]*Administração/u,
  'the desktop navigation uses clear operational and management groups');
assert.match(app, /data-sidebar-toggle[\s\S]*sidebar-collapsed[\s\S]*rotamoto\.sidebar\.collapsed/u,
  'tablet and desktop navigation can collapse and expand with a persisted preference');
assert.match(app, /function goTab\(requestedTab\)[\s\S]*pushState[\s\S]*state\.tab=tab/u,
  'navigation preserves the existing history/deep-link state flow');
assert.match(designSystem, /@media\(min-width:600px\) and \(max-width:1023px\)[\s\S]*\.sidebar\{display:flex/u,
  'the tablet sidebar remains visible after narrow phone rules');
assert.match(designSystem, /@media\(min-width:600px\) and \(max-width:1023px\)[\s\S]*\.sidebar-toggle\{display:grid/u,
  'tablet uses a compact, expandable sidebar');
assert.match(designSystem, /@media\(max-width:599px\)[\s\S]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/u,
  'phone navigation fits four primary destinations and More without horizontal scrolling');
assert.match(app, /function navButton\(n,context=''\)[\s\S]*isBottom=context==='nav-primary-item'[\s\S]*aria-label="\$\{n\[2\]\}" title="\$\{n\[2\]\}"[\s\S]*class="nav-label"/u,
  'each navigation button renders one visible label and retains its accessible full name and tooltip');
assert.match(designSystem, /\.sidebar-collapsed[\s\S]*\.side-nav \.nav-group \.nav-item\{justify-content:center/u,
  'collapsed navigation centers its icons without reserving label space');
assert.match(designSystem, /\.nav-more-overlay:not\(\[hidden\]\)[\s\S]*position:fixed/u,
  'More opens a viewport-bounded overlay above the mobile navigation');
assert.match(designSystem, /border-radius:20px 20px 0 0/u,
  'phone More uses the approved rounded bottom sheet surface');
assert.match(app, /panel\?\.addEventListener\('keydown',[\s\S]*event\.key==='Escape'[\s\S]*last\.focus\(\)/u,
  'the dialog supports Escape and keeps keyboard focus inside while open');
assert.match(app, /event\.target===overlay\)closeMoreMenu\(\)/u,
  'tapping outside the sheet closes it and returns focus to the trigger');
assert.match(app,/function navigationModules\(items\)\{return items\.filter\(\(\[id\]\)=>id!==\x27admin\x27\)\}/u,'local System is retained as a module capability but excluded from navigation destinations');
assert.match(app,/const modules=MODULES\.filter\(x=>canModule\(x\[0\]\)\),allowed=navigationModules\(modules\),destinations=orderedDestinations\(allowed\)/u,'sidebar and More render only approved navigation destinations');
const navStart=app.indexOf('function navigationModules('),navEnd=app.indexOf('\n',navStart);
const navContext={};vm.runInNewContext(`${app.slice(navStart,navEnd)}\nthis.filter=navigationModules;`,navContext);
const renderedDestinations=navContext.filter(destinations.map(id=>[id,'icon',id]));
assert(!renderedDestinations.some(([id])=>id==='admin'),'System local is absent from the More destination list');
assert(destinations.includes('admin'),'the local administration capability remains registered for permissions');
assert.match(app,/if\(tab===\x27admin\x27\)\{tab=\x27settings\x27;targetSettingsOpen=\x27system-admin\x27\}/u,'legacy internal admin navigation resolves into Settings');
assert.match(app,/if\(state\.tab===\x27admin\x27\)\{state\.tab=\x27settings\x27;state\.settingsOpen=\x27system-admin\x27\}/u,'a restored legacy history entry resolves into Settings');
assert.match(app,/function goTab\(requestedTab\)[\s\S]*history\.pushState\(\{rotamotoView:true,tab,settingsOpen:targetSettingsOpen\}/u,'navigation history preserves the destination section for back/forward restoration');
assert.match(app,/kpi\('Usuários locais ativos'/u,'local user count is named explicitly as local');
assert.match(app,/kpi\('Erros locais'/u,'technical log count is named explicitly as local');
assert.match(app,/kpi\('Pedidos em aberto'/u,'open local orders are not ambiguously labelled as all pending deliveries');
assert.match(app,/function settingsPageChrome\(section\)\{[\s\S]*?const titles=\{/u,'all settings routes use one shared topbar title contract');
assert.match(app,/settings-back-action" data-settings-back aria-label="Voltar para Ajustes"/u,'the return action is part of the shared topbar rather than a detached row');
const chromeStart=app.indexOf('function settingsPageChrome('),chromeEnd=app.indexOf('\nfunction card(',chromeStart),chromeContext={header:(title,_subtitle,action='')=>`<header><h1>${title}</h1>${action}</header>`};
vm.runInNewContext(`${app.slice(chromeStart,chromeEnd)}\nthis.chrome=settingsPageChrome;`,chromeContext);
assert.match(chromeContext.chrome('system-admin'),/<h1>Sistema local<\/h1>[\s\S]*data-settings-back/u,'System local has one title and a back action inside the topbar');
assert.match(chromeContext.chrome('company-admin-team'),/<h1>Equipe e permissões<\/h1>/u,'company team page receives its own single topbar title');
assert.match(chromeContext.chrome('platform-admin'),/<h1>Super ADM Global<\/h1>/u,'global administration uses the shared topbar title');
assert.match(chromeContext.chrome(''),/<h1>Ajustes<\/h1>/u,'Settings root retains its single page header');
assert.match(app,/if\(can\(\x27admin\x27\)\)cats\.push\(\[\x27security-audit\x27[\s\S]*?\[\x27system-admin\x27,\x27Sistema local\x27/u,'System local remains reachable from the Settings categories for authorized local administrators');
const syncStart=app.indexOf('function pendingSyncSummary('),syncEnd=app.indexOf('\nasync function getSyncStatus()',syncStart);
const syncContext={syncOperationKey:(entity,{id})=>`operation:${entity}:${id}`,isLocallyDirtyForSync:record=>record?.sync?.state==='local'||!record?.sync?.canonicalId,localVersion:record=>Number(record?.sync?.version||record?.version||1)};
vm.runInNewContext(`${app.slice(syncStart,syncEnd)}\nthis.summary=pendingSyncSummary;`,syncContext);
const localSummary=syncContext.summary({users:[{id:'local-user'}],profiles:[{id:'local-profile'}],logs:[{id:'local-log'}],events:[{id:'local-event'}],orders:[{id:'local-order',sync:{state:'local',version:1}}],deliveries:[{id:'remote-delivery',sync:{state:'synced',canonicalId:'canonical-delivery',version:1}}],bikes:[],routes:[],earnings:[]},[]);
assert.equal(localSummary.pending,1,'only a local business record without server confirmation is counted for sync');
assert.equal(localSummary.pendingKinds.Order,1,'pending sync summary identifies its entity without counting users, profiles, logs, or events');
assert.match(app,/const DB_NAME='rota-moto-restaurante-local-v30'/u,'local app state is stored in the restaurant IndexedDB database');
const adminStart=app.indexOf('function admin(){'),adminEnd=app.indexOf('\nfunction eventRow',adminStart),adminSource=app.slice(adminStart,adminEnd);
assert.match(adminSource,/state\.users[\s\S]*state\.profiles[\s\S]*IndexedDB/u,'System local presents records from local application state with an explicit IndexedDB scope');
assert.match(adminSource,/não são contas autenticadas nem permissões empresariais do servidor/u,'local users and profiles are explicitly distinguished from server identity and RBAC');
assert.match(adminSource,/conflitos e rejeições ficam separados/u,'sync queue KPI does not hide the separate conflict and rejection states');
assert.doesNotMatch(adminSource,/identity\/session|platform-admin\/companies/u,'the local administration panel does not imply it queried server identities');
assert.match(designSystem, /#121a25/u, 'the approved dark canvas token is defined');
assert.match(designSystem, /#202c3a/u, 'the approved dark card token is defined');
assert.match(designSystem, /--success:#16a36a/u, 'the approved green token is defined');
assert.match(designSystem, /--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px/u,
  'the shared spacing scale is available to every module');
assert.match(dashboard, /<h1 aria-label="\$\{escapeHtml\(title\)\}">/u,
  'compact page titles retain their complete accessible name');
assert.match(designSystem, /grid-template-columns:auto minmax\(0,1fr\) auto;grid-template-areas:none/u,
  'the 430px header uses one horizontal row');
assert.match(designSystem, /\.topbar-title-compact\{display:none\}/u,
  'desktop header renders only one title variant');
assert.match(designSystem, /\.top-actions \.btn\{flex:0 0 44px;width:44px;min-width:44px;max-width:44px/u,
  'header actions remain touch sized and icon compact on narrow phones');
assert.match(identity, /rm-account-trigger-icon/u);
assert.match(identity, /const triggerLabel = opensAccountPage \? 'Abrir Conta e segurança' : offlineMode \? 'Dados locais. Abrir opções da conta; sem sessão autenticada'/u,
  'the account destination and local-data action keep explicit accessible labels');
assert.match(identityCss, /\.rm-account-trigger-icon \{ display: none/u,
  'the account icon is available for compact header presentation');
assert.match(designSystem, /#app \.rm-page-header \.top-actions \.rm-account-trigger--inline\{display:grid;place-items:center;flex:0 0 44px;width:44px;min-width:44px;max-width:44px;height:44px;min-height:44px;padding:0;font-size:0\}/u,
  'the compact account action uses a centered 44px grid despite the base ID rule');assert.match(designSystem, /#app \.rm-page-header \.top-actions \.rm-account-trigger--inline \.rm-account-trigger-icon\{display:block;width:20px;height:20px;margin:0;justify-self:center;align-self:center;stroke:currentColor\}/u,
  'the account icon is centered on both axes while its label remains accessible');
assert.match(identity, /const triggerLabel = opensAccountPage \? 'Abrir Conta e segurança' : offlineMode \? 'Dados locais. Abrir opções da conta; sem sessão autenticada'/u,
  'the icon-only account control keeps its full accessible name');

assert.match(identityCss, /#app \.rm-page-header \.top-actions \.rm-account-trigger:active[\s\S]*background: var\(--rm-id-accent-soft\)/u, 'pressed account action receives a theme-aware surface');
assert.match(identityCss, /#app \.rm-page-header \.top-actions \.rm-account-trigger:disabled[\s\S]*opacity: \.6/u, 'disabled account action is visibly subdued and unavailable');
console.log('Restaurant grouped navigation, accessible phone More sheet, tablet sidebar and shared theme tokens: PASS');
