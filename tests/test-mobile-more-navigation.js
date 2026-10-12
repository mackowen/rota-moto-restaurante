'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const designSystem = fs.readFileSync(path.join(root, 'design-system.css'), 'utf8');

assert.match(app, /function closeMoreMenu\(\)[\s\S]*menu\.open=false/u,
  'More menu has one explicit close operation');
assert.match(app, /function goTab\(tab\)[\s\S]*closeMoreMenu\(\)/u,
  'choosing any destination closes More before rendering its screen');
assert.match(app, /document\.addEventListener\('click',event=>\{const menu=document\.querySelector\('\.nav-more'\);if\(menu\?\.open&&!menu\.contains\(event\.target\)\)closeMoreMenu\(\)\},true\)/u,
  'clicking outside the More disclosure closes it');
assert.match(app, /event\.key==='Escape'[\s\S]*closeMoreMenu\(\)/u,
  'Escape closes More');
assert.match(app, /window\.addEventListener\('popstate'[\s\S]*menu\.open=false/u,
  'browser Back closes More without changing the selected module');
assert.match(app, /function bindMoreMenu\(\)[\s\S]*history\.pushState[\s\S]*rotaMotoMoreMenu/u,
  'opening More adds a reversible history entry so Android/browser Back can dismiss it');
assert.match(css, /\.nav-more\s*\{[^}]*flex:\s*0 0 82px;[^}]*min-width:\s*82px/u,
  'More uses the same fixed-width touch slot as the other destinations');
assert.match(css, /\.nav-more summary\s*\{[^}]*width:\s*100%/u,
  'More touch target fills its navigation slot');
assert.match(css, /\.bottom-nav\{[^}]*overflow-x:auto;[^}]*touch-action:pan-x/u,
  'bottom navigation remains horizontally scrollable by touch');
assert.match(css, /\.nav-more-menu\{position:fixed;[^}]*max-height:min\(60dvh,480px\)/u,
  'More popover is positioned outside the clipped horizontal scroll area');
assert.match(designSystem, /\.bottom-nav\{display:flex;[^}]*overflow-x:auto/u,
  'the later loaded design system preserves the horizontal navigation model');
assert.match(app, /if\(right>nav\.scrollLeft\+nav\.clientWidth\)nav\.scrollLeft=right-nav\.clientWidth/u,
  'selected mobile destination is automatically brought into view');
assert.match(app, /<img class="brand-logo" src="favicon\.svg" alt="">/u,
  'shared page header uses the existing RotaMoto logo asset');

console.log('Restaurant More menu navigation, outside dismissal, Back and touch target: PASS');
