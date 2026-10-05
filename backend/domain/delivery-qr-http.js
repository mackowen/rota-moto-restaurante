'use strict';

const crypto = require('node:crypto');
const { createRateLimiter } = require('../identity/http');

function createDeliveryQrHttpHandler({ identityService, queryService, qrService = null, rateLimiter = createRateLimiter(), logger = () => {} } = {}) {
  if (!identityService || !queryService) throw new TypeError('Serviços de identidade e consulta obrigatórios.');
  const route = /^\/api\/delivery-qr\/(keys|deliveries\/([0-9a-f-]{36}))$/iu;
  return async function deliveryQrHttpHandler(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/delivery-qr/')) return false;
    const requestId = req.requestId || crypto.randomUUID();
    const startedAt = Date.now();
    let status = 500, errorCode;
    const respond = (code, body) => {
      status = code;
      const text = JSON.stringify({ ...body, requestId });
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Request-ID': requestId,
        'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    try {
      const match = route.exec(url.pathname);
      if (!match) { respond(404, { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } }); return true; }
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store', 'X-Request-ID': requestId }); res.end(); status = 405; return true; }
      if (!qrService) { errorCode = 'DELIVERY_QR_UNAVAILABLE'; respond(503, { error: { code: errorCode, message: 'QR seguro indisponível nesta instalação.' } }); return true; }
      if (!rateLimiter.consume(`${req.clientIp || req.socket.remoteAddress || 'unknown'}:${url.pathname}`).allowed)
        throw Object.assign(new Error('Limite de solicitações excedido.'), { code: 'RATE_LIMITED' });
      const cookies = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith('__Host-rotamoto_session='));
      const token = cookies.length === 1 ? cookies[0].slice('__Host-rotamoto_session='.length) : null;
      if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw Object.assign(new Error('Sessão inválida.'), { code: 'UNAUTHENTICATED' });
      if (match[1] === 'keys') {
        const key = await identityService.withAuthenticatedTenant(token, async () => qrService.publicKey(), 'sync.pull');
        respond(200, { keys: [key] }); return true;
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(match[2]))
        throw Object.assign(new Error('Identificador inválido.'), { code: 'INVALID_INPUT' });
      const signed = await identityService.withAuthenticatedTenant(token, async (client, principal) => {
        const result = await queryService.get(client, principal, 'deliveries', match[2]);
        const delivery = result.record;
        if (!delivery || delivery.id !== result.id || delivery.companyId !== principal.company_id ||
            !Number.isSafeInteger(Number(result.version)) || Number(result.version) < 1 ||
            delivery.deletedAt || !['ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'REDELIVERY'].includes(delivery.status))
          throw Object.assign(new Error('Entrega não elegível para QR.'), { code: 'NOT_FOUND' });
        return { token: await qrService.issue({ deliveryId: result.id, companyId: principal.company_id, revision: Number(result.version) }),
          expiresInSeconds: 12 * 60 * 60, revision: Number(result.version) };
      }, 'sync.pull');
      respond(200, signed); return true;
    } catch (error) {
      errorCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'INTERNAL_ERROR';
      const map = { INVALID_INPUT: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, DRIVER_LINK_REQUIRED: 403,
        NOT_FOUND: 404, RATE_LIMITED: 429, DELIVERY_QR_UNAVAILABLE: 503 };
      status = map[errorCode] || 500;
      const code = status === 500 ? 'INTERNAL_ERROR' : errorCode;
      req.apiErrorCode = code;
      const messages = { INVALID_INPUT: 'Solicitação inválida.', UNAUTHENTICATED: 'Sessão inválida ou expirada.',
        FORBIDDEN: 'Operação não autorizada.', DRIVER_LINK_REQUIRED: 'Associação de motorista não configurada.',
        NOT_FOUND: 'Entrega não encontrada.', RATE_LIMITED: 'Limite de solicitações excedido.',
        DELIVERY_QR_UNAVAILABLE: 'QR seguro indisponível nesta instalação.', INTERNAL_ERROR: 'Falha interna ao emitir QR.' };
      respond(status, { error: { code, message: messages[code] || messages.INTERNAL_ERROR }, ...(status === 429 ? { retryAfterSeconds: 60 } : {}) });
      return true;
    } finally {
      try { logger({ requestId, method: req.method, path: url.pathname, status, durationMs: Date.now() - startedAt, ...(errorCode ? { errorCode } : {}) }); } catch (_) {}
    }
  };
}

module.exports = { createDeliveryQrHttpHandler };
