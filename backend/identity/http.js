'use strict';

const crypto = require('node:crypto');
const { IdentityError } = require('./service');

const COOKIE_NAME = '__Host-rotamoto_session';
const MAX_BODY_BYTES = 16 * 1024;
const RATE_POLICIES = Object.freeze({
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
  recovery: { limit: 5, windowMs: 15 * 60 * 1000 },
  invitation: { limit: 10, windowMs: 15 * 60 * 1000 },
  provision: { limit: 5, windowMs: 15 * 60 * 1000 },
  default: { limit: 60, windowMs: 60 * 1000 }
});
const ROUTE_METHODS = Object.freeze({
  '/api/identity/login': 'POST',
  '/api/identity/logout': 'POST',
  '/api/identity/session': 'GET',
  '/api/identity/tenant': 'POST',
  '/api/identity/recovery': 'POST',
  '/api/identity/recovery/consume': 'POST',
  '/api/identity/invitations/accept': 'POST',
  '/api/identity/membership-invitations/accept': 'POST',
  '/api/identity/membership-invitations/accept-authenticated': 'POST',
  '/api/admin/invitations': 'POST',
  '/api/admin/tenants/provision': 'POST'
});

function problemStatus(code) {
  if (['INVALID_INPUT', 'INVALID_TOKEN', 'INVALID_CREDENTIALS'].includes(code)) return code === 'INVALID_CREDENTIALS' || code === 'INVALID_TOKEN' ? 401 : 400;
  if (code === 'UNAUTHENTICATED') return 401;
  if (['FORBIDDEN', 'PROVISIONER_UNAUTHORIZED', 'MFA_REQUIRED', 'CSRF_INVALID', 'ORIGIN_INVALID'].includes(code)) return 403;
  if (['PROVISIONER_NOT_CONFIGURED', 'EMAIL_PROVIDER_NOT_CONFIGURED', 'EMAIL_DELIVERY_FAILED', 'MFA_PROVIDER_UNAVAILABLE'].includes(code)) return 503;
  if (code === 'AUTHENTICATION_REQUIRED') return 401;
  if (code === 'IDEMPOTENCY_CONFLICT') return 409;
  if (['CONFLICT', 'REVISION_CONFLICT'].includes(code)) return 409;
  if (['INVALID_STATE_TRANSITION', 'LAST_OWNER_REQUIRED'].includes(code)) return 409;
  if (['NOT_FOUND', 'TENANT_NOT_FOUND'].includes(code)) return 404;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'UNSUPPORTED_MEDIA_TYPE') return 415;
  if (code === 'METHOD_NOT_ALLOWED') return 405;
  return 500;
}

function send(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(res.req?.requestId ? { 'X-Request-ID': res.req.requestId } : {}),
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders
  });
  res.end(payload);
}

function fail(code, message) {
  return new IdentityError(code, message);
}

function parseCookie(req) {
  const values = String(req.headers.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) {
    throw fail('UNSUPPORTED_MEDIA_TYPE', 'Content-Type application/json obrigatório.');
  }
  const length = Number(req.headers['content-length'] || 0);
  if (length > MAX_BODY_BYTES) {
    req.resume();
    throw fail('PAYLOAD_TOO_LARGE', 'Payload excede o limite permitido.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      throw fail('PAYLOAD_TOO_LARGE', 'Payload excede o limite permitido.');
    }
    chunks.push(chunk);
  }
  if (!size) throw fail('INVALID_INPUT', 'Objeto JSON obrigatório.');
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw fail('INVALID_INPUT', 'JSON inválido.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_INPUT', 'Objeto JSON obrigatório.');
  return value;
}

function exactKeys(value, keys) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw fail('INVALID_INPUT', 'Campos inválidos.');
}

function validateNewPassword(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 12 ||
      Buffer.byteLength(value, 'utf8') > 1024 || value.includes('\0')) {
    throw fail('INVALID_INPUT', 'A senha deve ter entre 12 e 1024 bytes UTF-8.');
  }
}

