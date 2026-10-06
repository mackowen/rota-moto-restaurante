'use strict';

const crypto = require('node:crypto');
const { createRateLimiter } = require('../identity/http');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTES = Object.freeze({
  '/api/admin/company': { method: 'GET', permission: 'company.manage', operation: 'company' },
  '/api/admin/memberships': { method: 'GET', permission: 'members.read', operation: 'memberships' },
  '/api/admin/roles': { method: 'GET', permission: 'company.manage', operation: 'roles' },
  '/api/admin/permissions': { method: 'GET', permission: 'company.manage', operation: 'permissions' },
  '/api/admin/integrations': { method: 'GET', permission: 'integrations.manage', operation: 'integrations' }
});

function send(res, status, payload, extra = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Request-ID': res.req?.requestId,
    'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
function error(code, message = 'Dados inválidos.') { return Object.assign(new Error(message), { code }); }
async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) throw error('UNSUPPORTED_MEDIA_TYPE');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024) { req.resume(); throw error('PAYLOAD_TOO_LARGE'); } chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw error('INVALID_INPUT'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw error('INVALID_INPUT');
  return value;
}
function exact(body, keys) { if (Object.keys(body).some(key => !keys.includes(key))) throw error('INVALID_INPUT'); }
function validateRole(body, create) {
  exact(body, create ? ['key', 'name', 'permissions'] : ['name', 'permissions']);
  if (create && (typeof body.key !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/u.test(body.key))) throw error('INVALID_INPUT');
  if (typeof body.name !== 'string' || !body.name.trim() || Buffer.byteLength(body.name.trim(), 'utf8') > 100 ||
      /[\u0000-\u001f\u007f]/u.test(body.name)) throw error('INVALID_INPUT');
  if (!Array.isArray(body.permissions) || body.permissions.length > 128 || body.permissions.some(key =>
    typeof key !== 'string' || !/^[a-z][a-z0-9_.:-]{1,119}$/u.test(key)) || new Set(body.permissions).size !== body.permissions.length) throw error('INVALID_INPUT');
  return { ...(create ? { key: body.key } : {}), name: body.name.trim(), permissions: body.permissions };
}
function validateMembership(body) {
  exact(body, ['roleId', 'status']);
  if (!Object.keys(body).length || body.roleId !== undefined && (typeof body.roleId !== 'string' || !UUID.test(body.roleId)) ||
      body.status !== undefined && !['active', 'suspended', 'revoked'].includes(body.status)) throw error('INVALID_INPUT');
  return body;
}
function validateDriverLink(body) {
  exact(body, ['driverId']);
  if (typeof body.driverId !== 'string' || !UUID.test(body.driverId)) throw error('INVALID_INPUT');
  return body.driverId.toLowerCase();
}
function isIanaTimeZone(value) {
  try { if (/^Etc\/GMT[+-]\d{1,2}$/iu.test(value)) return false; new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; } catch (_) { return false; }
}

