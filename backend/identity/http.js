'use strict';

const crypto = require('node:crypto');
const { IdentityError } = require('./service');
const { isValidMfaProof } = require('./totp');

const COOKIE_NAME = '__Host-rotamoto_session';
const MAX_BODY_BYTES = 16 * 1024;
const RATE_POLICIES = Object.freeze({
  login: { limit: 10, windowMs: 15 * 60 * 1000 },
  recovery: { limit: 5, windowMs: 15 * 60 * 1000 },
  password: { limit: 8, windowMs: 15 * 60 * 1000 },
  invitation: { limit: 10, windowMs: 15 * 60 * 1000 },
  provision: { limit: 5, windowMs: 15 * 60 * 1000 },
  smtpTest: { limit: 5, windowMs: 15 * 60 * 1000 },
  smtpValidate: { limit: 10, windowMs: 15 * 60 * 1000 },
  mfa: { limit: 8, windowMs: 15 * 60 * 1000 },
  default: { limit: 60, windowMs: 60 * 1000 }
});
const ROUTE_METHODS = Object.freeze({
  '/api/identity/login': 'POST',
  '/api/identity/logout': 'POST',
  '/api/identity/password/change': 'POST',
  '/api/identity/session': 'GET',
  '/api/identity/bootstrap/status': 'GET',
  '/api/identity/bootstrap/smtp/status': 'POST',
  '/api/identity/bootstrap/smtp/validate': 'POST',
  '/api/identity/bootstrap/smtp/test': 'POST',
  '/api/admin/smtp/config': 'GET',
  '/api/admin/smtp/validate': 'POST',
  '/api/admin/smtp/test': 'POST',
  '/api/admin/smtp/disable': 'POST',
  '/api/identity/mfa/enrollment': 'POST',
  '/api/identity/mfa/enrollment/cancel': 'POST',
  '/api/identity/mfa/enrollment/confirm': 'POST',
  '/api/identity/mfa/recovery-codes': 'POST',
  '/api/identity/tenant': 'POST',
  '/api/identity/recovery': 'POST',
  '/api/identity/recovery/consume': 'POST',
  '/api/identity/mfa/recovery/request': 'POST',
  '/api/identity/mfa/recovery/confirm': 'POST',
  '/api/identity/invitations/accept': 'POST',
  '/api/identity/membership-invitations/accept': 'POST',
  '/api/identity/membership-invitations/accept-authenticated': 'POST',
  '/api/admin/invitations': 'POST',
  '/api/admin/tenants/provision': 'POST'
});

