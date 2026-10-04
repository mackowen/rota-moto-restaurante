'use strict';

const crypto = require('node:crypto');
const { createRateLimiter } = require('../identity/http');
const { QUERY_PERMISSIONS } = require('./query-service');

function createDomainQueryHttpHandler({ identityService, queryService, rateLimiter = createRateLimiter(), logger = () => {} }) {
  if (!identityService || !queryService) throw new TypeError('Serviços de identidade e consulta de domínio obrigatórios.');
  const route = /^\/api\/domain\/([a-z-]+)(?:\/([^/]+))?$/u;
  return async function domainQueryHttpHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const match = route.exec(url.pathname);
    if (!match && !url.pathname.startsWith('/api/domain/')) return false;
    const requestId = req.requestId || crypto.randomUUID();
    const startedAt = Date.now();
    let status = 500;
    let errorCode;
    try {
      if (!match) throw Object.assign(new Error('Recurso não encontrado.'), { code: 'NOT_FOUND' });
      if (req.method !== 'GET') {
        status = 405;
        res.writeHead(status, { Allow: 'GET', 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
        res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' }, requestId }));
        return true;
      }
      const collection = match[1];
      const recordId = match[2];
      const permission = QUERY_PERMISSIONS[collection];
      if (!permission) {
        status = 404;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' }, requestId }));
        return true;
      }
      const rate = rateLimiter.consume(`${req.clientIp || req.socket.remoteAddress || 'unknown'}:${url.pathname}`);
      if (!rate.allowed) throw Object.assign(new Error('Limite de solicitações excedido.'), { code: 'RATE_LIMITED' });
      const rawValues = Object.create(null);
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(rawValues, key)) throw Object.assign(new Error('Parâmetro repetido.'), { code: 'INVALID_INPUT' });
        rawValues[key] = value;
      }
      if (recordId && Object.keys(rawValues).length) throw Object.assign(new Error('Parâmetro não permitido em consulta por ID.'), { code: 'INVALID_INPUT' });
      const cookieValues = String(req.headers.cookie || '').split(';').map(value => value.trim())
        .filter(value => value.startsWith('__Host-rotamoto_session='));
      const token = cookieValues.length === 1 ? cookieValues[0].slice('__Host-rotamoto_session='.length) : null;
      if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw Object.assign(new Error('Sessão inválida ou expirada.'), { code: 'UNAUTHENTICATED' });
      const result = await identityService.withAuthenticatedTenant(token,
        (client, principal) => recordId ? queryService.get(client, principal, collection, recordId) :
          queryService.list(client, principal, collection, rawValues), permission);
      status = 200;
      const body = JSON.stringify({ ...result, requestId });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'X-Request-ID': requestId, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return true;
    } catch (error) {
      errorCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'INTERNAL_ERROR';
      const statusByCode = { INVALID_INPUT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, DRIVER_LINK_REQUIRED: 403,
        NOT_FOUND: 404, RATE_LIMITED: 429, DEPENDENCY_UNAVAILABLE: 503 };
      status = statusByCode[errorCode] || 500;
      const code = status === 500 ? 'INTERNAL_ERROR' : errorCode;
      req.apiErrorCode = code;
      const message = status === 400 ? error.message : ({ UNAUTHENTICATED: 'Sessão inválida ou expirada.',
        DRIVER_LINK_REQUIRED: 'A associação desta conta a um motorista precisa ser configurada pela empresa.',
        FORBIDDEN: 'Operação não autorizada.', NOT_FOUND: 'Recurso não encontrado.', RATE_LIMITED: 'Limite de solicitações excedido.',
        DEPENDENCY_UNAVAILABLE: 'Dependência indisponível.', INTERNAL_ERROR: 'Falha interna ao consultar o domínio.' })[code];
      const body = JSON.stringify({ error: { code, message }, requestId });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId,
        'Content-Length': Buffer.byteLength(body), ...(status === 429 ? { 'Retry-After': '60' } : {}) });
      res.end(body);
      return true;
    } finally {
      try { logger({ requestId, method: req.method, path: url.pathname, status, durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode } : {}) }); } catch (_) { /* logging does not affect query outcomes */ }
    }
  };
}

module.exports = { createDomainQueryHttpHandler };
