'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');

const MAX_POINTS = 64;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_DISTANCE_M = 5_000_000;

function normalizeBaseUrl(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch (_) { throw new Error('ROUTE_DISTANCE_URL inválida.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname.includes('..') || /\/route\/v1\/driving\/?$/u.test(url.pathname)) {
    throw new Error('ROUTE_DISTANCE_URL deve ser uma base HTTP(S) sem credenciais, query ou fragmento.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase()))
    throw new Error('ROUTE_DISTANCE_URL remoto deve usar HTTPS.');
  return url.toString().replace(/\/$/u, '');
}

function normalizedCoordinates(input) {
  if (!input || !Array.isArray(input.deliveryIds) || input.deliveryIds.length < 2 || input.deliveryIds.length > MAX_POINTS ||
      !input.coordinatesByDeliveryId || typeof input.coordinatesByDeliveryId !== 'object') return null;
  const points = [];
  for (const id of input.deliveryIds) {
    const point = input.coordinatesByDeliveryId[id];
    if (!point || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) ||
        point.latitude < -90 || point.latitude > 90 || point.longitude < -180 || point.longitude > 180) return null;
    points.push([Number(point.longitude.toFixed(6)), Number(point.latitude.toFixed(6))]);
  }
  return points;
}

async function readBoundedJson(response) {
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return { body:null, reason:'ROUTE_DISTANCE_CONTENT_TYPE_INVALID' };
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) return { body:null, reason:'ROUTE_DISTANCE_RESPONSE_TOO_LARGE' };
  if (!response.body || typeof response.body.getReader !== 'function') return { body:null, reason:'ROUTE_DISTANCE_RESPONSE_INVALID' };
  const reader = response.body.getReader();
  const chunks = []; let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); return { body:null, reason:'ROUTE_DISTANCE_RESPONSE_TOO_LARGE' }; }
    chunks.push(Buffer.from(item.value));
  }
  try { return { body:JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')), reason:null }; }
  catch (_) { return { body:null, reason:'ROUTE_DISTANCE_JSON_INVALID' }; }
}

function createOsrmRouteDistanceProvider({ baseUrl, version = null, timeoutMs = 2500, fetchImpl = globalThis.fetch,
  clock = () => new Date(), cacheTtlMs = 30_000, maxCacheEntries = 500 } = {}) {
  const endpoint = normalizeBaseUrl(baseUrl);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000 ||
      !Number.isInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 300_000 ||
      !Number.isInteger(maxCacheEntries) || maxCacheEntries < 0 || maxCacheEntries > 5_000 || typeof fetchImpl !== 'function')
    throw new TypeError('Invalid OSRM route distance configuration.');
  const configVersion = typeof version === 'string' && /^[A-Za-z0-9._-]{1,40}$/u.test(version) ? version : null;
  const providerId = 'osrm-route-v1';
  const configuration = endpoint ? crypto.createHash('sha256').update(`${endpoint}\0${configVersion || ''}`).digest('hex').slice(0, 24) : undefined;
  const cache = new Map();
  const result = (status, distanceM = null, reason = null, providerVersion = configVersion) => ({ status, distanceM,
    provenance: { kind: 'canonical', providerId, ...(providerVersion ? { version: providerVersion } : {}),
      ...(configuration ? { configuration } : {}), evaluatedAt: clock().toISOString() }, reason });
  return Object.freeze({ providerId, async calculateDistance(input) {
    if (!endpoint) return result('unavailable', null, 'ROUTE_DISTANCE_PROVIDER_NOT_CONFIGURED');
    const points = normalizedCoordinates(input);
    if (!points) return result('unknown', null, 'ROUTE_DISTANCE_COORDINATES_INVALID');
    const companyId = typeof input.companyId === 'string' ? input.companyId : '';
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([companyId, endpoint, configVersion, points])).digest('hex');
    const now = clock().getTime();
    const cached = cache.get(fingerprint);
    if (cached && cached.expiresAt > now) { cache.delete(fingerprint); cache.set(fingerprint, cached); return result('known', cached.distanceM, null, cached.version); }
    if (cached) cache.delete(fingerprint);
    const coordinates = points.map(([lon, lat]) => `${lon},${lat}`).join(';');
    const url = `${endpoint}/route/v1/driving/${coordinates}?overview=false&steps=false&alternatives=false`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error', signal: controller.signal });
      if (!response) return result('unavailable', null, 'ROUTE_DISTANCE_PROVIDER_UNAVAILABLE');
      const parsed=await readBoundedJson(response);
      if (!response.ok) {
        if (response.status === 400 && parsed.body?.code === 'NoRoute') return result('unavailable', null, 'ROUTE_DISTANCE_UNREACHABLE');
        return result('unavailable', null, response.status === 429 ? 'ROUTE_DISTANCE_RATE_LIMITED' :
          response.status >= 500 ? 'ROUTE_DISTANCE_HTTP_SERVER_ERROR' : 'ROUTE_DISTANCE_HTTP_ERROR');
      }
      if(parsed.reason)return result('unknown',null,parsed.reason);
      const body=parsed.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.code !== 'string')
        return result('unknown', null, 'ROUTE_DISTANCE_SCHEMA_INVALID');
      if (body.code === 'NoRoute') return result('unavailable', null, 'ROUTE_DISTANCE_UNREACHABLE');
      if (body.code !== 'Ok' || !Array.isArray(body.routes) || body.routes.length !== 1 || !body.routes[0] ||
          !Number.isFinite(body.routes[0].distance) || body.routes[0].distance < 0 || body.routes[0].distance > MAX_DISTANCE_M)
        return result('unknown', null, 'ROUTE_DISTANCE_SCHEMA_INVALID');
      if (body.data_version !== undefined && (typeof body.data_version !== 'string' || body.data_version.length > 40 || Number.isNaN(Date.parse(body.data_version))))
        return result('unknown', null, 'ROUTE_DISTANCE_SCHEMA_INVALID');
      const distanceM = Math.round(body.routes[0].distance);
      if (!Number.isSafeInteger(distanceM) || distanceM > MAX_DISTANCE_M) return result('unknown', null, 'ROUTE_DISTANCE_VALUE_INVALID');
      const providerVersion=body.data_version||configVersion;
      if (cacheTtlMs && maxCacheEntries) {
        cache.set(fingerprint, { distanceM, version:providerVersion, expiresAt: now + cacheTtlMs });
        while (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
      }
      return result('known', distanceM, null, providerVersion);
    } catch (_) { return result('unavailable', null, 'ROUTE_DISTANCE_PROVIDER_UNAVAILABLE'); }
    finally { clearTimeout(timer); }
  }, cacheStats() { return Object.freeze({ entries: cache.size }); } });
}

module.exports = { createOsrmRouteDistanceProvider, normalizeBaseUrl, MAX_POINTS, MAX_RESPONSE_BYTES };
