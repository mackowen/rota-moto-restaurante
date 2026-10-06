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
const cache = {
  async addAll(paths) { added.push(...paths); },
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
vm.runInNewContext(source, { self, caches, URL, fetch: async () => { throw new Error('offline'); }, Response, Promise });

assert.equal(typeof handlers.install, 'function');
let installed;
handlers.install({ waitUntil(promise) { installed = promise; } });
installed.then(async () => {
  assert.ok(added.includes('/index.html'));
  assert.ok(added.includes('/ticket-renderer.js?v=1'));
  assert.ok(added.includes('/browser-printer-provider.js?v=1'));
  assert.ok(added.includes('/app.js?v=40.2'));
  assert.match(html, /serviceWorker\.register\('\/sw\.js'/);

  let activated;
  handlers.activate({ waitUntil(promise) { activated = promise; } });
  await activated;
  assert.deepEqual(deleted, ['rotamoto-restaurante-shell-old']);

  let apiResponded = false;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/api/identity/session', mode: 'cors' }, respondWith() { apiResponded = true; } });
  assert.equal(apiResponded, false, 'authenticated API responses stay outside the cache');

  let appResponse;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/index.html', mode: 'navigate' }, respondWith(promise) { appResponse = promise; } });
  assert.equal(await appResponse, 'cached:/index.html', 'offline navigation falls back to the app shell');

  let assetResponse;
  handlers.fetch({ request: { method: 'GET', url: 'http://localhost:8788/ticket-renderer.js?v=1', mode: 'no-cors' }, respondWith(promise) { assetResponse = promise; } });
  assert.equal(await assetResponse, 'cached:/ticket-renderer.js', 'ticket renderer is served from the offline shell cache');
  console.log('Restaurant print offline shell and API cache exclusion passed');
}).catch(error => { console.error(error); process.exitCode = 1; });
