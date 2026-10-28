'use strict';

importScripts('/asset-manifest.js');
const CACHE_PREFIX = self.RotaMotoAssetManifest.cachePrefix;
const CACHE_NAME = self.RotaMotoAssetManifest.cacheName;
const APP_SHELL = Object.freeze(self.RotaMotoAssetManifest.assets);
const OPTIONAL_ASSETS = new Set(self.RotaMotoAssetManifest.optional);
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
