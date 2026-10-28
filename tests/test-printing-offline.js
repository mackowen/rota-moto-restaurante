'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const assetManifest = require('./helpers/asset-manifest').readAssetManifest();

const source = fs.readFileSync(require.resolve('../sw.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const appBundle = html.match(/<script[^>]+src=["'](app\.js(?:\?v=[^"']+)?)['"]/u)?.[1];
const identityBundle = html.match(/<script[^>]+src=["'](identity-ui\.js(?:\?v=[^"']+)?)['"]/u)?.[1];
assert.ok(appBundle, 'index.html declares the current app bundle');
const activeCacheName = assetManifest.cacheName;
assert.ok(activeCacheName, 'service worker imports the content-versioned active cache manifest');
const handlers = {};
const added = [];
const matched = [];
const deleted = [];
const optionalMissing = new Set(assetManifest.optional.map(asset => { const url = new URL(asset, 'http://localhost:8788/'); return url.pathname + url.search; }));
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
const context = {
  self, caches, URL, Request, Response, Promise,
  importScripts() { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'asset-manifest.js'), 'utf8'), context); },
  fetch: async request => {
    if (offline) throw new Error('offline');
    const url = new URL(request.url);
    const key = url.pathname + url.search;
    return { ok: !optionalMissing.has(key), status: optionalMissing.has(key) ? 404 : 200 };
  }
};
vm.createContext(context);
vm.runInContext(source, context);

assert.equal(typeof handlers.install, 'function');
let installed;
handlers.install({ waitUntil(promise) { installed = promise; } });
installed.then(async () => {
  assert.ok(added.includes('/index.html'));
  for(const name of ['ticket-renderer.js','browser-printer-provider.js','design-system.css','pilot-views.css','app.js','dashboard-v2.js','dashboard-v2.css','server-update-coordinator.js']){
    const asset=assetManifest.assets.find(item=>item.includes(`/${name}?v=`));
    assert(asset,`manifest includes ${name}`);
    const url=new URL(asset,'http://localhost:8788/');
    assert(added.includes(url.pathname+url.search),`offline shell caches ${name}`);
  }
  assert.ok(added.includes(`/${appBundle}`), `offline shell includes current bundle ${appBundle}`);
  assert.ok(identityBundle, 'identity UI bundle is declared by the page');
  assert.ok(added.includes(`/${identityBundle}`));
  const optionalWorker = assetManifest.optional.find(asset=>asset.includes('maplibre-gl-worker.js'));
  const optionalWorkerUrl=new URL(optionalWorker,'http://localhost:8788/');
  assert.ok(!added.includes(optionalWorkerUrl.pathname+optionalWorkerUrl.search), 'missing optional map asset does not prevent app shell installation');
  assert.match(html, /serviceWorker\.register\('\/sw\.js'/);

  let activated;
  handlers.activate({ waitUntil(promise) { activated = promise; } });
  await activated;
  assert.deepEqual(deleted, [activeCacheName, 'rotamoto-restaurante-shell-old']);

  let apiResponded = false;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/api/identity/session', mode: 'cors' }, respondWith() { apiResponded = true; } });
  assert.equal(apiResponded, false, 'authenticated API responses stay outside the cache');

  let appResponse;
  offline = true;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/index.html', mode: 'navigate' }, respondWith(promise) { appResponse = promise; } });
  assert.equal(await appResponse, 'cached:/index.html', 'offline navigation falls back to the app shell');

  let assetResponse;
  const ticketAsset=assetManifest.assets.find(asset=>asset.includes('/ticket-renderer.js?v='));
  handlers.fetch({ request: { method: 'GET', url: new URL(ticketAsset,'http://localhost:8788/').href, mode: 'no-cors' }, respondWith(promise) { assetResponse = promise; } });
  assert.equal(await assetResponse, 'cached:/ticket-renderer.js', 'ticket renderer is served from the offline shell cache');
  console.log('Restaurant print offline shell and API cache exclusion passed');
}).catch(error => { console.error(error); process.exitCode = 1; });