function createAdminHttpHandler({ identityService, adminService, rateLimiter = createRateLimiter(), logger = () => {}, allowedOrigin }) {
  if (!identityService || !adminService) throw new TypeError('Serviços de identidade e administração obrigatórios.');
  return async function adminHttpHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/admin/')) return false;
    const requestId = req.requestId || crypto.randomUUID(); req.requestId = requestId; res.req = req;
    const startedAt = Date.now(); let status = 500; let errorCode;
    try {
      let config = req.method === 'POST' && url.pathname === '/api/admin/roles'
        ? { method: 'POST', permission: 'company.manage', operation: 'createRole' }
        : url.pathname === '/api/admin/company' && req.method === 'PUT'
          ? { method: 'PUT', permission: 'company.manage', operation: 'updateCompanyTimeZone' }
          : ROUTES[url.pathname]; let match;
      if (!config && (match = /^\/api\/admin\/roles\/([0-9a-f-]{36})$/iu.exec(url.pathname))) config = { method: 'PATCH', permission: 'company.manage', operation: 'updateRole', id: match[1] };
      if (!config && (match = /^\/api\/admin\/memberships\/([0-9a-f-]{36})$/iu.exec(url.pathname))) config = { method: 'PATCH', permission: 'company.manage', operation: 'updateMembership', id: match[1] };
      if (!config && (match = /^\/api\/admin\/memberships\/([0-9a-f-]{36})\/driver$/iu.exec(url.pathname)))
        config = { method: req.method === 'DELETE' ? 'DELETE' : 'PUT', permission: 'company.manage',
          operation: req.method === 'DELETE' ? 'disassociateMembershipDriver' : 'associateMembershipDriver', id: match[1] };
      if (!config) throw error('NOT_FOUND');
      if (config.id && !UUID.test(config.id)) throw error('INVALID_INPUT');
      if (req.method !== config.method) { status = 405; send(res, status, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' }, requestId }, { Allow: config.method }); return true; }
      const rate = rateLimiter.consume(`${req.clientIp || req.socket.remoteAddress || 'unknown'}:${url.pathname}`);
      if (!rate.allowed) { status = 429; send(res, status, { error: { code: 'RATE_LIMITED', message: 'Limite de solicitações excedido.' }, requestId }, { 'Retry-After': String(rate.retryAfter) }); return true; }
      const query = Object.create(null);
      for (const [key, value] of url.searchParams) { if (Object.hasOwn(query, key)) throw error('INVALID_INPUT'); query[key] = value; }
      if (config.operation !== 'memberships' && Object.keys(query).length) throw error('INVALID_INPUT');
      const tokenParts = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith('__Host-rotamoto_session='));
      const token = tokenParts.length === 1 ? tokenParts[0].slice('__Host-rotamoto_session='.length) : null;
      if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw error('UNAUTHENTICATED');
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        const allowList = Array.isArray(allowedOrigin) ? allowedOrigin : [allowedOrigin];
        if (origin && !allowList.includes(origin) && origin.toLowerCase() !== `${req.socket.encrypted ? 'https' : 'http'}://${String(req.headers.host || '').toLowerCase()}`) throw error('ORIGIN_INVALID');
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readBody(req);
      const result = await identityService.withAuthenticatedTenant(token, async (client, principal) => {
        if (req.method !== 'GET') {
          const csrf = req.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !await identityService.verifyCsrf(client, principal.session_id, csrf)) throw error('CSRF_INVALID');
        }
        switch (config.operation) {
          case 'memberships': return adminService.memberships(client, principal, query);
          case 'company': return adminService.company(client, principal);
          case 'updateCompanyTimeZone': {
            exact(body, ['timeZone']);
            const value = body.timeZone;
            if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 128 || /^[+-]\d{2}:?\d{2}$/u.test(value) || !isIanaTimeZone(value))) throw error('INVALID_INPUT');
            return adminService.updateCompanyTimeZone(client, principal, value);
          }
          case 'roles': return adminService.roles(client, principal);
          case 'permissions': return adminService.permissions(client, principal);
          case 'integrations': return adminService.integrations(client, principal);
          case 'createRole': return adminService.createRole(client, principal, validateRole(body, true));
          case 'updateRole': return adminService.updateRole(client, principal, config.id, validateRole(body, false));
          case 'updateMembership': return adminService.updateMembership(client, principal, config.id, validateMembership(body));
          case 'associateMembershipDriver': return adminService.associateMembershipDriver(client, principal, config.id, validateDriverLink(body));
          case 'disassociateMembershipDriver': return adminService.disassociateMembershipDriver(client, principal, config.id);
          default: throw error('NOT_FOUND');
        }
      }, config.permission);
      status = config.operation === 'createRole' ? 201 : 200;
      send(res, status, { ...result, requestId }); return true;
    } catch (err) {
      errorCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(err?.code || '') ? err.code : 'INTERNAL_ERROR';
      const map = { INVALID_INPUT: 400, INVALID_STATE_TRANSITION: 409, LAST_OWNER_REQUIRED: 409, CONFLICT: 409,
        REVISION_CONFLICT: 409, UNAUTHENTICATED: 401, FORBIDDEN: 403, MFA_REQUIRED: 403,
        CSRF_INVALID: 403, ORIGIN_INVALID: 403, NOT_FOUND: 404, RATE_LIMITED: 429,
        PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, DEPENDENCY_UNAVAILABLE: 503,
        DRIVER_MEMBERSHIP_INELIGIBLE: 409, DRIVER_NOT_FOUND: 404, DRIVER_ALREADY_LINKED: 409, MEMBERSHIP_DRIVER_CONFLICT: 409 };
      status = map[errorCode] || 500;
      const messages = { INVALID_INPUT: 'Dados inválidos.', INVALID_STATE_TRANSITION: 'Transição de conta inválida.',
        LAST_OWNER_REQUIRED: 'A empresa precisa manter ao menos um owner ativo.', UNAUTHENTICATED: 'Sessão inválida ou expirada.',
        DRIVER_MEMBERSHIP_INELIGIBLE: 'A associação não está apta para sincronização Motoboy.',
        DRIVER_NOT_FOUND: 'Motorista canônico não encontrado nesta empresa.',
        DRIVER_ALREADY_LINKED: 'Este motorista já está vinculado a outra associação.',
        MEMBERSHIP_DRIVER_CONFLICT: 'Remova o vínculo atual antes de associar outro motorista.',
        FORBIDDEN: 'Operação não autorizada.', MFA_REQUIRED: 'Esta operação exige MFA verificado.',
        CSRF_INVALID: 'Validação da solicitação inválida.', ORIGIN_INVALID: 'Origem não permitida.',
        CONFLICT: 'Conflito com o estado atual do recurso.', REVISION_CONFLICT: 'O recurso foi atualizado por outra operação.',
        NOT_FOUND: 'Recurso não encontrado.', RATE_LIMITED: 'Limite de solicitações excedido.', INTERNAL_ERROR: 'Falha interna ao processar a administração.',
        PAYLOAD_TOO_LARGE: 'Payload excede o limite permitido.', UNSUPPORTED_MEDIA_TYPE: 'Content-Type application/json obrigatório.' };
      send(res, status, { error: { code: status === 500 ? 'INTERNAL_ERROR' : errorCode,
        message: status === 400 ? 'Dados inválidos.' : messages[errorCode] || 'Falha ao processar a solicitação.' }, requestId },
      status === 429 ? { 'Retry-After': '60' } : {});
      return true;
    } finally { try { logger({ requestId, method: req.method, path: url.pathname, status, durationMs: Date.now() - startedAt, ...(errorCode ? { errorCode } : {}) }); } catch (_) {} }
  };
}

module.exports = { ROUTES, createAdminHttpHandler, validateDriverLink };
