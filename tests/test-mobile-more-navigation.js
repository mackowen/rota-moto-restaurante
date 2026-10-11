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
assert.match(css, /\.nav-more\s*\{[^}]*min-width:\s*0/u,
  'More grid item is allowed to use the full fixed bottom-navigation slot');
assert.match(css, /\.nav-more summary\s*\{[^}]*width:\s*100%/u,
  'More touch target fills its navigation slot');
assert.ok(designSystem.includes('.bottom-nav{display:grid;grid-template-columns:repeat(6,minmax(0,1fr))'),
  'the later loaded design system preserves six equal destinations instead of overriding the mobile nav as flex');

console.log('Restaurant More menu navigation, outside dismissal, Back and touch target: PASS');
