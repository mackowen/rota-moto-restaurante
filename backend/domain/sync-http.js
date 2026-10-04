'use strict';

const crypto = require('node:crypto');
const { COOKIE_NAME, createRateLimiter } = require('../identity/http');
const { SyncError } = require('./sync-service');

const MAX_BODY_BYTES = 1024 * 1024;

function statusFor(error) {
  if (error.code === 'INVALID_INPUT') return 400;
  if (error.code === 'UNAUTHENTICATED') return 401;
  if (['FORBIDDEN','FORBIDDEN_FIELD','FORBIDDEN_EVENT','INSTALLATION_FORBIDDEN','CSRF_INVALID','ORIGIN_INVALID'].includes(error.code)) return 403;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'PAYLOAD_TOO_LARGE') return 413;
  if (['SYNC_CONFLICT','REVISION_CONFLICT','INSTALLATION_REQUIRED','INSTALLATION_AMBIGUOUS','INVALID_TRANSITION',
    'UNRESOLVED_REFERENCE','IMMUTABLE_EVENT','ROUTE_DELIVERY_ALREADY_ACTIVE'].includes(error.code)) return 409;
  if (['NOT_FOUND','TENANT_NOT_FOUND'].includes(error.code)) return 404;
  if (['MEDIA_STORAGE_UNAVAILABLE','DEPENDENCY_UNAVAILABLE'].includes(error.code)) return 503;
  return 500;
}

function sessionCookie(req) {
  const values = String(req.headers.cookie || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

function assertSameOrigin(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { throw new SyncError('ORIGIN_INVALID', 'Origem inválida.'); }
  const protocol = req.socket.encrypted ? 'https:' : 'http:';
  const allowList = Array.isArray(allowedOrigin) ? allowedOrigin : [allowedOrigin];
  if (parsed.origin.toLowerCase() !== `${protocol}//${String(req.headers.host || '').toLowerCase()}` && !allowList.includes(parsed.origin)) {
    throw new SyncError('ORIGIN_INVALID', 'Origem não permitida.');
  }
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) {
    throw new SyncError('INVALID_INPUT', 'Content-Type application/json obrigatório.');
  }
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_BODY_BYTES) {
    req.resume();
    throw new SyncError('PAYLOAD_TOO_LARGE', 'Payload excede o limite permitido.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      throw new SyncError('PAYLOAD_TOO_LARGE', 'Payload excede o limite permitido.');
    }
    chunks.push(chunk);
  }
  if (!size) throw new SyncError('INVALID_INPUT', 'JSON obrigatório.');
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw new SyncError('INVALID_INPUT', 'JSON inválido.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyncError('INVALID_INPUT', 'Objeto JSON obrigatório.');
  return body;
}

function createSyncHttpHandler({ identityService, syncService, rateLimiter = createRateLimiter(), logger = () => {}, allowedOrigin }) {
  if (!identityService || !syncService) throw new TypeError('Serviços de identidade e sync obrigatórios.');

  return async function syncHttpHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const isInstallation = /^\/api\/sync\/installations\/(restaurante|motoboy)$/u.test(url.pathname);
    const isKnownRoute = ['/api/sync/push', '/api/sync/pull'].includes(url.pathname) || isInstallation;
    if (!isKnownRoute && !url.pathname.startsWith('/api/sync/')) return false;
    const requestId = req.requestId || crypto.randomUUID();
    const startedAt = Date.now();
    let status = 500;
    let errorCode;
    try {
      if (!isKnownRoute) throw new SyncError('NOT_FOUND', 'Rota não encontrada.');
      const expectedMethod = url.pathname.endsWith('/pull') ? 'GET' : 'POST';
      if (req.method !== expectedMethod) {
        status = 405;
        req.apiErrorCode = 'METHOD_NOT_ALLOWED';
        const payload = JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' }, requestId });
        res.writeHead(status, { Allow: expectedMethod, 'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store', 'X-Request-ID': requestId, 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
        return true;
      }
      if (req.method === 'POST') assertSameOrigin(req, allowedOrigin);
      const rate = rateLimiter.consume(`${req.socket.remoteAddress || 'unknown'}:${url.pathname}`);
      if (!rate.allowed) {
        status = 429;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(rate.retryAfter), 'X-Request-ID': requestId });
        res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Limite de solicitações excedido.' }, requestId }));
        return true;
      }
      const token = sessionCookie(req);
      if (!token) throw new SyncError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
      let result;
      if (isInstallation) {
        const csrf = req.headers['x-csrf-token'];
        if (typeof csrf !== 'string') throw new SyncError('CSRF_INVALID', 'Validação CSRF inválida.');
        const appKey = url.pathname.endsWith('/restaurante') ? 'restaurante' : 'motoboy';
        result = await identityService.withAuthenticatedTenant(token, async (client, principal) => {
          if (!await identityService.verifyCsrf(client, principal.session_id, csrf)) throw new SyncError('CSRF_INVALID', 'Validação CSRF inválida.');
          const body = await jsonBody(req);
          return syncService.registerInstallation(client, principal, appKey, body.deviceId);
        }, 'sync.push');
      } else if (expectedMethod === 'POST') {
        const csrf = req.headers['x-csrf-token'];
        if (typeof csrf !== 'string') throw new SyncError('CSRF_INVALID', 'Validação CSRF inválida.');
        result = await identityService.withAuthenticatedTenant(token, async (client, principal) => {
          if (!await identityService.verifyCsrf(client, principal.session_id, csrf)) throw new SyncError('CSRF_INVALID', 'Validação CSRF inválida.');
          const packet = await jsonBody(req);
          return syncService.push(client, principal, packet);
        }, 'sync.push');
      } else {
        const cursor = url.searchParams.get('cursor');
        const limit = url.searchParams.get('limit') || 100;
        const deviceId = url.searchParams.get('deviceId');
        result = await identityService.withAuthenticatedTenant(token,
          (client, principal) => syncService.pull(client, principal, { cursor, limit, deviceId }), 'sync.pull');
      }
      status = 200;
      const payload = JSON.stringify(result);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'X-Request-ID': requestId,
        'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
      return true;
    } catch (error) {
      errorCode = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
      status = statusFor(error);
      const code = status === 500 ? 'INTERNAL_ERROR' : error.code;
      const message = status === 500 ? 'Falha interna ao processar a sincronização.' : error.message;
      req.apiErrorCode = code;
      const payload = JSON.stringify({ error: { code, message }, requestId });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId, 'Content-Length': Buffer.byteLength(payload),
        ...(status === 429 ? { 'Retry-After': '60' } : {}) });
      res.end(payload);
      return true;
    } finally {
      try { logger({ requestId, method: req.method, path: url.pathname, status, durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode: req.apiErrorCode || (status === 500 ? 'INTERNAL_ERROR' : errorCode) } : {}) }); } catch (_) { /* logging cannot affect sync */ }
    }
  };
}

module.exports = { MAX_BODY_BYTES, createSyncHttpHandler };
