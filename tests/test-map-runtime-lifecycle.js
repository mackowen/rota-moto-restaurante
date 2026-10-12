'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function runtime({ webgl = false } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  const allLayers = [];
  class Node {
    constructor() { this.className = ''; this.dataset = {}; this.children = []; this.hidden = true; this.handlers = {}; this.attributes = {}; }
    get classList() { return { contains: value => this.className.split(/\s+/u).includes(value) }; }
    setAttribute(key, value) { this.attributes[key] = value; }
    replaceChildren() { this.children = []; }
    append(child) { this.children.push(child); }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    insertAdjacentElement(_where, node) { this.nextElementSibling = node; }
  }
  class Layer {
    constructor(mode, url = '') { this.mode = mode; this.url = url; this.handlers = new Map(); this.removed = false; this.loading = false; this.opacity = 1; this.errors = 0; this.loadedTiles = 0; this.renderer = mode === 'vector' ? new Renderer() : null; allLayers.push(this); }
    on(type, handler) { const list = this.handlers.get(type) || []; list.push({ handler, once: false }); this.handlers.set(type, list); return this; }
    once(type, handler) { const list = this.handlers.get(type) || []; list.push({ handler, once: true }); this.handlers.set(type, list); return this; }
    fire(type, value = {}) { if (type === 'load') this.loading = false; const list = this.handlers.get(type) || []; for (const item of [...list]) { item.handler(value); if (item.once) this.handlers.set(type, (this.handlers.get(type) || []).filter(candidate => candidate !== item)); } }
    addTo(map) { this.loading = true; map.layers.add(this); return this; }
    isLoading() { return this.loading; }
    setOpacity(value) { this.opacity = value; return this; }
    getMaplibreMap() { return this.renderer; }
  }
  class Renderer {
    constructor() { this.handlers = new Map(); this.ready = false; this.canvasHandlers = {}; this.canvas = { addEventListener: (type, fn) => { this.canvasHandlers[type] = fn; }, getContext: () => ({ isContextLost: () => false }) }; }
    on(type, fn) { const list = this.handlers.get(type) || []; list.push(fn); this.handlers.set(type, list); }
    fire(type, value = {}) { for (const fn of this.handlers.get(type) || []) fn(value); }
    getCanvas() { return this.canvas; }
    getStyle() { return { sources: { streets: {} }, layers: [{ id: 'roads' }] }; }
    isStyleLoaded() { return this.ready; }
    areTilesLoaded() { return this.ready; }
    loaded() { return this.ready; }
    isSourceLoaded() { return this.ready; }
  }
  const anchor = new Node();
  const map = {
    layers: new Set(), removed: [],
    attributionControl: { values: new Set(), addAttribution(value) { this.values.add(value); }, removeAttribution(value) { this.values.delete(value); } },
    getContainer: () => ({ closest: () => anchor }),
    hasLayer(layer) { return this.layers.has(layer); },
    removeLayer(layer) { layer.removed = true; this.layers.delete(layer); this.removed.push(layer); },
    view: { center: [1, 2], zoom: 9 }
  };
  const window = { dispatchEvent() {}, addEventListener() {}, L: null };
  const document = { baseURI: 'http://localhost/', documentElement: { dataset: { resolvedTheme: 'light' } }, createElement: tag => tag === 'canvas' ? { getContext: kind => webgl && kind === 'webgl2' ? {} : null } : new Node() };
  const L = { tileLayer: url => new Layer('raster', url) };
  const source = fs.readFileSync(path.join(__dirname, '..', 'map-runtime.js'), 'utf8')
    .replace(/^import .*;\s*$/gmu, '')
    .replace(/^setWorkerUrl\(.*\);\s*$/gmu, '');
  const context = {
    window, document, L, maplibreGL: () => new Layer('vector'), setWorkerUrl() {}, URL,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    console: { warn() {}, error() {} },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay, active: true }); return id; },
    clearTimeout(id) { if (timers.has(id)) timers.get(id).active = false; },
    Map, Boolean, Object, String, Number, Math, Set, Array, Error
  };
  vm.runInNewContext(source, context, { filename: 'map-runtime.js' });
  const runTimer = (id, evenIfCancelled = false) => { const timer = timers.get(id); if (timer && (timer.active || evenIfCancelled)) timer.fn(); };
  const runTimersWithDelay = delay => { for (const [id, timer] of timers) if (timer.delay === delay && timer.active) runTimer(id); };
  return { map, window, allLayers, timers, runTimer, runTimersWithDelay, getStatus: () => anchor.nextElementSibling, state: () => window.RotaMotoMapTheme.inspect(map) };
}

