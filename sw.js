'use strict';

const CACHE_PREFIX = 'rotamoto-restaurante-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v99`;
const APP_SHELL = Object.freeze([
  '/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/styles.css?v=0302.1', '/identity-ui.css?v=0256d1.1', '/design-system.css?v=0303.1', '/pilot-views.css?v=0299.1', '/favicon.svg?v=0140.1', '/dashboard-v2.css?v=0304.4', '/orders-v2.css?v=0303.1', '/routes-v2.css?v=0304.1', '/dashboard-v2.js?v=0304.2',
  '/qr-local.js', '/ifood-integration.js', '/keeta-integration.js', '/99food-integration.js',
  '/contract.js', '/backup-format.js?v=1', '/backup-center.css?v=0231.1', '/backup-destinations-ui.js?v=0231.1', '/sync-reconciliation.js?v=2',
  '/indexeddb-schema.js?v=2', '/order-money.js?v=1', '/ticket-renderer.js?v=0256d1.1',
  '/browser-printer-provider.js?v=1', '/restaurant-operations.js?v=2',
  '/analytics.js?v=2', '/analytics-view.js?v=0254.1', '/logistics-ui.js?v=0254.1',
  '/identity-session-guard.js', '/server-update-coordinator.js?v=0253.1', '/company-settings-persistence.js?v=0286.1', '/app.js?v=0304.1', '/identity-ui.js?v=0288.1',
  '/vendor/leaflet/leaflet.css', '/vendor/maplibre/maplibre-gl.css?v=0139.1', '/vendor/maplibre/rotamoto-map-runtime.js?v=0140.10', '/vendor/maplibre/maplibre-gl-worker.js?v=0139.1', '/vendor/leaflet/leaflet.js'
]);
const OPTIONAL_ASSETS = new Set([
  '/vendor/maplibre/maplibre-gl.css?v=0139.1',
  '/vendor/maplibre/maplibre-gl-worker.js?v=0139.1'
]);
const shellURLs = new Set(APP_SHELL.map(path => new URL(path, self.location.origin).href));
const optionalURLs = new Set([...OPTIONAL_ASSETS].map(path => new URL(path, self.location.origin).href));

async function stageShell() {
  await caches.delete(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  try {
    const fetched = await Promise.all(APP_SHELL.map(async path => {
      const request = new Request(new URL(path, self.location.origin), { cache: 'reload' });
      const response = await fetch(request);
      if (!response.ok || response.type === 'opaque' || (response.redirected && new URL(response.url).origin !== self.location.origin)) throw new Error(`shell asset unavailable (${response.status})`);
      return { request, response };
    }).map(promise => promise.catch(error => ({ error }))));
    const failedRequired = fetched.filter((result, index) => result.error && !optionalURLs.has(new URL(APP_SHELL[index], self.location.origin).href));
    if (failedRequired.length) throw new Error(`required shell assets unavailable (${failedRequired.length})`);
    await Promise.all(fetched.filter(result => !result.error).map(({ request, response }) => cache.put(request, response)));
    fetched.forEach((result, index) => {
      if (result.error && optionalURLs.has(new URL(APP_SHELL[index], self.location.origin).href)) {
        console.warn('Optional offline asset unavailable:', new URL(APP_SHELL[index], self.location.origin).pathname);
      }
    });
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await stageShell();
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

  if (!shellURLs.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    return (await cache.match(request)) || fetch(request);
  })().catch(() => new Response('', { status: 503, statusText: 'Offline asset unavailable', headers: { 'Cache-Control': 'no-store' } })));
});
