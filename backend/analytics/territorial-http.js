'use strict';

const crypto = require('node:crypto');
const { COOKIE_NAME, createRateLimiter } = require('../identity/http');

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function token(req) {
  const values = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE_NAME}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
}
function sameOrigin(req, allowed = []) {
  if (!req.headers.origin) return;
  let origin; try { origin = new URL(req.headers.origin).origin; } catch (_) { fail('ORIGIN_INVALID'); }
  const own = `${req.socket.encrypted ? 'https' : 'http'}://${String(req.headers.host || '').toLowerCase()}`;
  if (origin.toLowerCase() !== own && !allowed.includes(origin)) fail('ORIGIN_INVALID');
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) fail('INVALID_INPUT');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4096) { req.resume(); fail('PAYLOAD_TOO_LARGE'); } chunks.push(chunk); }
  try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!result || Array.isArray(result) || typeof result !== 'object') fail('INVALID_INPUT'); return result; }
  catch (error) { if (error.code) throw error; fail('INVALID_INPUT'); }
}
function createTerritorialAnalyticsHttpHandler({ identityService, service, rateLimiter = createRateLimiter(), allowedOrigin = [], logger = () => {} }) {
  if (!identityService || !service) throw new TypeError('Serviços de identidade e analytics territorial obrigatórios.');
  return async function territorialAnalyticsHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/analytics/territorial')) return false;
    const requestId = req.requestId || crypto.randomUUID(); let status = 500, errorCode;
    const send = (code, value) => { status = code; const text = JSON.stringify({ ...value, requestId });
      res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Pragma':'no-cache',
        'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Request-ID':requestId,'Content-Length':Buffer.byteLength(text) }); res.end(text); };
    try {
      const match = /^\/api\/analytics\/territorial(?:\/deliveries\/([0-9a-f-]{36})\/destination)?$/iu.exec(url.pathname);
      if (!match) fail('NOT_FOUND');
      const destination = Boolean(match[1]), write = destination && req.method === 'PUT';
      if (destination ? !['GET','PUT'].includes(req.method) : req.method !== 'GET') { status = 405; send(status, { error:{code:'METHOD_NOT_ALLOWED',message:'Método não permitido.'} }); return true; }
      if (!rateLimiter.consume(`${req.clientIp || req.socket.remoteAddress || 'unknown'}:${write ? 'territorial-write' : 'territorial-read'}`).allowed) fail('RATE_LIMITED');
      if (write) sameOrigin(req, allowedOrigin);
      const session = token(req); if (!session) fail('UNAUTHENTICATED');
      const query = Object.create(null);
      for (const [key,value] of url.searchParams) { if (Object.hasOwn(query,key)) fail('INVALID_INPUT'); query[key] = value; }
      if (destination && Object.keys(query).length) fail('INVALID_INPUT');
      const input = write ? await body(req) : null;
      const permission = destination ? 'company.manage' : 'orders.read';
      const result = await identityService.withAuthenticatedTenant(session, async (client, principal) => {
        if (!destination && principal.driver_id) fail('FORBIDDEN');
        if (write) {
          const csrf = req.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !await identityService.verifyCsrf(client, principal.session_id, csrf)) fail('CSRF_INVALID');
          return service.setDestination(client, principal, match[1], input);
        }
        return destination ? service.destinationStatus(client,principal,match[1]) : service.heatmap(client, principal, query);
      }, permission);
      send(200, result); return true;
    } catch (error) {
      errorCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'INTERNAL_ERROR';
      const map = { INVALID_INPUT:400,UNAUTHENTICATED:401,FORBIDDEN:403,MFA_REQUIRED:403,CSRF_INVALID:403,ORIGIN_INVALID:403,
        RATE_LIMITED:429,NOT_FOUND:404,PAYLOAD_TOO_LARGE:413,RECORTE_LIMIT_EXCEEDED:422,REVISION_CONFLICT:409 };
      status = map[errorCode] || 500;
      const safe = status === 500 ? 'INTERNAL_ERROR' : errorCode;
      const messages = { INVALID_INPUT:'Filtro ou localização inválida.',UNAUTHENTICATED:'Sessão inválida ou expirada.',FORBIDDEN:'Operação não autorizada.',
        MFA_REQUIRED:'Esta operação exige MFA verificado.',CSRF_INVALID:'Validação CSRF inválida.',ORIGIN_INVALID:'Origem não permitida.',
        RATE_LIMITED:'Limite de solicitações excedido.',NOT_FOUND:'Entrega ou recurso não encontrado.',PAYLOAD_TOO_LARGE:'Payload excede o limite permitido.',
        REVISION_CONFLICT:'O destino foi alterado em outra sessão. Atualize e tente novamente.',
        RECORTE_LIMIT_EXCEEDED:'Reduza o período ou os filtros do relatório.' };
      req.apiErrorCode = safe; send(status,{error:{code:safe,message:messages[safe]||'Falha interna ao consultar analytics territorial.'}}); return true;
    } finally { try { logger({ requestId,method:req.method,path:url.pathname,status,...(errorCode?{errorCode:status===500?'INTERNAL_ERROR':errorCode}:{}) }); } catch (_) {} }
  };
}
module.exports = { createTerritorialAnalyticsHttpHandler };
