'use strict';

const crypto = require('node:crypto');
const { COOKIE_NAME, createRateLimiter } = require('../identity/http');
const { SyncError } = require('./sync-service');

const MAX_BODY_BYTES = 1024 * 1024;

function statusFor(error) {
  if (error.code === 'INVALID_INPUT') return 400;
  if (error.code === 'UNAUTHENTICATED') return 401;
  if (error.code === 'FORBIDDEN' || error.code === 'CSRF_INVALID' || error.code === 'ORIGIN_INVALID') return 403;
  if (error.code === 'RATE_LIMITED') return 429;
  if (error.code === 'PAYLOAD_TOO_LARGE') return 413;
  if (['SYNC_CONFLICT', 'INVALID_TRANSITION', 'UNRESOLVED_REFERENCE', 'IMMUTABLE_EVENT'].includes(error.code)) return 409;
  return 500;
}

function sessionCookie(req) {
  const values = String(req.headers.cookie || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { throw new SyncError('ORIGIN_INVALID', 'Origem inválida.'); }
  const protocol = req.socket.encrypted ? 'https:' : 'http:';
  if (parsed.origin.toLowerCase() !== `${protocol}//${String(req.headers.host || '').toLowerCase()}`) {
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

function createSyncHttpHandler({ identityService, syncService, rateLimiter = createRateLimiter(), logger = () => {} }) {
  if (!identityService || !syncService) throw new TypeError('Serviços de identidade e sync obrigatórios.');

  return async function syncHttpHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!['/api/sync/push', '/api/sync/pull'].includes(url.pathname)) return false;
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    let status = 500;
    let errorCode;
    let errorTable;
    try {
      const expectedMethod = url.pathname.endsWith('/push') ? 'POST' : 'GET';
      if (req.method !== expectedMethod) {
        status = 405;
        res.writeHead(status, { Allow: expectedMethod, 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      if (req.method === 'POST') assertSameOrigin(req);
      const rate = rateLimiter.consume(`${req.socket.remoteAddress || 'unknown'}:${url.pathname}`);
      if (!rate.allowed) {
        status = 429;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': String(rate.retryAfter) });
        res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Limite de solicitações excedido.' } }));
        return true;
      }
      const token = sessionCookie(req);
      if (!token) throw new SyncError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
      let result;
      if (expectedMethod === 'POST') {
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
        'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
      return true;
    } catch (error) {
      errorCode = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
      errorTable = typeof error?.table === 'string' && /^[a-z_][a-z0-9_]*$/u.test(error.table) ? error.table : undefined;
      status = statusFor(error);
      const code = status === 500 ? 'INTERNAL_ERROR' : error.code;
      const message = status === 500 ? 'Falha interna ao processar a sincronização.' : error.message;
      const payload = JSON.stringify({ error: { code, message } });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(payload),
        ...(status === 429 ? { 'Retry-After': '60' } : {}) });
      res.end(payload);
      return true;
    } finally {
      try { logger({ requestId, method: req.method, path: url.pathname, status, durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode } : {}), ...(errorTable ? { errorTable } : {}) }); } catch (_) { /* logging cannot affect sync */ }
    }
  };
}

module.exports = { MAX_BODY_BYTES, createSyncHttpHandler };
