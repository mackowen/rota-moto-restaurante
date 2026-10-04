'use strict';

const crypto = require('node:crypto');
const { createRateLimiter } = require('../identity/http');
const ROUTES = Object.freeze({
  '/api/admin/company': { method: 'GET', permission: 'company.manage', operation: 'company' },
  '/api/admin/memberships': { method: 'GET', permission: 'members.read', operation: 'memberships' },
  '/api/admin/roles': { method: 'GET', permission: 'company.manage', operation: 'roles' },
  '/api/admin/integrations': { method: 'GET', permission: 'integrations.manage', operation: 'integrations' }
});

function createAdminHttpHandler({ identityService, adminService, rateLimiter = createRateLimiter(), logger = () => {} }) {
  if (!identityService || !adminService) throw new TypeError('Serviços de identidade e administração obrigatórios.');
  return async function adminHttpHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const config = ROUTES[url.pathname];
    if (!config && !url.pathname.startsWith('/api/admin/')) return false;
    const requestId = req.requestId || crypto.randomUUID();
    const startedAt = Date.now();
    let status = 500;
    let errorCode;
    try {
      if (!config) throw Object.assign(new Error('Recurso não encontrado.'), { code: 'NOT_FOUND' });
      if (req.method !== config.method) {
        status = 405;
        res.writeHead(status, { Allow: config.method, 'Cache-Control': 'no-store', 'X-Request-ID': requestId });
        res.end(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' }, requestId }));
        return true;
      }
      const rate = rateLimiter.consume(`${req.socket.remoteAddress || 'unknown'}:${url.pathname}`);
      if (!rate.allowed) throw Object.assign(new Error('Limite de solicitações excedido.'), { code: 'RATE_LIMITED' });
      const query = Object.create(null);
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(query, key)) throw Object.assign(new Error('Parâmetro repetido.'), { code: 'INVALID_INPUT' });
        query[key] = value;
      }
      if (config.operation !== 'memberships' && Object.keys(query).length) {
        throw Object.assign(new Error('Parâmetro de consulta não permitido.'), { code: 'INVALID_INPUT' });
      }
      const tokenParts = String(req.headers.cookie || '').split(';').map(value => value.trim())
        .filter(value => value.startsWith('__Host-rotamoto_session='));
      const token = tokenParts.length === 1 ? tokenParts[0].slice('__Host-rotamoto_session='.length) : null;
      if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw Object.assign(new Error('Sessão inválida ou expirada.'), { code: 'UNAUTHENTICATED' });
      const result = await identityService.withAuthenticatedTenant(token,
        (client, principal) => adminService[config.operation](client, principal, query), config.permission);
      status = 200;
      const body = JSON.stringify({ ...result, requestId });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'X-Request-ID': requestId, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
      return true;
    } catch (error) {
      errorCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'INTERNAL_ERROR';
      const statusByCode = { INVALID_INPUT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403,
        NOT_FOUND: 404, RATE_LIMITED: 429, DEPENDENCY_UNAVAILABLE: 503 };
      status = statusByCode[errorCode] || 500;
      req.apiErrorCode = status === 500 ? 'INTERNAL_ERROR' : errorCode;
      const code = status === 500 ? 'INTERNAL_ERROR' : errorCode;
      const message = status === 400 ? error.message : ({ UNAUTHENTICATED: 'Sessão inválida ou expirada.',
        FORBIDDEN: 'Operação não autorizada.', NOT_FOUND: 'Recurso não encontrado.', RATE_LIMITED: 'Limite de solicitações excedido.',
        DEPENDENCY_UNAVAILABLE: 'Dependência indisponível.', INTERNAL_ERROR: 'Falha interna ao processar a administração.' })[code];
      const body = JSON.stringify({ error: { code, message }, requestId });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Request-ID': requestId,
        'Content-Length': Buffer.byteLength(body), ...(status === 429 ? { 'Retry-After': '60' } : {}) });
      res.end(body);
      return true;
    } finally {
      try { logger({ requestId, method: req.method, path: url.pathname, status, durationMs: Date.now() - startedAt,
        ...(errorCode ? { errorCode } : {}) }); } catch (_) { /* logging does not affect admin outcomes */ }
    }
  };
}

module.exports = { ROUTES, createAdminHttpHandler };
