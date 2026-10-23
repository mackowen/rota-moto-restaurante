'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
assert.match(app, /data-sidebar-toggle[\s\S]*sidebar-expanded/u,
  'tablet navigation can collapse and expand without changing destinations');
assert.match(app, /function goTab\(tab\)[\s\S]*pushState[\s\S]*state\.tab=tab/u,
  'navigation preserves the existing history/deep-link state flow');
assert.match(designSystem, /@media\(min-width:600px\) and \(max-width:1023px\)[\s\S]*\.sidebar\{display:flex/u,
  'the tablet sidebar remains visible after narrow phone rules');
assert.match(designSystem, /@media\(min-width:600px\) and \(max-width:1023px\)[\s\S]*\.sidebar-toggle\{display:grid/u,
  'tablet uses a compact, expandable sidebar');
assert.match(designSystem, /@media\(max-width:599px\)[\s\S]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/u,
  'phone navigation fits four primary destinations and More without horizontal scrolling');
assert.match(designSystem, /\.bottom-nav \.nav-label-full\{display:none\}\.bottom-nav \.nav-label-short\{display:block\}/u,
  'mobile navigation displays one concise label variant for each destination');
assert.match(designSystem, /\.nav-more-overlay:not\(\[hidden\]\)[\s\S]*position:fixed/u,
  'More opens a viewport-bounded overlay above the mobile navigation');
assert.match(designSystem, /border-radius:20px 20px 0 0/u,
  'phone More uses the approved rounded bottom sheet surface');
assert.match(app, /panel\?\.addEventListener\('keydown',[\s\S]*event\.key==='Escape'[\s\S]*last\.focus\(\)/u,
  'the dialog supports Escape and keeps keyboard focus inside while open');
assert.match(app, /event\.target===overlay\)closeMoreMenu\(\)/u,
  'tapping outside the sheet closes it and returns focus to the trigger');
assert.match(app,/const modules=MODULES\.filter\(x=>canModule\(x\[0\]\)\),allowed=modules,destinations=orderedDestinations\(allowed\)/u,'all permitted modules remain available in the desktop sidebar');
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
