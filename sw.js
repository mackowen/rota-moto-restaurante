'use strict';

const CACHE_PREFIX = 'rotamoto-restaurante-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v17`;
const APP_SHELL = Object.freeze([
  '/', '/index.html', '/styles.css?v=0140.2', '/identity-ui.css', '/design-system.css?v=0140.2', '/pilot-views.css?v=0140.1', '/favicon.svg',
  '/qr-local.js', '/ifood-integration.js', '/keeta-integration.js', '/99food-integration.js',
  '/contract.js', '/backup-format.js?v=1', '/sync-reconciliation.js?v=1',
  '/indexeddb-schema.js?v=2', '/order-money.js?v=1', '/ticket-renderer.js?v=1',
  '/browser-printer-provider.js?v=1', '/restaurant-operations.js?v=2',
  '/analytics.js?v=2', '/analytics-view.js?v=1', '/logistics-ui.js?v=1',
  '/identity-session-guard.js', '/app.js?v=0140.2', '/identity-ui.js?v=0140.1',
  '/vendor/leaflet/leaflet.css', '/vendor/maplibre/maplibre-gl.css?v=0139.1', '/vendor/maplibre/rotamoto-map-runtime.js?v=0140.2', '/vendor/maplibre/maplibre-gl-worker.js?v=0139.1', '/vendor/leaflet/leaflet.js'
]);
const OPTIONAL_ASSETS = new Set([
  '/vendor/maplibre/maplibre-gl.css?v=0139.1',
  '/vendor/maplibre/rotamoto-map-runtime.js?v=0140.2',
  '/vendor/maplibre/maplibre-gl-worker.js?v=0139.1'
]);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const results = await Promise.allSettled(APP_SHELL.map(async path => {
      const request = new Request(new URL(path, self.location.origin), { cache: 'reload' });
      const response = await fetch(request);
      if (!response.ok) throw new Error(`App shell asset returned HTTP ${response.status}`);
      await cache.put(request, response);
    }));
    const requiredFailures = results.filter((result, index) =>
      result.status === 'rejected' && !OPTIONAL_ASSETS.has(APP_SHELL[index]));
    if (requiredFailures.length) throw new Error(`Required app shell assets failed: ${requiredFailures.length}`);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) return response;
      } catch (_) {}
      return (await caches.match('/index.html')) || Response.error();
    })());
    return;
  }

  const isShellAsset = APP_SHELL.some(path => new URL(path, self.location.origin).pathname === url.pathname);
  if (!isShellAsset) return;
  event.respondWith((async () => (await caches.match(request)) || fetch(request))());
});