function createRateLimiter({ clock = Date.now, policies = RATE_POLICIES, maxKeys = 5000 } = {}) {
  const entries = new Map();
  let checks = 0;
  return Object.freeze({
    consume(key, category = 'default') {
      const now = clock();
      const policy = policies[category] || policies.default;
      let entry = entries.get(key);
      if (!entry || now >= entry.startedAt + policy.windowMs) entry = { startedAt: now, count: 0 };
      entry.count += 1;
      entries.set(key, entry);
      if (++checks % 256 === 0 || entries.size > maxKeys) {
        for (const [savedKey, saved] of entries) {
          const savedPolicy = policies[savedKey.split(':', 1)[0]] || policies.default;
          if (now >= saved.startedAt + savedPolicy.windowMs) entries.delete(savedKey);
        }
        while (entries.size > maxKeys) entries.delete(entries.keys().next().value);
      }
      return { allowed: entry.count <= policy.limit,
        retryAfter: Math.max(1, Math.ceil((entry.startedAt + policy.windowMs - now) / 1000)) };
    }
  });
}

function rateCategory(path) {
  if (path === '/api/identity/login') return 'login';
  if (path.startsWith('/api/identity/recovery')) return 'recovery';
  if (path.startsWith('/api/identity/invitations') || path.startsWith('/api/identity/membership-invitations')) return 'invitation';
  if (path === '/api/admin/invitations') return 'invitation';
  if (path === '/api/admin/tenants/provision') return 'provision';
  return 'default';
}

function assertSameOrigin(req, allowedOrigin) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch (_) { throw fail('ORIGIN_INVALID', 'Origem não permitida.'); }
  const host = String(req.headers.host || '').toLowerCase();
  const protocol = req.socket.encrypted ? 'https:' : 'http:';
  const allowList = Array.isArray(allowedOrigin) ? allowedOrigin : [allowedOrigin];
  if (parsed.origin !== `${protocol}//${host}`.toLowerCase() && !allowList.includes(parsed.origin)) {
    throw fail('ORIGIN_INVALID', 'Origem não permitida.');
  }
}

function publicError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/u.test(error.code) ? error.code : 'INTERNAL_ERROR';
  const status = problemStatus(code);
  const messages = {
    INVALID_INPUT: error.message,
    INVALID_TOKEN: 'Token inválido ou expirado.',
    INVALID_CREDENTIALS: 'Email ou senha inválidos.',
    UNAUTHENTICATED: 'Sessão inválida ou expirada.',
    FORBIDDEN: 'Operação não autorizada.',
    PROVISIONER_UNAUTHORIZED: 'Provisionamento administrativo não autorizado.',
    PROVISIONER_NOT_CONFIGURED: 'Provisionamento administrativo indisponível.',
    EMAIL_PROVIDER_NOT_CONFIGURED: 'Entrega de email indisponível.',
    EMAIL_DELIVERY_FAILED: 'Entrega do convite indisponível.',
    AUTHENTICATION_REQUIRED: 'Entre na conta existente para aceitar o convite.',
    MFA_REQUIRED: 'A autenticação multifator desta conta ainda não está configurada.',
    MFA_PROVIDER_UNAVAILABLE: 'Verificação multifator indisponível.',
    IDEMPOTENCY_CONFLICT: 'Chave idempotente já utilizada para outra solicitação.',
    CONFLICT: 'Conflito com o estado atual do recurso.',
    REVISION_CONFLICT: 'O recurso foi atualizado por outra operação.',
    NOT_FOUND: 'Recurso não encontrado.',
    TENANT_NOT_FOUND: 'Empresa não encontrada.',
    RATE_LIMITED: 'Limite de tentativas excedido.',
    PAYLOAD_TOO_LARGE: 'Payload excede o limite permitido.',
    UNSUPPORTED_MEDIA_TYPE: 'Content-Type application/json obrigatório.',
    METHOD_NOT_ALLOWED: 'Método não permitido.',
    CSRF_INVALID: 'Validação CSRF inválida.',
    ORIGIN_INVALID: 'Origem não permitida.'
  };
  return { status, payload: { error: { code: status === 500 ? 'INTERNAL_ERROR' : code,
    message: messages[code] || 'Falha interna ao processar a solicitação.' } } };
}

