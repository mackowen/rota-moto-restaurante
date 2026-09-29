'use strict';
/** Keeta Open Delivery server adapter. Secrets never leave this process. */
const crypto = require('node:crypto');
function createKeetaService(env = process.env) {
  const cfg = {
    baseUrl: env.KEETA_BASE_URL || 'https://open.mykeeta.com/api/open/opendelivery',
    tokenUrl: env.KEETA_TOKEN_URL || 'https://open.mykeeta.com/api/open/opendelivery/oauth/token',
    clientId: env.KEETA_CLIENT_ID || '', clientSecret: env.KEETA_CLIENT_SECRET || '', appId: env.KEETA_APP_ID || '',
    accessToken: env.KEETA_ACCESS_TOKEN || '', refreshToken: env.KEETA_REFRESH_TOKEN || '',
    paths: { merchant: '/v1/merchant', polling: '/v1/events:polling', ack: '/v1/events/acknowledgment', order: '/v1/orders/:id', confirm: '/v1/orders/:id/confirm', readyForPickup: '/v1/orders/:id/readyForPickup', dispatch: '/v1/orders/:id/dispatch', delivered: '/v1/orders/:id/delivered', cancel: '/v1/orders/:id/requestCancellation' }
  };
  let accessToken = cfg.accessToken, refreshToken = cfg.refreshToken, expiresAt = Number(env.KEETA_ACCESS_TOKEN_EXPIRES_AT || 0);
  function signature(method, url, query = {}, body = {}) {
    if (!cfg.clientSecret) return '';
    const base = new URL(url); const sorted = Object.keys(query).sort().map(k => `${k}=${query[k] ?? ''}`).join('&');
    const rawBody = body && Object.keys(body).length ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
    const message = `${base.origin}${base.pathname}&${sorted}&${rawBody}`;
    return crypto.createHmac('sha256', cfg.clientSecret).update(message).digest('base64');
  }
  async function authenticate() {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error('Keeta: client_id/client_secret não configurados.');
    const grant = refreshToken ? 'refresh_token' : 'app_level_token';
    const body = refreshToken ? { client_id: cfg.clientId, grant_type: grant, refresh_token: refreshToken } : { client_id: cfg.clientId, grant_type: grant, client_secret: cfg.clientSecret };
    const response = await fetch(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || data.error || `Keeta OAuth HTTP ${response.status}`);
    accessToken = data.access_token || ''; refreshToken = data.refresh_token || refreshToken; expiresAt = Date.now() + Number(data.expires_in || 0) * 1000;
    return { authenticated: Boolean(accessToken), expiresAt };
  }
  async function ensureToken() { if (!accessToken || (expiresAt && Date.now() > expiresAt - 60000)) return authenticate(); return { authenticated: true }; }
  async function request(path, options = {}) {
    await ensureToken(); const url = `${cfg.baseUrl.replace(/\/$/, '')}/${String(path).replace(/^\//, '').replace(':id', encodeURIComponent(options.id || ''))}`;
    const body = options.body; const response = await fetch(url, { method: options.method || 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'X-App-Id': cfg.appId, 'X-App-Signature': signature(options.method || 'GET', url, options.query || {}, body || {}), ...(options.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!response.ok) { const e = new Error(data.message || data.error || `Keeta HTTP ${response.status}`); e.status = response.status; e.data = data; throw e; } return data;
  }
  const action = (name, id, body) => request(cfg.paths[name], { id, method: 'POST', body });
  return { config: cfg, authenticate, ensureToken, merchant: () => request(cfg.paths.merchant), poll: () => request(cfg.paths.polling), acknowledge: ids => request(cfg.paths.ack, { method: 'POST', body: { acknowledgedEventIds: [...new Set(ids || [])] } }), order: id => request(cfg.paths.order, { id }), action, signature, diagnostics: () => ({ provider: 'keeta', configured: Boolean(cfg.clientId && cfg.clientSecret), authenticated: Boolean(accessToken), appIdConfigured: Boolean(cfg.appId), signatureConfigured: Boolean(cfg.clientSecret) }) };
}
module.exports = { createKeetaService };