{
  const test = runtime();
  const first = test.window.RotaMotoMapTheme.addBaseLayer(test.map);
  first.fire('tileload'); first.fire('load');
  assert.equal(test.state().ready, true, 'map readiness requires a successful raster tile');
  assert.equal(test.map.layers.has(first), true);
  assert.equal(test.getStatus().hidden, true);
  first.fire('tileerror');
  assert.equal(test.map.layers.has(first), true, 'a later tile error cannot remove the working layer');
  assert.equal(test.getStatus().dataset.state, 'fallback');
  assert.equal(test.getStatus().children.at(-1).textContent, 'Tentar novamente');
  test.window.RotaMotoMapTheme.setTheme('dark');
  assert.equal(test.map.layers.has(first), true, 'theme change preserves the raster layer and current map view');
  const darkCandidate = test.allLayers.at(-1);
  assert.match(darkCandidate.url, /basemaps\.cartocdn\.com\/dark_all/u, 'dark mode requests a dark raster basemap');
  assert.equal(test.map.layers.has(darkCandidate), true, 'dark layer is prepared while the valid light map remains visible');
  darkCandidate.fire('tileerror'); darkCandidate.fire('load');
  assert.equal(test.map.layers.has(first), true, 'failed theme update cannot remove the previously usable cartography');
  assert.equal(test.state().ready, true);
  test.runTimersWithDelay(0);
  assert.equal(test.map.layers.has(darkCandidate), false, 'failed layer is removed after its tile event finishes');
  assert.deepEqual(test.map.view, { center: [1, 2], zoom: 9 });
}

{
  const test = runtime();
  const light = test.window.RotaMotoMapTheme.addBaseLayer(test.map);
  light.fire('tileload'); light.fire('load');
  test.window.RotaMotoMapTheme.setTheme('dark');
  const dark = test.allLayers.at(-1);
  dark.fire('tileload'); dark.fire('load');
  assert.equal(test.map.layers.has(dark), true, 'new theme commits after real tile readiness');
  assert.equal(test.map.layers.has(light), true, 'old theme remains through the replacement tile event');
  test.runTimersWithDelay(0);
  assert.equal(test.map.layers.has(light), false, 'old theme is removed after the tile event finishes');
  assert.equal(test.state().mode, 'raster');
}

{
  const test = runtime();
  const first = test.window.RotaMotoMapTheme.addBaseLayer(test.map);
  first.fire('tileerror'); first.fire('load');
  assert.equal(test.state().ready, false);
  assert.equal(test.getStatus().dataset.state, 'error', 'an initial failed load is distinct from an update failure');
  test.runTimersWithDelay(0);
  assert.equal(test.map.layers.has(first), false);
  test.window.RotaMotoMapTheme.retry(test.map);
  const recovered = test.allLayers.at(-1);
  recovered.fire('tileload'); recovered.fire('load');
  assert.equal(test.state().ready, true, 'one successful retry recovers the map');
  assert.equal(test.getStatus().hidden, true);
}

{
  const test = runtime();
  const original = test.window.RotaMotoMapTheme.addBaseLayer(test.map);
  original.fire('tileload'); original.fire('load');
  const oldTimerId = [...test.timers.entries()].find(([, timer]) => timer.delay === 15000)?.[0];
  test.window.RotaMotoMapTheme.retry(test.map);
  const obsolete = test.allLayers.at(-1);
  const obsoleteTimer = [...test.timers.entries()].filter(([, timer]) => timer.delay === 15000).at(-1)[0];
  test.window.RotaMotoMapTheme.retry(test.map);
  const current = test.allLayers.at(-1);
  current.fire('tileload'); current.fire('load');
  test.runTimer(obsoleteTimer, true);
  test.runTimer(oldTimerId, true);
  obsolete.fire('load');
  test.runTimersWithDelay(0);
  assert.equal(test.window.RotaMotoMapTheme.inspect(test.map).generation > 0, true);
  assert.equal(test.state().ready, true);
  assert.equal(test.map.layers.has(current), true);
  assert.equal(test.map.layers.has(original), false);
  assert.equal(test.map.layers.has(obsolete), false, 'retry removes the superseded candidate');
  assert.equal(test.getStatus().hidden, true, 'obsolete timers cannot turn a successful map into an error');
}

{
  const test = runtime({ webgl: true });
  const first = test.window.RotaMotoMapTheme.addBaseLayer(test.map);
  first.renderer.ready = true;
  first.renderer.fire('load');
  assert.equal(test.state().ready, true, 'vector style, sources and tiles must all be ready');
  first.renderer.fire('error', { error: new Error('transient tile failure') });
  assert.equal(test.map.layers.has(first), true, 'transient post-load vector errors preserve the active renderer');
  assert.equal(test.state().mode, 'vector');
  assert.equal(test.getStatus().dataset.state, 'fallback');
}

{
  const test = runtime();
  const first = test.window.RotaMotoMapTheme.addBaseLayer(test.map);
  first.fire('tileerror'); first.fire('load');
  test.runTimersWithDelay(0);
  assert.equal(test.getStatus().dataset.state, 'error', 'total provider failure stays visible and retryable');
  test.window.RotaMotoMapTheme.retry(test.map);
  const second = test.allLayers.at(-1);
  second.fire('tileerror'); second.fire('load');
  test.runTimersWithDelay(0);
  assert.equal(test.getStatus().dataset.state, 'error');
  assert.equal(test.state().ready, false);
}

console.log('Map runtime lifecycle: initial success/failure, post-load tile errors, stale retries/timeouts, themes and recovery PASS');
