'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../sw.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const handlers = {};
const added = [];
const matched = [];
const deleted = [];
const optionalMissing = new Set([
  '/vendor/maplibre/maplibre-gl.css?v=0139.1',
  '/vendor/maplibre/maplibre-gl-worker.js?v=0139.1',
  '/vendor/maplibre/maplibre-gl-worker.js?v=0139.1'
]);
let offline = false;
const cache = {
  async put(request) { const url = new URL(request.url); added.push(url.pathname + url.search); },
  async match(request) { matched.push(typeof request === 'string' ? request : new URL(request.url).pathname); return `cached:${typeof request === 'string' ? request : new URL(request.url).pathname}`; }
};
const self = {
  location: { origin: 'http://localhost:8788' },
  clients: { async claim() {} },
  async skipWaiting() {},
  addEventListener(type, handler) { handlers[type] = handler; }
};
const caches = {
  async open() { return cache; },
  async keys() { return ['rotamoto-restaurante-shell-old', 'unrelated-cache']; },
  async delete(name) { deleted.push(name); return true; },
  async match(request) { return cache.match(request); }
};
vm.runInNewContext(source, {
  self, caches, URL, Request, Response, Promise,
  fetch: async request => {
    if (offline) throw new Error('offline');
    const url = new URL(request.url);
    const key = url.pathname + url.search;
    return { ok: !optionalMissing.has(key), status: optionalMissing.has(key) ? 404 : 200 };
  }
});

assert.equal(typeof handlers.install, 'function');
let installed;
handlers.install({ waitUntil(promise) { installed = promise; } });
installed.then(async () => {
  assert.ok(added.includes('/index.html'));
  assert.ok(added.includes('/ticket-renderer.js?v=0256d1.1'));
  assert.ok(added.includes('/browser-printer-provider.js?v=1'));
  assert.ok(added.includes('/app.js?v=0256d3.1'));
  assert.ok(added.includes('/design-system.css?v=0256d1.1'));
  assert.ok(added.includes('/identity-ui.js?v=0256d1.1'));
  assert.ok(added.includes('/server-update-coordinator.js?v=0253.1'));
  assert.ok(!added.includes('/vendor/maplibre/maplibre-gl-worker.js?v=0139.1'), 'missing optional map asset does not prevent app shell installation');
  assert.match(html, /serviceWorker\.register\('\/sw\.js'/);

  let activated;
  handlers.activate({ waitUntil(promise) { activated = promise; } });
  await activated;
  assert.deepEqual(deleted, ['rotamoto-restaurante-shell-v74', 'rotamoto-restaurante-shell-old']);

  let apiResponded = false;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/api/identity/session', mode: 'cors' }, respondWith() { apiResponded = true; } });
  assert.equal(apiResponded, false, 'authenticated API responses stay outside the cache');

  let appResponse;
  offline = true;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/index.html', mode: 'navigate' }, respondWith(promise) { appResponse = promise; } });
  assert.equal(await appResponse, 'cached:/index.html', 'offline navigation falls back to the app shell');

  let assetResponse;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/ticket-renderer.js?v=0256d1.1', mode: 'no-cors' }, respondWith(promise) { assetResponse = promise; } });
  assert.equal(await assetResponse, 'cached:/ticket-renderer.js', 'ticket renderer is served from the offline shell cache');
  console.log('Restaurant print offline shell and API cache exclusion passed');
}).catch(error => { console.error(error); process.exitCode = 1; });
