'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8');
const navStart = source.indexOf('function navButton(');
const navEnd = source.indexOf('function orderedDestinations(', navStart);
const navButton = navStart >= 0 && navEnd > navStart ? source.slice(navStart, navEnd).trim() : null;
assert(navButton, 'navigation button renderer is available');
const context = {state:{tab:'dashboard',settingsOpen:''},icon:name=>`<svg data-icon="${name}"></svg>`};
vm.runInNewContext(`${navButton}\nthis.render=navButton;`, context);

const item = ['dashboard','grid','Visão geral'];
const sidebar = context.render(item, '');
const bottom = context.render(item, 'nav-primary-item');
assert.equal((sidebar.match(/class="nav-label"/gu)||[]).length, 1, 'sidebar item contains one visual label');
assert.match(sidebar, /<span class="nav-label">Visão geral<\/span>/u, 'expanded navigation uses the full module name once');
assert.match(sidebar, /aria-label="Visão geral" title="Visão geral"/u, 'collapsed icon retains the accessible name and tooltip');
assert.equal((bottom.match(/class="nav-label"/gu)||[]).length, 1, 'mobile item contains one visual label');
assert.match(bottom, /<span class="nav-label">Início<\/span>/u, 'mobile navigation uses its approved concise label');
assert.match(bottom, /aria-current="page"/u, 'active destination remains programmatically indicated');

const toggleStart = source.indexOf('function bindSidebarToggle(');
const toggleEnd = source.indexOf('function navigationGroups(', toggleStart);
assert(toggleStart >= 0 && toggleEnd > toggleStart, 'sidebar toggle binding is separately testable');
const classes = new Set(['shell']);
const attributes = {};
const button = {onclick:null,title:'',setAttribute(name,value){attributes[name]=value}};
const persisted = {};
const toggleContext = {
  document:{querySelector(selector){return selector==='[data-sidebar-toggle]'?button:{classList:{contains:name=>classes.has(name),toggle(name,value){value?classes.add(name):classes.delete(name)}}}}},
  localStorage:{setItem(key,value){persisted[key]=value}}
};
vm.runInNewContext(`${source.slice(toggleStart,toggleEnd).trim()}\nbindSidebarToggle();`,toggleContext);
button.onclick();
assert(classes.has('sidebar-collapsed'),'first activation collapses the sidebar');
assert.equal(attributes['aria-expanded'],'false');
assert.equal(button.title,'Expandir menu');
assert.equal(persisted['rotamoto.sidebar.collapsed'],'true');
button.onclick();
assert(!classes.has('sidebar-collapsed'),'second activation expands the sidebar');
assert.equal(attributes['aria-expanded'],'true');
assert.equal(persisted['rotamoto.sidebar.collapsed'],'false');

const sourceCss = fs.readFileSync('design-system.css', 'utf8');
const ordersCss = fs.readFileSync('orders-v2.css', 'utf8');
assert.match(sourceCss, /\.shell\.sidebar-collapsed\{grid-template-columns:76px/u, 'collapsed sidebar has a defined narrow grid track');
assert.match(sourceCss, /@media\(min-width:1024px\)[\s\S]*?\.sidebar-toggle\{display:grid/u, 'desktop navigation exposes the collapse control');
assert.match(ordersCss, /@media\(min-width:1180px\)[\s\S]*?\.orders-v2-side\{grid-column:2;grid-row:1\}/u, 'wide Orders retains a visible list and detail workspace');
assert.match(ordersCss, /@media\(min-width:1180px\)[\s\S]*?\.orders-v2-selection\{display:block\}/u, 'wide Orders shows the selected order details beside the list');
assert.match(source, /orders-v2-side[\s\S]*?id="ordersV2Selection"[\s\S]*?orders-v2-metrics/u, 'Orders prioritizes selected-order details before summary metrics in the desktop panel');
assert.doesNotMatch(ordersCss, /@media\(min-width:1024px\) and \(max-width:1340px\)[\s\S]{0,180}\.orders-v2-side\{display:none\}/u, 'desktop Orders has no later rule that hides its details panel');
console.log('Single-label navigation, collapse contract and desktop Orders workspace: PASS');
