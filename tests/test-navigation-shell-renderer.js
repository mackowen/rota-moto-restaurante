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

for (const [id, label] of [
  ['dashboard','Visão geral'], ['orders','Pedidos e entregas'], ['routes','Rotas'],
  ['bikes','Motoboys'], ['reports','Relatórios'], ['events','Eventos'],
  ['settings','Configurações'], ['admin','Administração'],
  ['integrationLab','Laboratório de integrações'], ['help','Ajuda']
]) {
  const rendered = context.render([id,'grid',label], '');
  assert.equal((rendered.match(/class="nav-label"/gu)||[]).length, 1, `${label} renders one sidebar label`);
  assert(rendered.includes(`<span class="nav-label">${label}</span>`), `${label} remains available in the expanded sidebar`);
}

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
assert.match(ordersCss, /\.orders-v2-card-list\{display:grid/u, 'Orders uses one standalone operational card per item');
assert.match(ordersCss, /@container orders-v2-list \(min-width:640px\)/u, 'card fields reorganize from the card container width');
assert.match(ordersCss, /@container orders-v2-page \(min-width:1120px\)[\s\S]*?\.orders-v2-workspace\{grid-template-columns:minmax\(0,1fr\) minmax\(250px,28%\)\}/u, 'wide Orders uses available space for the list and non-order operational metrics');
assert.doesNotMatch(ordersCss, /orders-v2-selection|orders-v2-detail/u, 'the permanent duplicate-order panel styles are removed');
assert.doesNotMatch(source, /ordersV2Selection|ordersV2DetailPanel/u, 'selection no longer renders a second persistent copy of a pedido');
assert.match(source, /function bindOrdersV2Actions[\s\S]*openDetail\(button\.dataset\.ordersOpen\)/u, 'the visible primary action delegates to the existing full-detail flow');
assert.match(source, /data-orders-print[\s\S]*openPrintPreview\(button\.dataset\.ordersPrint\)/u, 'the compact print action retains the existing print preview');
console.log('Single-label navigation, collapse contract and desktop Orders workspace: PASS');
