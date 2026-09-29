'use strict';
/**
 * 99Food server-side adapter.
 * The 99Food developer portal provides sandbox/certification and API order integration.
 * Endpoint paths are configurable because the public portal requires partner-specific
 * credentials/authorization and may evolve independently of the local app.
 */
const crypto = require('node:crypto');

function create99FoodService(env = process.env) {
  const cfg = {
    baseUrl: env.FOOD99_BASE_URL || '',
    tokenUrl: env.FOOD99_TOKEN_URL || '',
    clientId: env.FOOD99_CLIENT_ID || '',
    clientSecret: env.FOOD99_CLIENT_SECRET || '',
    accessToken: env.FOOD99_ACCESS_TOKEN || '',
    webhookSecret: env.FOOD99_WEBHOOK_SECRET || '',
    paths: {
      orders: env.FOOD99_ORDERS_PATH || '/orders',
      order: env.FOOD99_ORDER_PATH || '/orders/:id',
      confirm: env.FOOD99_CONFIRM_PATH || '/orders/:id/confirm',
      cancel: env.FOOD99_CANCEL_PATH || '/orders/:id/cancel',
      ready: env.FOOD99_READY_PATH || '/orders/:id/ready',
      dispatch: env.FOOD99_DISPATCH_PATH || '/orders/:id/dispatch'
    }
  };
  let token = cfg.accessToken;
  let expiresAt = Number(env.FOOD99_ACCESS_TOKEN_EXPIRES_AT || 0);

  const configured = () => Boolean(cfg.baseUrl && ((cfg.clientId && cfg.clientSecret) || token));
  const urlFor = (path, id) => {
    const p = String(path).replace(':id', encodeURIComponent(id || ''));
    return `${cfg.baseUrl.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
  };
  async function request(path, options = {}) {
    if (!cfg.baseUrl) throw new Error('99Food: FOOD99_BASE_URL não configurada.');
    if (!token) await authenticate();
    const response = await fetch(urlFor(path, options.id), {
      method: options.method || 'GET',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) { const e = new Error(data.message || data.error || `99Food HTTP ${response.status}`); e.status = response.status; e.data = data; throw e; }
    return data;
  }
  async function authenticate() {
    if (!cfg.tokenUrl || !cfg.clientId || !cfg.clientSecret) throw new Error('99Food: credenciais/URL de autorização não configuradas.');
    const response = await fetch(cfg.tokenUrl, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || `Falha de autenticação 99Food (${response.status})`);
    token = data.accessToken || data.access_token || '';
    expiresAt = Date.now() + Number(data.expiresIn || data.expires_in || 0) * 1000;
    return { authenticated: Boolean(token), expiresAt };
  }
  async function ensureToken() { if (!token || (expiresAt && Date.now() > expiresAt - 60000)) return authenticate(); return { authenticated: true }; }
  async function orders() { await ensureToken(); return request(cfg.paths.orders); }
  async function order(id) { await ensureToken(); return request(cfg.paths.order, { id }); }
  async function action(name, id, body) { await ensureToken(); const path = cfg.paths[name]; if (!path) throw new Error(`99Food: ação ${name} não configurada.`); return request(path, { id, method: 'POST', body }); }
  function verifyWebhook(rawBody, signature) {
    if (!cfg.webhookSecret) return { configured: false, valid: null };
    if (!signature) return { configured: true, valid: false };
    const expected = crypto.createHmac('sha256', cfg.webhookSecret).update(rawBody).digest('hex');
    return { configured: true, valid: crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))) };
  }
  return { config: cfg, configured, authenticate, ensureToken, orders, order, action, verifyWebhook, diagnostics: () => ({ provider: '99food', configured: configured(), baseUrlConfigured: Boolean(cfg.baseUrl), tokenConfigured: Boolean(token), webhookVerificationConfigured: Boolean(cfg.webhookSecret) }) };
}
module.exports = { create99FoodService };
