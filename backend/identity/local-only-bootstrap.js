'use strict';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function isLocalOnlyBootstrapRequest(request, { enabled, databaseName } = {}) {
  if (enabled !== true || databaseName !== 'rotamoto') return false;
  const peer = String(request?.socket?.remoteAddress || '').replace(/^::ffff:/u, '').toLowerCase();
  if (!['127.0.0.1', '::1'].includes(peer)) return false;
  const rawOrigin = request?.headers?.origin;
  if (typeof rawOrigin === 'string' && rawOrigin) {
    let origin;
    try { origin = new URL(rawOrigin); } catch (_) { return false; }
    if (!['http:', 'https:'].includes(origin.protocol) || !LOOPBACK.has(origin.hostname.toLowerCase()) ||
        origin.username || origin.password || origin.search || origin.hash) return false;
  } else {
    let host;
    try { host = new URL(`http://${request?.headers?.host || ''}`); } catch (_) { return false; }
    if (!LOOPBACK.has(host.hostname.toLowerCase()) || host.username || host.password) return false;
  }
  return true;
}

module.exports = { isLocalOnlyBootstrapRequest };