function problemStatus(code) {
  if (['INVALID_INPUT', 'PASSWORD_UNCHANGED', 'CURRENT_PASSWORD_INVALID', 'SMTP_CONFIGURATION_INVALID'].includes(code)) return 400;
  if (['INVALID_TOKEN', 'INVALID_CREDENTIALS'].includes(code)) return 401;
  if (code === 'UNAUTHENTICATED') return 401;
  if (['FORBIDDEN', 'PROVISIONER_UNAUTHORIZED', 'MFA_REQUIRED', 'CSRF_INVALID', 'ORIGIN_INVALID'].includes(code)) return 403;
  if (['BOOTSTRAP_NOT_AVAILABLE', 'BOOTSTRAP_STATE_INVALID'].includes(code)) return 409;
  if (['PROVISIONER_NOT_CONFIGURED', 'BOOTSTRAP_NOT_READY', 'EMAIL_PROVIDER_NOT_CONFIGURED', 'EMAIL_DELIVERY_FAILED', 'INVITATION_LINKS_UNAVAILABLE', 'MFA_PROVIDER_UNAVAILABLE', 'SMTP_CONFIGURATION_UNAVAILABLE'].includes(code)) return 503;
  if (code === 'AUTHENTICATION_REQUIRED') return 401;
  if (code === 'IDEMPOTENCY_CONFLICT') return 409;
  if (['CONFLICT', 'REVISION_CONFLICT', 'RECOVERY_LOCAL_OPERATOR_REQUIRED'].includes(code)) return 409;
  if (code === 'MFA_ENROLLMENT_EXPIRED') return 409;
  if (['INVALID_STATE_TRANSITION', 'LAST_OWNER_REQUIRED'].includes(code)) return 409;
  if (['NOT_FOUND', 'TENANT_NOT_FOUND'].includes(code)) return 404;
  if (code === 'RATE_LIMITED') return 429;
  if (['SMTP_ACCEPTED_AUDIT_FAILED', 'SMTP_ACCEPTED_CONFIGURATION_SAVE_FAILED'].includes(code)) return 503;
  if (['SMTP_TEST_FAILED', 'ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EAUTH', 'EENVELOPE',
    'SMTP_DNS_FAILED', 'SMTP_TCP_REFUSED', 'SMTP_TIMEOUT', 'SMTP_CONNECTION_FAILED', 'SMTP_TCP_FAILED',
    'SMTP_STARTTLS_FAILED', 'SMTP_CERTIFICATE_FAILED', 'SMTP_AUTH_REJECTED', 'SMTP_SENDER_REJECTED',
    'SMTP_RECIPIENT_REJECTED', 'SMTP_MESSAGE_REJECTED', 'SMTP_SUBMISSION_UNKNOWN'].includes(code)) return 502;
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
  if (path === '/api/identity/bootstrap/smtp/test' || path === '/api/admin/smtp/test') return 'smtpTest';
  if (path === '/api/identity/bootstrap/smtp/status' || path === '/api/identity/bootstrap/smtp/validate' || path === '/api/admin/smtp/validate') return 'smtpValidate';
  if (path === '/api/identity/login') return 'login';
  if (path === '/api/identity/password/change') return 'password';
  if (path.startsWith('/api/identity/recovery')) return 'recovery';
  if (path.startsWith('/api/identity/invitations') || path.startsWith('/api/identity/membership-invitations')) return 'invitation';
  if (path === '/api/admin/invitations') return 'invitation';
  if (path === '/api/admin/tenants/provision') return 'provision';
  if (path.startsWith('/api/identity/mfa/') || path.startsWith('/api/admin/mfa-recovery')) return 'mfa';
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
    CURRENT_PASSWORD_INVALID: 'A senha atual não confere.',
    PASSWORD_UNCHANGED: 'Escolha uma senha diferente da atual.',
    UNAUTHENTICATED: 'Sessão inválida ou expirada.',
    FORBIDDEN: 'Operação não autorizada.',
    PROVISIONER_UNAUTHORIZED: 'Provisionamento administrativo não autorizado.',
    PROVISIONER_NOT_CONFIGURED: 'Provisionamento administrativo indisponível.',
    BOOTSTRAP_NOT_READY: 'Bootstrap ainda não está preparado. Aplique as migrations antes de provisionar.',
    BOOTSTRAP_NOT_AVAILABLE: 'A primeira instalação não está disponível neste ambiente.',
    BOOTSTRAP_STATE_INVALID: 'Não foi possível concluir a instalação com segurança. Procure o operador local.',
    EMAIL_PROVIDER_NOT_CONFIGURED: 'Entrega de email indisponível.',
    EMAIL_DELIVERY_FAILED: 'Entrega do convite indisponível.',
    INVITATION_LINKS_UNAVAILABLE: 'Envio de convites está desativado: configure uma URL pública HTTPS ou use a ativação local do primeiro titular.',
    AUTHENTICATION_REQUIRED: 'Entre na conta existente para aceitar o convite.',
    MFA_REQUIRED: 'A autenticação multifator é obrigatória ou inválida.',
    MFA_PROVIDER_UNAVAILABLE: 'Verificação multifator indisponível.',
    RECOVERY_LOCAL_OPERATOR_REQUIRED: 'A recuperação deste proprietário exige confirmação local auditada.',
    MFA_ENROLLMENT_EXPIRED: 'O enrollment MFA expirou; inicie novamente.',
    IDEMPOTENCY_CONFLICT: 'Chave idempotente já utilizada para outra solicitação.',
    CONFLICT: 'Conflito com o estado atual do recurso.',
    REVISION_CONFLICT: 'O recurso foi atualizado por outra operação.',
    NOT_FOUND: 'Recurso não encontrado.',
    TENANT_NOT_FOUND: 'Empresa não encontrada.',
    RATE_LIMITED: 'Limite de tentativas excedido.',
    SMTP_CONFIGURATION_INVALID: error.message,
    SMTP_CONFIGURATION_UNAVAILABLE: 'Configuração SMTP protegida indisponível.',
    SMTP_TEST_FAILED: 'Não foi possível testar o envio SMTP. Confira os parâmetros e tente novamente.',
    ECONNECTION: 'Não foi possível conectar ao servidor SMTP.',
    ECONNREFUSED: 'O servidor SMTP recusou a conexão.',
    ETIMEDOUT: 'O servidor SMTP excedeu o tempo limite.',
    ESOCKET: 'Falha de comunicação segura com o servidor SMTP.',
    EDNS: 'Não foi possível resolver o servidor SMTP.',
    EAUTH: 'O servidor SMTP recusou a autenticação.',
    EENVELOPE: 'O servidor SMTP recusou o remetente ou destinatário do teste.',
    SMTP_DNS_FAILED: 'Não foi possível resolver o servidor SMTP (DNS).',
    SMTP_TCP_REFUSED: 'A conexão TCP com o servidor SMTP foi recusada.',
    SMTP_TIMEOUT: 'A conexão com o servidor SMTP excedeu o tempo limite.',
    SMTP_CONNECTION_FAILED: 'Não foi possível estabelecer conexão com o servidor SMTP.',
    SMTP_TCP_FAILED: 'A conexão TCP com o servidor SMTP falhou.',
    SMTP_STARTTLS_FAILED: 'O servidor SMTP não concluiu STARTTLS.',
    SMTP_CERTIFICATE_FAILED: 'O certificado TLS do servidor SMTP não pôde ser validado.',
    SMTP_AUTH_REJECTED: 'O servidor SMTP recusou a autenticação.',
    SMTP_SENDER_REJECTED: 'O servidor SMTP recusou o remetente.',
    SMTP_RECIPIENT_REJECTED: 'O servidor SMTP recusou o destinatário de teste.',
    SMTP_MESSAGE_REJECTED: 'O servidor SMTP rejeitou a mensagem de teste.',
    SMTP_SUBMISSION_UNKNOWN: 'A conexão terminou durante o envio e o servidor não confirmou o resultado. A mensagem pode ter sido aceita; confira antes de repetir.',
    PAYLOAD_TOO_LARGE: 'Payload excede o limite permitido.',
    UNSUPPORTED_MEDIA_TYPE: 'Content-Type application/json obrigatório.',
    METHOD_NOT_ALLOWED: 'Método não permitido.',
    CSRF_INVALID: 'Validação CSRF inválida.',
    ORIGIN_INVALID: 'Origem não permitida.'
  };
  const payloadError = { code: status === 500 ? 'INTERNAL_ERROR' : code,
    message: messages[code] || 'Falha interna ao processar a solicitação.' };
  if (error?.acceptedBySmtp === true) Object.assign(payloadError, { submission: 'accepted_by_smtp', delivery: 'unconfirmed', configurationSaved: false });
  if (code === 'SMTP_ACCEPTED_AUDIT_FAILED') payloadError.message = 'O servidor SMTP aceitou a mensagem, mas a auditoria local falhou. O resultado não foi rejeição do provedor; confira o estado antes de repetir.';
  if (code === 'SMTP_ACCEPTED_CONFIGURATION_SAVE_FAILED') payloadError.message = 'O servidor SMTP aceitou a mensagem, mas a configuração não foi persistida. O teste foi concluído e não será repetido automaticamente.';
  return { status, payload: { error: payloadError } };
}

