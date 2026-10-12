'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const designSystem = fs.readFileSync(path.join(root, 'design-system.css'), 'utf8');
const identity = fs.readFileSync(path.join(root, 'identity-ui.js'), 'utf8');
const identityCss = fs.readFileSync(path.join(root, 'identity-ui.css'), 'utf8');

const destinations = ['dashboard', 'orders', 'bikes', 'routes', 'reports', 'events', 'settings', 'help', 'integrationLab', 'admin'];
for (const destination of destinations) {
  assert.match(app, new RegExp(`\\['${destination}'`, 'u'), `module ${destination} remains registered`);
}
assert.match(app, /const destinations=orderedDestinations\(allowed\)[\s\S]*<nav class="bottom-nav"[^>]*>\$\{destinations\.map\(navButton\)/u,
  'every permitted destination is rendered directly in the mobile navigation');
assert.match(app, /<nav class="side-nav" aria-label="Navegação principal">\$\{orderedDestinations\(allowed\)\.map\(navButton\)/u,
  'desktop navigation keeps the same direct destination list');
assert.doesNotMatch(app, /nav-more|Mais destinos|closeMoreMenu|bindMoreMenu|rotaMotoMoreMenu/u,
  'the grouped More disclosure and its history handlers are removed');
assert.match(app, /active&&nav\)[\s\S]*nav\.scrollLeft=right-nav\.clientWidth/u,
  'the active destination remains visible after navigation');
assert.match(css, /\.bottom-nav\{[^}]*overflow-x:auto;[^}]*touch-action:pan-x/u,
  'the mobile bar supports horizontal touch scrolling');
assert.match(css, /\.bottom-nav>\.nav-item\{flex:1 0 82px;min-width:82px;max-width:none/u,
  'navigation items grow evenly when they fit and keep equal minimum widths when they do not');
assert.match(designSystem, /\.bottom-nav>\.nav-item\{flex:1 0 82px;min-width:82px;max-width:none/u,
  'the responsive design system preserves the same distribution rule');
assert.match(app, /<h1 aria-label="\$\{esc\(title\)\}">/u,
  'compact page titles retain their complete accessible name');
assert.match(designSystem, /grid-template-columns:auto minmax\(0,1fr\) auto;grid-template-areas:none/u,
  'the 430px header uses one horizontal row');
assert.match(designSystem, /\.topbar-title-compact\{display:none\}/u,
  'desktop header renders only one title variant');
assert.match(designSystem, /\.top-actions \.btn\{flex:0 0 40px;width:40px;min-width:40px;max-width:40px/u,
  'header actions remain touch sized and icon compact on narrow phones');
assert.match(identity, /rm-account-trigger-icon/u);
assert.match(identity, /aria-label', offlineMode \? 'Abrir conta; modo local, sem sessão autenticada'/u,
  'the local-data action keeps an explicit accessible label');
assert.match(identityCss, /\.rm-account-trigger-icon \{ display: none/u,
  'the account icon is available for compact header presentation');

console.log('Restaurant direct navigation, single-row header and compact accessible actions: PASS');