function createIdentityHttpHandler({ identityService, rateLimiter = createRateLimiter(), logger = () => {},
  requestId = req => req.requestId || crypto.randomUUID(), allowedOrigin }) {
  if (!identityService) throw new TypeError('Serviço de identidade obrigatório.');

  async function requireSessionMutation(req, permissionKey, operation) {
    const sessionToken = parseCookie(req);
    if (!sessionToken) throw fail('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
    assertSameOrigin(req, allowedOrigin);
    const csrf = req.headers['x-csrf-token'];
    if (typeof csrf !== 'string') throw fail('CSRF_INVALID', 'Validação CSRF inválida.');
    return identityService.withAuthenticatedTenant(sessionToken, async (client, principal) => {
      if (!await identityService.verifyCsrf(client, principal.session_id, csrf)) throw fail('CSRF_INVALID', 'Validação CSRF inválida.');
      return operation(client, principal, sessionToken);
    }, permissionKey);
  }

  return async function identityHttpHandler(req, res) {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (!path.startsWith('/api/identity/') && !['/api/admin/tenants/provision', '/api/admin/invitations'].includes(path)) return false;
    const id = requestId(req);
    const startedAt = Date.now();
    let status = 500;
    try {
      if (req.method === 'POST') assertSameOrigin(req, allowedOrigin);
      const category = rateCategory(path);
      const limiter = rateLimiter.consume(`${category}:${req.clientIp || req.socket.remoteAddress || 'unknown'}:${path}`, category);
      if (!limiter.allowed) {
        status = 429;
        send(res, status, { error: { code: 'RATE_LIMITED', message: 'Limite de tentativas excedido.' } }, { 'Retry-After': String(limiter.retryAfter) });
        return true;
      }
      if (ROUTE_METHODS[path] && ROUTE_METHODS[path] !== req.method) {
        status = 405;
        req.apiErrorCode = 'METHOD_NOT_ALLOWED';
        send(res, status, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' }, requestId: id }, { Allow: ROUTE_METHODS[path] });
        return true;
      }

      if (path === '/api/identity/login' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['email', 'password', 'companyId', 'mfaCode']);
        if (body.mfaCode !== undefined && (typeof body.mfaCode !== 'string' || body.mfaCode.length < 6 || body.mfaCode.length > 128 || /[\u0000-\u001f\u007f]/u.test(body.mfaCode))) throw fail('INVALID_INPUT', 'Código MFA inválido.');
        const session = await identityService.authenticate(body.email, body.password, body.companyId, body.mfaCode);
        status = 200;
        send(res, status, { userId: session.userId, companyId: session.companyId, csrfToken: session.csrfToken }, {
          'Set-Cookie': `${COOKIE_NAME}=${session.sessionToken}; Path=/; Max-Age=${session.maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`
        });
        return true;
      }

      if (path === '/api/identity/session' && req.method === 'GET') {
        const sessionToken = parseCookie(req);
        if (!sessionToken) throw fail('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
        const principal = await identityService.withAuthenticatedTenant(sessionToken, async (client, value) => {
          const permissions = await client.query(`SELECT permission_key FROM rotamoto.role_permissions
            WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 ORDER BY permission_key`, [value.company_id, value.role_id]);
          const user = await client.query(`SELECT email,email_verified_at IS NOT NULL AS email_verified
            FROM rotamoto.users WHERE id=$1 AND disabled_at IS NULL`, [value.user_id]);
          if (!user.rowCount) throw fail('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
          const csrfToken = await identityService.renewCsrfToken(client, value.session_id, sessionToken);
          return { userId: value.user_id, email: user.rows[0].email, emailVerified: user.rows[0].email_verified,
            activeCompanyId: value.company_id, activeRoleId: value.role_id, driverId: value.driver_id || null,
            permissions: permissions.rows.map(row => row.permission_key),
            mfaVerified: Boolean(value.mfa_verified_at), csrfToken };
        });
        status = 200;
        send(res, status, principal);
        return true;
      }

      if (path === '/api/identity/logout' && req.method === 'POST') {
        const sessionToken = parseCookie(req);
        await requireSessionMutation(req, undefined, async () => identityService.revokeSession(sessionToken));
        status = 204;
        send(res, status, undefined, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` });
        return true;
      }

      if (path === '/api/identity/tenant' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['companyId']);
        if (typeof body.companyId !== 'string') throw fail('INVALID_INPUT', 'Empresa inválida.');
        const selected = await requireSessionMutation(req, undefined, async (_client, _principal, sessionToken) =>
          identityService.switchActiveCompany(sessionToken, body.companyId));
        status = 200;
        send(res, status, { activeCompanyId: selected.companyId });
        return true;
      }

      if (path === '/api/identity/recovery' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['email']);
        if (typeof body.email !== 'string') throw fail('INVALID_INPUT', 'Email inválido.');
        await identityService.requestPasswordRecovery(body.email);
        status = 202;
        send(res, status, { accepted: true });
        return true;
      }

      if (path === '/api/identity/recovery/consume' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['token', 'password']);
        validateNewPassword(body.password);
        await identityService.consumePasswordRecovery(body);
        status = 204;
        send(res, status);
        return true;
      }

      if (path === '/api/identity/invitations/accept' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['token', 'password']);
        validateNewPassword(body.password);
        const accepted = await identityService.consumeOwnerInvitation(body);
        status = 200;
        send(res, status, accepted);
        return true;
      }

      if (path === '/api/identity/membership-invitations/accept' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['token', 'password']);
        if (typeof body.token !== 'string') throw fail('INVALID_INPUT', 'Token inválido.');
        validateNewPassword(body.password);
        const accepted = await identityService.consumeMembershipInvitation(body);
        status = 200;
        send(res, status, accepted);
        return true;
      }

      if (path === '/api/identity/membership-invitations/accept-authenticated' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['token']);
        if (typeof body.token !== 'string') throw fail('INVALID_INPUT', 'Token inválido.');
        const accepted = await requireSessionMutation(req, undefined, async (_client, _principal, sessionToken) =>
          identityService.acceptExistingMembershipInvitation(sessionToken, body.token));
        status = 200;
        send(res, status, accepted);
        return true;
      }

      if (path === '/api/admin/invitations' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['email', 'roleId']);
        if (typeof body.email !== 'string' || typeof body.roleId !== 'string') throw fail('INVALID_INPUT', 'Convite inválido.');
        const invited = await identityService.inviteMembershipWithSession(parseCookie(req), req.headers['x-csrf-token'], body);
        status = 202;
        send(res, status, invited);
        return true;
      }

      if (path === '/api/admin/tenants/provision' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['companyName', 'email', 'idempotencyKey']);
        const provisioned = await identityService.provisionInitialOwner(body, { request: req });
        status = 202;
        send(res, status, { companyId: provisioned.companyId, userId: provisioned.userId,
          delivery: provisioned.delivery, replayed: provisioned.replayed });
        return true;
      }

      if (['GET', 'POST'].includes(req.method)) {
        status = 404;
        req.apiErrorCode = 'NOT_FOUND';
        send(res, status, { error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' }, requestId: id });
      } else {
        status = 405;
        req.apiErrorCode = 'METHOD_NOT_ALLOWED';
        send(res, status, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' }, requestId: id }, { Allow: 'GET, POST' });
      }
      return true;
    } catch (error) {
      const mapped = publicError(error);
      status = mapped.status;
      req.apiErrorCode = mapped.payload.error.code;
      send(res, status, { ...mapped.payload, requestId: id });
      return true;
    } finally {
      try { logger({ requestId: id, method: req.method, path, status, durationMs: Date.now() - startedAt }); }
      catch (_) { /* logging must not change request outcome */ }
    }
  };
}

module.exports = { COOKIE_NAME, MAX_BODY_BYTES, createRateLimiter, createIdentityHttpHandler, publicError };
