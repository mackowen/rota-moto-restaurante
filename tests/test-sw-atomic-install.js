'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function createWorker(options = {}) {
  const listeners = new Map();
  const stores = new Map();
  const origin = 'https://restaurante.test';
  const cacheApi = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async put(request, response) { entries.set(request.url, response); },
        async match(request) { return entries.get(typeof request === 'string' ? new URL(request, origin).href : request.url); }
      };
    },
    async delete(name) { return stores.delete(name); },
    async keys() { return [...stores.keys()]; }
  };
  const context = {
    URL, Request, Response, Promise, Set, Object, Error, console,
    caches: cacheApi,
    self: { location: { origin, href: `${origin}/sw.js` }, async skipWaiting() {}, clients: { async claim() {} }, addEventListener(name, listener) { listeners.set(name, listener); } },
    async fetch(request) {
      const url = new URL(request.url);
      if (options.failUrl === url.href) return new Response('missing', { status: options.status || 404 });
      return new Response(`asset:${url.pathname}${url.search}`, { status: 200 });
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'), 'utf8'), context, { filename: 'sw.js' });
  return { listeners, stores, origin };
}

async function fire(listener, event = {}) {
  let pending;
  listener({ ...event, waitUntil(promise) { pending = promise; } });
  if (pending) await pending;
  return event;
}

(async () => {
  const healthy = await createWorker({ failUrl: 'https://restaurante.test/vendor/maplibre/maplibre-gl-worker.js?v=0139.1' });
  await fire(healthy.listeners.get('install'));
  assert.equal(healthy.stores.size, 1, 'one complete versioned cache is staged');
  const [cacheName] = [...healthy.stores.keys()];
  assert.match(cacheName, /v57$/u);
  assert([...healthy.stores.get(cacheName).keys()].some(url => url.includes('identity-ui.js?v=0255.2')),
    'current shell stages the versioned identity UI');
  assert([...healthy.stores.get(cacheName).keys()].some(url => url.includes('analytics-view.js?v=0254.1')), 'report renderer is versioned in the shell');
  assert.equal([...healthy.stores.get(cacheName).keys()].some(url => url.includes('maplibre-gl-worker.js')), false,
    'missing optional cartography worker does not block or enter the shell');

  const failed = await createWorker({ failUrl: 'https://restaurante.test/app.js?v=0255.1' });
  failed.stores.set('rotamoto-restaurante-shell-v17', new Map([['sentinel', new Response('old-shell')]]));
  await assert.rejects(fire(failed.listeners.get('install')), /required shell assets unavailable/u);
  assert.deepEqual([...failed.stores.keys()], ['rotamoto-restaurante-shell-v17'], 'failed update removes only its staged cache and retains the active shell');

  const fetchEvent = { request: new Request('https://restaurante.test/styles.css?v=0140.99'), respondWith() { throw new Error('unmanifested URL was intercepted'); } };
  await fire(healthy.listeners.get('fetch'), fetchEvent);
  const exactEvent = { request: new Request('https://restaurante.test/styles.css?v=0254.1'), response: null, respondWith(promise) { exactEvent.response = promise; } };
  await fire(healthy.listeners.get('fetch'), exactEvent);
  assert.ok(exactEvent.response, 'full manifest URL is handled');
  assert.equal(await (await exactEvent.response).text(), 'asset:/styles.css?v=0254.1', 'exact asset is served from the staged cache');
  const apiEvent = { request: new Request('https://restaurante.test/api/sync/push'), respondWith() { throw new Error('API must bypass shell cache'); } };
  await fire(healthy.listeners.get('fetch'), apiEvent);
  console.log('Restaurant service worker atomic installation and exact URL matching: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
