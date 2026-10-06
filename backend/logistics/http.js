'use strict';

const crypto = require('node:crypto');
const { COOKIE_NAME, createRateLimiter } = require('../identity/http');
const { LogisticsServiceError } = require('./service');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const MAX_BODY = 16 * 1024;
function error(code, message) { throw new LogisticsServiceError(code, message); }
function tokenFrom(req) {
  const values = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(token) ? token : null;
}
function sameOrigin(req, allowedOrigin = []) {
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin).origin; } catch (_) { error('ORIGIN_INVALID', 'Origem inválida.'); }
  const own = `${req.socket.encrypted ? 'https' : 'http'}://${String(req.headers.host || '').toLowerCase()}`;
  if (origin.toLowerCase() !== own && !allowedOrigin.includes(origin)) error('ORIGIN_INVALID', 'Origem não permitida.');
}
async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) error('INVALID_INPUT', 'Content-Type application/json obrigatório.');
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) { req.resume(); error('PAYLOAD_TOO_LARGE', 'Payload excede o limite permitido.'); }
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { req.resume(); error('PAYLOAD_TOO_LARGE', 'Payload excede o limite permitido.'); } chunks.push(chunk); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { error('INVALID_INPUT', 'JSON inválido.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) error('INVALID_INPUT', 'Objeto JSON obrigatório.');
  return body;
}
function statusFor(code) {
  if (['INVALID_INPUT','ORIGIN_INVALID'].includes(code)) return 400;
  if (code === 'UNAUTHENTICATED') return 401;
  if (['FORBIDDEN','CSRF_INVALID','MFA_REQUIRED'].includes(code)) return 403;
  if (code === 'RATE_LIMITED') return 429;
  if (['NOT_FOUND'].includes(code)) return 404;
  if (['REVISION_CONFLICT','IDEMPOTENCY_CONFLICT','INVALID_STATE_TRANSITION','PROVIDER_UNAVAILABLE','INVALID_DRIVER','CAPACITY_UNKNOWN','INVALID_ROUTE',
    'ROUTE_DELIVERY_ALREADY_ACTIVE','DELIVERY_IN_ACTIVE_ROUTE','INSTALLATION_REQUIRED','FULFILLMENT_RECONCILIATION_REQUIRED','PROVIDER_CODE_CONFLICT','RECONCILIATION_REQUIRED'].includes(code)) return 409;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  return 500;
}
function createLogisticsHttpHandler({ identityService, logisticsService, rateLimiter = createRateLimiter(), logger = () => {}, allowedOrigin = [] } = {}) {
  if (!identityService || !logisticsService) throw new TypeError('Serviços de identidade e logística obrigatórios.');
  return async function logisticsHttpHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/logistics/')) return false;
    const requestId = req.requestId || crypto.randomUUID(); let status = 500, errorCode;
    const respond = (code, body, extra = {}) => { status = code; const text = JSON.stringify({ ...body, requestId });
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Request-ID': requestId,
        'Content-Length': Buffer.byteLength(text), ...extra }); res.end(text); };
    try {
      const routes = [
        { re: /^\/api\/logistics\/providers$/u, methods: ['GET','POST'] },
        { re: /^\/api\/logistics\/internal-provider$/u, methods: ['POST'] },
        { re: new RegExp(`^/api/logistics/providers/(${UUID})$`, 'u'), methods: ['PATCH'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/fulfillment$`, 'u'), methods: ['GET','PUT','PATCH'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/dispatch-attempts$`, 'u'), methods: ['POST'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-quotes$`, 'u'), methods: ['GET','POST'] },
        { re: new RegExp(`^/api/logistics/provider-quotes/(${UUID})/select$`, 'u'), methods: ['POST'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-dispatch$`, 'u'), methods: ['POST'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-cancel$`, 'u'), methods: ['POST'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-tracking$`, 'u'), methods: ['POST'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-reconcile$`, 'u'), methods: ['POST'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-commands$`, 'u'), methods: ['GET'] },
        { re: /^\/api\/logistics\/analytics$/u, methods: ['GET'] },
        { re: /^\/api\/logistics\/intelligence\/settings$/u, methods: ['GET','PUT'] },
        { re: /^\/api\/logistics\/intelligence\/analytics$/u, methods: ['GET'] },
        { re: /^\/api\/logistics\/intelligence\/decision-quality$/u, methods: ['GET'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/comparison$`, 'u'), methods: ['GET'] },
        { re: new RegExp(`^/api/logistics/deliveries/(${UUID})/decisions$`, 'u'), methods: ['GET','POST'] },
        { re: new RegExp(`^/api/logistics/decisions/(${UUID})/(approve|reject|recalculate|execute)$`, 'u'), methods: ['POST'] }
      ];
      const route = routes.map(item => ({ ...item, match: item.re.exec(url.pathname) })).find(item => item.match);
      if (!route) { respond(404, { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } }); return true; }
      if (!route.methods.includes(req.method)) { respond(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' } }, { Allow: route.methods.join(', ') }); return true; }
      if (!rateLimiter.consume(`${req.clientIp || req.socket.remoteAddress || 'unknown'}:${url.pathname}`).allowed) error('RATE_LIMITED', 'Limite de solicitações excedido.');
      const token = tokenFrom(req); if (!token) error('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
      const write = !['GET','HEAD'].includes(req.method);
      if (write) sameOrigin(req, allowedOrigin);
      const permission = ['/api/logistics/analytics','/api/logistics/intelligence/analytics','/api/logistics/intelligence/decision-quality'].includes(url.pathname) ||
        /\/(comparison|decisions)$/u.test(url.pathname) || url.pathname === '/api/logistics/intelligence/settings' && req.method === 'GET'
        ? 'orders.read' : 'company.manage';
      const result = await identityService.withAuthenticatedTenant(token, async (client, principal) => {
        if (write) {
          const csrf = req.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !await identityService.verifyCsrf(client, principal.session_id, csrf)) error('CSRF_INVALID', 'Validação CSRF inválida.');
        }
        const body = write ? await readJson(req) : null;
        const path = url.pathname;
        let match;
        if (path === '/api/logistics/providers') return req.method === 'GET' ? logisticsService.listProviders(client, principal) : logisticsService.createProvider(client, principal, body);
        if (path === '/api/logistics/internal-provider') {
          if (Object.keys(body).length) error('INVALID_INPUT', 'Objeto vazio obrigatório.');
          return { provider: await logisticsService.ensureInternalProvider(client, principal) };
        }
        if (path === '/api/logistics/analytics') return logisticsService.analytics(client, principal);
        if (path === '/api/logistics/intelligence/settings') return req.method === 'GET'
          ? logisticsService.getIntelligenceSettings(client,principal) : logisticsService.updateIntelligenceSettings(client,principal,body);
        if (path === '/api/logistics/intelligence/analytics') return logisticsService.logisticsEconomicAnalytics(client,principal);
        if (path === '/api/logistics/intelligence/decision-quality') return logisticsService.logisticsDecisionQuality(client,principal);
        match = new RegExp(`^/api/logistics/deliveries/(${UUID})/comparison$`, 'u').exec(path);
        if (match) return logisticsService.compareLogisticsAlternatives(client,principal,match[1],url.searchParams.get('policy'));
        match = new RegExp(`^/api/logistics/deliveries/(${UUID})/decisions$`, 'u').exec(path);
        if (match) return req.method==='GET' ? logisticsService.listLogisticsDecisions(client,principal,match[1])
          : logisticsService.evaluateLogisticsDecision(client,principal,match[1],body.policy);
        match = new RegExp(`^/api/logistics/decisions/(${UUID})/(approve|reject|recalculate|execute)$`, 'u').exec(path);
        if (match) return logisticsService[({approve:'approveLogisticsDecision',reject:'rejectLogisticsDecision',
          recalculate:'recalculateLogisticsDecision',execute:'executeLogisticsDecision'})[match[2]]](client,principal,match[1],body);
        match = new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-quotes$`, 'u').exec(path);
        if (match) return req.method === 'GET' ? logisticsService.listProviderQuotes(client, principal, match[1])
          : logisticsService.requestProviderQuote(client, principal, match[1], body);
        match = new RegExp(`^/api/logistics/provider-quotes/(${UUID})/select$`, 'u').exec(path);
        if (match) return logisticsService.selectProviderQuote(client, principal, body.deliveryId, { ...body, quoteId: match[1] });
        for (const [suffix, method] of [['provider-dispatch','requestProviderDispatch'],['provider-cancel','requestProviderCancel'],
          ['provider-tracking','requestProviderTracking'],['provider-reconcile','requestProviderReconciliation']]) {
          match = new RegExp(`^/api/logistics/deliveries/(${UUID})/${suffix}$`, 'u').exec(path);
          if (match) return logisticsService[method](client, principal, match[1], body);
        }
        match = new RegExp(`^/api/logistics/deliveries/(${UUID})/provider-commands$`, 'u').exec(path);
        if (match) return logisticsService.getProviderCommands(client, principal, match[1]);
        match = /^\/api\/logistics\/providers\/([0-9a-f-]{36})$/u.exec(path);
        if (match) return logisticsService.updateProvider(client, principal, match[1], body);
        match = new RegExp(`^/api/logistics/deliveries/(${UUID})/fulfillment$`, 'u').exec(path);
        if (match) {
          if (req.method === 'GET') return logisticsService.getFulfillment(client, principal, match[1]);
          if (req.method === 'PUT') return logisticsService.selectFulfillment(client, principal, match[1], body);
          return logisticsService.updateFulfillment(client, principal, match[1], body);
        }
        match = new RegExp(`^/api/logistics/deliveries/(${UUID})/dispatch-attempts$`, 'u').exec(path);
        if (match) return logisticsService.requestDispatch(client, principal, match[1], body);
        error('NOT_FOUND', 'Recurso não encontrado.');
      }, permission);
      respond(200, result);
      return true;
    } catch (err) {
      errorCode = typeof err?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(err.code) ? err.code : 'INTERNAL_ERROR';
      status = statusFor(errorCode); const safeCode = status === 500 ? 'INTERNAL_ERROR' : errorCode;
      const messages = { INVALID_INPUT: 'Solicitação inválida.', UNAUTHENTICATED: 'Sessão inválida ou expirada.', FORBIDDEN: 'Operação não autorizada.',
        MFA_REQUIRED: 'Esta operação exige MFA verificado.', CSRF_INVALID: 'Validação CSRF inválida.', ORIGIN_INVALID: 'Origem não permitida.',
        RATE_LIMITED: 'Limite de solicitações excedido.', NOT_FOUND: 'Recurso não encontrado.', PAYLOAD_TOO_LARGE: 'Payload excede o limite permitido.',
        REVISION_CONFLICT: 'O registro mudou. Atualize a tela e tente novamente.', INSTALLATION_REQUIRED: 'Sincronize o painel antes de alterar a alocação.',
        DELIVERY_IN_ACTIVE_ROUTE: 'Remova a entrega da rota da frota própria antes de selecionar um provider externo.',
        FULFILLMENT_RECONCILIATION_REQUIRED: 'Registre o encerramento do provider atual antes da reatribuição.',
        PROVIDER_CODE_CONFLICT: 'Código de provider já cadastrado nesta empresa.', CAPACITY_UNKNOWN: 'A capacidade atual não pôde ser confirmada. Recalcule antes de executar.',
        INVALID_ROUTE: 'O plano de rota está incompleto ou mudou. Recalcule antes de executar.', ROUTE_DELIVERY_ALREADY_ACTIVE: 'A entrega já pertence a outra rota ativa.' };
      req.apiErrorCode = safeCode; respond(status, { error: { code: safeCode, message: status >= 500 ? 'Falha interna ao processar a operação logística.' : (messages[safeCode] || 'Operação não permitida.') } });
      return true;
    } finally { try { logger({ requestId, method: req.method, path: url.pathname, status, ...(errorCode ? { errorCode: status === 500 ? 'INTERNAL_ERROR' : errorCode } : {}) }); } catch (_) {} }
  };
}
module.exports = { MAX_BODY, createLogisticsHttpHandler };