function createIdentityHttpHandler({ identityService, rateLimiter = createRateLimiter(), logger = () => {},
  requestId = req => req.requestId || crypto.randomUUID(), allowedOrigin, bootstrapReadiness = async () => ({}), smtpConfiguration = null }) {
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

  async function platformSmtpAdmin(req, mutation, operation) {
    const sessionToken = parseCookie(req);
    if (!sessionToken) throw fail('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
    const run = async (client, principal) => {
      if (!principal.mfa_verified_at) throw fail('MFA_REQUIRED', 'Esta alteração exige uma sessão com MFA confirmado.');
      const administrator = await client.query(`SELECT 1 FROM rotamoto.platform_administrators
        WHERE user_id=$1 AND revoked_at IS NULL AND grant_kind='founder_bootstrap'`, [principal.user_id]);
      if (!administrator.rowCount) throw fail('FORBIDDEN', 'Operação não autorizada.');
      return operation(principal);
    };
    if (mutation) return requireSessionMutation(req, 'company.manage', run);
    return identityService.withAuthenticatedTenant(sessionToken, run, 'company.manage');
  }

  return async function identityHttpHandler(req, res) {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (!path.startsWith('/api/identity/') && !['/api/admin/tenants/provision', '/api/admin/invitations', '/api/admin/mfa-recovery',
      '/api/admin/smtp/config', '/api/admin/smtp/validate', '/api/admin/smtp/test', '/api/admin/smtp/disable'].includes(path) &&
      !/^\/api\/admin\/mfa-recovery\/[0-9a-f-]{36}\/approve$/iu.test(path)) return false;
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

      if (path === '/api/identity/bootstrap/status' && req.method === 'GET') {
        const [installation, deployment] = await Promise.all([
          identityService.getBootstrapStatus(), Promise.resolve(bootstrapReadiness(req)).catch(() => ({}))
        ]);
        status = 200;
        send(res, status, { state: installation.state, checks: {
          databaseAndMigrations: installation.checks?.schema === true,
          pricingConfigurationAvailable: installation.checks?.pricing === true,
          mfaKeystoreConfigured: deployment?.mfaKeystoreConfigured === true,
          smtpTransportConfigured: deployment?.smtpTransportConfigured === true,
          invitationDeliveryConfigured: deployment?.invitationDeliveryConfigured === true,
          localOnlyBootstrapAvailable: deployment?.localOnlyBootstrapAvailable === true
        } });
        return true;
      }

      if (path === '/api/identity/bootstrap/smtp/status' && req.method === 'POST') {
        if (!smtpConfiguration) throw fail('NOT_FOUND', 'Rota não encontrada.');
        exactKeys(await readJson(req), []);
        const digest = await smtpConfiguration.authorize(req, 'smtp.validate');
        try {
          const raw = await smtpConfiguration.status();
          const config = { configured: raw?.configured === true, transportConfigured: raw?.transportConfigured === true,
            invitationLinksConfigured: raw?.invitationLinksConfigured === true, disabled: raw?.disabled === true,
            credentialStored: raw?.credentialStored === true, existingCredentialAvailable: raw?.existingCredentialAvailable === true,
            provider: raw?.provider || null, host: raw?.host || null, port: Number(raw?.port) || null,
            tlsMode: raw?.tlsMode || null, senderEmail: raw?.senderEmail || null, senderName: raw?.senderName || null, testRecipient: raw?.testRecipient || null,
            publicBaseUrl: raw?.publicBaseUrl || null, lastTestStatus: raw?.lastTestStatus || null };
          status = 200; send(res, status, config); return true;
        } finally { digest.fill(0); }
      }

      if (path === '/api/identity/bootstrap/smtp/validate' && req.method === 'POST') {
        if (!smtpConfiguration) throw fail('NOT_FOUND', 'Rota não encontrada.');
        const body = await readJson(req);
        const digest = await smtpConfiguration.authorize(req, 'smtp.validate');
        let validated;
        try { validated = await smtpConfiguration.validate(body); } finally { digest.fill(0); }
        status = 200; send(res, status, validated); return true;
      }

      if (path === '/api/identity/bootstrap/smtp/test' && req.method === 'POST') {
        if (!smtpConfiguration) throw fail('NOT_FOUND', 'Rota não encontrada.');
        const body = await readJson(req);
        exactKeys(body, ['requestId', 'settings']);
        if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) throw fail('INVALID_INPUT', 'Configuração SMTP inválida.');
        const result = await smtpConfiguration.test(body.settings, req, body.requestId);
        status = 200; send(res, status, result); return true;
      }

      if (path === '/api/admin/smtp/config' && req.method === 'GET') {
        if (!smtpConfiguration) throw fail('NOT_FOUND', 'Rota não encontrada.');
        const raw = await platformSmtpAdmin(req, false, () => smtpConfiguration.status());
        const config = { configured: raw?.configured === true, transportConfigured: raw?.transportConfigured === true,
          invitationLinksConfigured: raw?.invitationLinksConfigured === true, disabled: raw?.disabled === true, credentialStored: raw?.credentialStored === true,
          provider: raw?.provider || null, host: raw?.host || null, port: Number(raw?.port) || null,
          tlsMode: raw?.tlsMode || null, senderEmail: raw?.senderEmail || null, senderName: raw?.senderName || null, testRecipient: raw?.testRecipient || null,
          publicBaseUrl: raw?.publicBaseUrl || null, lastTestStatus: raw?.lastTestStatus || null,
          lastTestAt: raw?.lastTestAt || null, existingCredentialAvailable: raw?.existingCredentialAvailable === true };
        status = 200; send(res, status, config); return true;
      }

      if (path === '/api/admin/smtp/validate' && req.method === 'POST') {
        if (!smtpConfiguration) throw fail('NOT_FOUND', 'Rota não encontrada.');
        const body = await readJson(req);
        const validated = await platformSmtpAdmin(req, true, () => smtpConfiguration.validate(body));
        status = 200; send(res, status, validated); return true;
      }

      if (path === '/api/admin/smtp/test' && req.method === 'POST') {
        if (!smtpConfiguration) throw fail('NOT_FOUND', 'Rota não encontrada.');
        const body = await readJson(req); exactKeys(body, ['requestId', 'settings']);
        if (!body.settings || typeof body.settings !== 'object' || Array.isArray(body.settings)) throw fail('INVALID_INPUT', 'Configuração SMTP inválida.');
        const result = await platformSmtpAdmin(req, true, principal => smtpConfiguration.testAsAdmin(body.settings, principal.user_id, body.requestId));
        status = 200; send(res, status, result); return true;
      }

      if (path === '/api/admin/smtp/disable' && req.method === 'POST') {
        if (!smtpConfiguration) throw fail('NOT_FOUND', 'Rota não encontrada.');
        exactKeys(await readJson(req), []);
        const result = await platformSmtpAdmin(req, true, () => smtpConfiguration.disable());
        status = 200; send(res, status, result); return true;
      }

      if (path === '/api/identity/login' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['email', 'password', 'companyId', 'mfaCode']);
        if (body.mfaCode !== undefined && (typeof body.mfaCode !== 'string' || body.mfaCode.length < 6 || body.mfaCode.length > 128 || /[\u0000-\u001f\u007f]/u.test(body.mfaCode))) throw fail('INVALID_INPUT', 'Código MFA inválido.');
        const session = await identityService.authenticate(body.email, body.password, body.companyId, body.mfaCode);
        status = 200;
        send(res, status, { userId: session.userId, companyId: session.companyId, csrfToken: session.csrfToken,
          mfaEnrollmentRequired: Boolean(session.mfaEnrollmentRequired),
          ...(session.loginCompanies ? { companies: session.loginCompanies, platformAdmin: session.platformAdmin } : {}) }, {
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
          const platformSchema = await client.query(`SELECT to_regclass('rotamoto.platform_administrators') IS NOT NULL AS ready`);
          const platformAdmin = platformSchema.rows[0]?.ready
            ? await client.query(`SELECT EXISTS(SELECT 1 FROM rotamoto.platform_administrators WHERE user_id=$1 AND revoked_at IS NULL) AS active`, [value.user_id])
            : { rows: [{ active: false }] };
          const csrfToken = await identityService.renewCsrfToken(client, value.session_id, sessionToken);
          return { userId: value.user_id, email: user.rows[0].email, emailVerified: user.rows[0].email_verified,
            activeCompanyId: value.company_id, activeRoleId: value.role_id, driverId: value.driver_id || null,
            activeCompanyName: value.company_name || null,
            companyTimeZone: value.company_time_zone || null,
            permissions: permissions.rows.map(row => row.permission_key),
            mfaVerified: Boolean(value.mfa_verified_at), mfaConfigured: Boolean(value.mfa_configured),
            mfaRequired: Boolean(value.mfa_required), mfaEnrollmentRequired: Boolean(value.mfa_enrollment_required),
            platformAdmin: Boolean(platformAdmin.rows[0]?.active), csrfToken };
        }, 'identity.session');
        status = 200;
        send(res, status, principal);
        return true;
      }

      if (path === '/api/identity/mfa/enrollment' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['currentPassword', 'currentMfaCode']);
        if (Object.keys(body).length && (typeof body.currentPassword !== 'string' ||
            Buffer.byteLength(body.currentPassword, 'utf8') > 1024 || body.currentPassword.includes('\0') ||
            !isValidMfaProof(body.currentMfaCode)))
          throw fail('INVALID_INPUT', 'Confirme sua senha atual e um código válido do autenticador ou de recuperação.');
        const result = await requireSessionMutation(req, 'identity.mfa.enroll', (client, principal) =>
          identityService.startMfaEnrollmentForPrincipal(client, principal, body));
        if (result?.error) throw fail(result.error, 'Não foi possível confirmar sua identidade para substituir o autenticador.');
        status = 200; send(res, status, result); return true;
      }

      if (path === '/api/identity/mfa/enrollment/cancel' && req.method === 'POST') {
        exactKeys(await readJson(req), []);
        const outcome = await requireSessionMutation(req, 'identity.mfa.enroll', (client, principal) =>
          identityService.cancelMfaEnrollmentForPrincipal(client, principal));
        const result = await identityService.finishMfaEnrollmentCancellation(outcome);
        status = 200; send(res, status, result); return true;
      }

      if (path === '/api/identity/mfa/enrollment/confirm' && req.method === 'POST') {
        const body = await readJson(req); exactKeys(body, ['code']);
        if (typeof body.code !== 'string' || !/^\d{6}$/u.test(body.code)) throw fail('INVALID_INPUT', 'Código MFA inválido.');
        const outcome = await requireSessionMutation(req, 'identity.mfa.enroll', (client, principal) =>
          identityService.confirmMfaEnrollmentForPrincipal(client, principal, body.code));
        const result = await identityService.finishMfaEnrollment(outcome);
        status = 200; send(res, status, result); return true;
      }

      if (path === '/api/identity/mfa/recovery-codes' && req.method === 'POST') {
        exactKeys(await readJson(req), []);
        const recoveryCodes = await requireSessionMutation(req, 'company.manage', (client, principal) =>
          identityService.regenerateMfaRecoveryCodesForPrincipal(client, principal));
        const result = { recoveryCodes };
        status = 200; send(res, status, result); return true;
      }

      if (path === '/api/identity/mfa/recovery/request' && req.method === 'POST') {
        const body=await readJson(req); exactKeys(body,['email','password','companyId']);
        if(typeof body.email!=='string'||typeof body.password!=='string'||typeof body.companyId!=='string')throw fail('INVALID_INPUT','Credenciais inválidas.');
        await identityService.requestMfaRecovery(body);
        status=202;send(res,status,{accepted:true});return true;
      }

      if (path === '/api/identity/mfa/recovery/confirm' && req.method === 'POST') {
        const body=await readJson(req); exactKeys(body,['token']);
        if(typeof body.token!=='string')throw fail('INVALID_INPUT','Token inválido.');
        const result=await identityService.confirmMfaRecoveryChallenge(body);
        status=202;send(res,status,result);return true;
      }

      if (path === '/api/admin/mfa-recovery' && req.method === 'GET') {
        const sessionToken=parseCookie(req);
        if(!sessionToken)throw fail('UNAUTHENTICATED','Sessão inválida ou expirada.');
        const requests=await identityService.withAuthenticatedTenant(sessionToken,
          (client,principal)=>identityService.listMfaRecoveryRequestsForPrincipal(client,principal),'company.manage');
        status=200;send(res,status,{requests});return true;
      }

      const approvalMatch=path.match(/^\/api\/admin\/mfa-recovery\/([0-9a-f-]{36})\/approve$/iu);
      if(approvalMatch&&req.method==='POST'){
        exactKeys(await readJson(req),[]);
        const outcome=await requireSessionMutation(req,'company.manage',(client,principal)=>
          identityService.approveMfaRecoveryForPrincipal(client,principal,approvalMatch[1]));
        const result=await identityService.finishMfaRecovery(outcome);
        status=200;send(res,status,result);return true;
      }

      if (path === '/api/identity/logout' && req.method === 'POST') {
        const sessionToken = parseCookie(req);
        await requireSessionMutation(req, 'identity.logout', async client => identityService.revokeSession(sessionToken, client));
        status = 204;
        send(res, status, undefined, { 'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax` });
        return true;
      }

      if (path === '/api/identity/companies' && req.method === 'GET') {
        const sessionToken = parseCookie(req);
        if (!sessionToken) throw fail('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
        status = 200;
        send(res, status, { companies: await identityService.listCompaniesForSession(sessionToken) });
        return true;
      }

      if (path === '/api/identity/password/change' && req.method === 'POST') {
        const body = await readJson(req);
        exactKeys(body, ['currentPassword', 'newPassword']);
        if (typeof body.currentPassword !== 'string' || !body.currentPassword ||
            Buffer.byteLength(body.currentPassword, 'utf8') > 1024 || body.currentPassword.includes('\0'))
          throw fail('INVALID_INPUT', 'Informe sua senha atual.');
        validateNewPassword(body.newPassword);
        const outcome = await requireSessionMutation(req, undefined, (client, principal) =>
          identityService.changePasswordForPrincipal(client, principal, body.currentPassword, body.newPassword));
        if (outcome?.error) throw fail(outcome.error, 'Não foi possível atualizar a senha.');
        status = 200; send(res, status, { changed: true }); return true;
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
        exactKeys(body, ['companyName', 'email', 'idempotencyKey', 'initialSetup', 'localOnly']);
        if (body.localOnly === true) {
          const deployment = await bootstrapReadiness(req).catch(() => ({}));
          if (deployment.localOnlyBootstrapAvailable !== true) throw fail('PROVISIONER_UNAUTHORIZED', 'A instalação local só pode ser iniciada nesta máquina.');
        } else {
          const deployment = await bootstrapReadiness(req).catch(() => ({}));
          if (deployment.invitationDeliveryConfigured !== true) throw fail('BOOTSTRAP_NOT_READY', 'O transporte SMTP e a URL pública HTTPS dos convites precisam estar configurados.');
        }
        const provisioned = await identityService.provisionInitialOwner(body, { request: req, requestedLocalOnly: body.localOnly === true });
        const localHandoff = provisioned.delivery === 'local_handoff' && typeof provisioned.localInvitationToken === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(provisioned.localInvitationToken);
        status = 202;
        send(res, status, { companyId: provisioned.companyId, userId: provisioned.userId,
          delivery: provisioned.delivery, replayed: provisioned.replayed, setupReadback: provisioned.setupReadback,
          setupState: 'awaiting_owner_activation_and_mfa', ...(localHandoff ? { localInvitationToken: provisioned.localInvitationToken } : {}) });
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
      try { logger({ requestId: id, method: req.method, path, status, durationMs: Date.now() - startedAt,
        ...(req.apiErrorCode ? { errorCode: req.apiErrorCode } : {}) }); }
      catch (_) { /* logging must not change request outcome */ }
    }
  };
}

module.exports = { COOKIE_NAME, MAX_BODY_BYTES, createRateLimiter, createIdentityHttpHandler, publicError };
