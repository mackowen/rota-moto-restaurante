'use strict';

const crypto = require('node:crypto');
const { createRateLimiter } = require('../identity/http');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RECENT_MFA_MS = 5 * 60 * 1000;
function createBackupAdminHttpHandler({ identityService, store, destinationStore = null, adminUserIds = [], rateLimiter = createRateLimiter(), allowedOrigin, logger = () => {}, audit = async () => {}, clock = () => new Date() }) {
  const admins = new Set(adminUserIds.map(value => String(value).toLowerCase()).filter(value => UUID.test(value)));
  const allowList = Array.isArray(allowedOrigin) ? allowedOrigin.filter(value => typeof value === 'string') : [allowedOrigin].filter(Boolean);
  if (!identityService || !store) throw new TypeError('Identity e backup control obrigatórios.');
  return async function backupAdminHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/admin/backup')) return false;
    const requestId = req.requestId || crypto.randomUUID(); req.requestId = requestId; res.req = req;
    const startedAt = Date.now(); let status = 500, errorCode = null;
    const send = (code, payload) => { status = code; const body = JSON.stringify({ ...payload, requestId });
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", 'X-Request-ID': requestId,
        'Vary': 'Origin', ...(allowList.includes(req.headers.origin) ? { 'Access-Control-Allow-Origin': req.headers.origin,
          'Access-Control-Allow-Credentials': 'true' } : {}),
        'Content-Length': Buffer.byteLength(body) }); res.end(body); };
    try {
      if (!admins.size) throw Object.assign(new Error(), { code: 'BACKUP_ADMIN_NOT_CONFIGURED' });
      const expected = url.pathname === '/api/admin/backup' ? (req.method === 'GET' ? 'status' : null) :
        url.pathname === '/api/admin/backup/config' ? 'config' :
        url.pathname === '/api/admin/backup/jobs' ? 'jobs' :
        url.pathname === '/api/admin/backup/destinations' ? (req.method === 'GET' ? 'destinations' : req.method === 'PUT' ? 'destination-save' : null) :
        /^\/api\/admin\/backup\/destinations\/[0-9a-f-]{36}\/test$/iu.test(url.pathname) ? 'destination-test' :
        /^\/api\/admin\/backup\/destinations\/[0-9a-f-]{36}\/disable$/iu.test(url.pathname) ? 'destination-disable' :
        url.pathname === '/api/admin/backup/restore-requests' ? 'restore-request' :
        /^\/api\/admin\/backup\/restore-requests\/[0-9a-f-]{36}\/approve$/iu.test(url.pathname) ? 'restore-approve' : null;
      const methods = { status: 'GET', config: 'PUT', jobs: 'POST', destinations: 'GET', 'destination-save': 'PUT', 'destination-test': 'POST', 'destination-disable': 'POST', 'restore-request': 'POST', 'restore-approve': 'POST' };
      if (!expected) throw Object.assign(new Error(), { code: 'NOT_FOUND' });
      if (req.method !== methods[expected]) throw Object.assign(new Error(), { code: 'METHOD_NOT_ALLOWED' });
      if (url.search || url.hash) throw Object.assign(new Error(), { code: 'INVALID_INPUT' });
      const rate = rateLimiter.consume(`${req.clientIp || req.socket.remoteAddress || 'unknown'}:${url.pathname}`);
      if (!rate.allowed) throw Object.assign(new Error(), { code: 'RATE_LIMITED' });
      const parts = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith('__Host-rotamoto_session='));
      const token = parts.length === 1 ? parts[0].slice('__Host-rotamoto_session='.length) : null;
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token || '')) throw Object.assign(new Error(), { code: 'UNAUTHENTICATED' });
      const origin = req.headers.origin;
      if (req.method !== 'GET' && (!origin || !allowList.includes(origin) && origin.toLowerCase() !== `${req.socket.encrypted ? 'https' : 'http'}://${String(req.headers.host || '').toLowerCase()}`))
        throw Object.assign(new Error(), { code: 'ORIGIN_INVALID' });
      const body = req.method === 'GET' ? null : await readJson(req);
      const outcome = await identityService.withAuthenticatedTenant(token, async (client, principal) => {
        if (!admins.has(String(principal.user_id).toLowerCase())) throw Object.assign(new Error(), { code: 'FORBIDDEN' });
        if (req.method !== 'GET' && (!await identityService.verifyCsrf(client, principal.session_id, req.headers['x-csrf-token'])))
          throw Object.assign(new Error(), { code: 'CSRF_INVALID' });
        if (expected === 'status') {
          const result = await store.read();
          if (destinationStore) result.destinations = await destinationStore.list();
          return { result, actorRef: principal.user_id, action: null };
        }
        if (expected === 'destinations') {
          if (!destinationStore) throw Object.assign(new Error(), { code: 'BACKUP_DESTINATION_STORE_UNAVAILABLE' });
          return { result: { destinations: await destinationStore.list() }, actorRef: principal.user_id, action: null };
        }
        if (expected === 'destination-save') {
          requireRecentMfa(principal);
          if (!destinationStore) throw Object.assign(new Error(), { code: 'BACKUP_DESTINATION_STORE_UNAVAILABLE' });
          return { result: await destinationStore.save(body), actorRef: principal.user_id, action: 'backup.destination.saved' };
        }
        if (expected === 'destination-disable') {
          requireRecentMfa(principal); exact(body, []);
          if (!destinationStore) throw Object.assign(new Error(), { code: 'BACKUP_DESTINATION_STORE_UNAVAILABLE' });
          return { result: await destinationStore.disable(url.pathname.split('/')[4]), actorRef: principal.user_id, action: 'backup.destination.disabled' };
        }
        if (expected === 'destination-test') {
          requireRecentMfa(principal); exact(body, []);
          if (!destinationStore) throw Object.assign(new Error(), { code: 'BACKUP_DESTINATION_STORE_UNAVAILABLE' });
          const destination = await destinationStore.credentials(url.pathname.split('/')[4]);
          const storageProviders = require('../runtime/backup-storage-providers');
          let result;
          try {
            result = destination.provider === 'sftp' ? await storageProviders.createSftpBackupProvider({ ...destination, ...destination.credentials }).test() :
              await storageProviders.createS3BackupProvider({ ...destination, ...destination.credentials, test: process.env.NODE_ENV === 'test' }).test();
            if (typeof destinationStore.recordTest === 'function') await destinationStore.recordTest(destination.id, { ok: true });
          } catch (error) {
            await destinationStore.recordTest?.(destination.id, { ok: false, errorCode: error.code }).catch(() => {});
            await audit({ actorRef: principal.user_id, action: 'backup.destination.test.failed', requestId, objectId: destination.id, result: 'rejected' }).catch(() => {});
            throw error;
          }
          return { result, actorRef: principal.user_id, action: 'backup.destination.tested' };
        }
        if (expected === 'config') {
          requireRecentMfa(principal);
          return { result: await store.configure(body, principal.user_id), actorRef: principal.user_id, action: 'backup.config.updated' };
        }
        if (expected === 'jobs') {
          requireRecentMfa(principal);
          exact(body, ['kind', 'recoverySetId', 'idempotencyKey']);
          return { result: await store.enqueue(body.kind, principal.user_id, body), actorRef: principal.user_id,
            action: body.kind === 'backup' ? 'backup.job.requested' : `backup.${body.kind}.requested` };
        }
        if (expected === 'restore-request') {
          requireRecentMfa(principal); exact(body, ['recoverySetId', 'destinationId']);
          return { result: await store.requestRestore(body.recoverySetId, principal.user_id, body.destinationId || null), actorRef: principal.user_id, action: 'backup.restore.requested' };
        }
        requireRecentMfa(principal); exact(body, []);
        const id = url.pathname.split('/')[5];
        return { result: await store.approveRestore(id, principal.user_id, true), actorRef: principal.user_id, action: 'backup.restore.approved' };
      }, 'company.manage');
      const { result, actorRef, action } = outcome;
      if (action) await audit({ actorRef, action, requestId, objectId: result.id || result.job?.id || result.request?.id || null,
        result: 'accepted' });
      send(expected === 'jobs' || expected === 'restore-request' ? 202 : 200, result);
      return true;
    } catch (error) {
      errorCode = /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'INTERNAL_ERROR';
      const code = ({ BACKUP_ADMIN_NOT_CONFIGURED: 503, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, UNAUTHENTICATED: 401,
        FORBIDDEN: 403, MFA_REQUIRED: 403, BACKUP_REAUTH_REQUIRED: 403, CSRF_INVALID: 403, ORIGIN_INVALID: 403,
        RATE_LIMITED: 429, BACKUP_CONFIG_INVALID: 400, BACKUP_JOB_KIND_INVALID: 400, RECOVERY_SET_ID_INVALID: 400,
        INVALID_INPUT: 400, UNSUPPORTED_MEDIA_TYPE: 415, PAYLOAD_TOO_LARGE: 413,
        BACKUP_JOB_ALREADY_ACTIVE: 409, BACKUP_CONTROL_BUSY: 503, BACKUP_DESTINATION_STORE_UNAVAILABLE: 503, BACKUP_DESTINATION_NOT_FOUND: 404,
        BACKUP_DESTINATION_INVALID: 400, BACKUP_DESTINATION_CREDENTIAL_REQUIRED: 400, BACKUP_DESTINATION_NAME_CONFLICT: 409,
        BACKUP_DESTINATION_STORE_UNSAFE: 503, BACKUP_DESTINATION_STORE_INVALID: 503, BACKUP_SFTP_HOST_KEY_REQUIRED: 400,
        BACKUP_SFTP_HOST_KEY_CONFIRMATION_REQUIRED: 400, BACKUP_SFTP_HOST_KEY_MISMATCH: 400, BACKUP_SFTP_CONFIGURATION_INVALID: 400,
        BACKUP_S3_CONFIGURATION_INVALID: 400, BACKUP_REMOTE_ENDPOINT_INVALID: 400, BACKUP_REMOTE_PATH_INVALID: 400,
        BACKUP_REMOTE_AUTH_REJECTED: 502, BACKUP_REMOTE_REJECTED: 502, BACKUP_REMOTE_RETRYABLE: 503,
        BACKUP_REMOTE_VERIFY_FAILED: 502, BACKUP_REMOTE_OBJECT_NOT_FOUND: 404, BACKUP_REMOTE_CONFLICT: 409,
        BACKUP_PRIMARY_DESTINATION_REQUIRED: 400, BACKUP_DESTINATION_NOT_AVAILABLE: 409,
        BACKUP_JOB_ALREADY_ACTIVE: 409, BACKUP_CONTROL_BUSY: 503, BACKUP_RESTORE_REQUEST_NOT_FOUND: 404,
        BACKUP_RESTORE_REQUEST_NOT_PENDING: 409, BACKUP_DUAL_APPROVAL_REQUIRED: 403 })[errorCode] || 500;
      send(code, { error: { code: code === 500 ? 'INTERNAL_ERROR' : errorCode,
        message: code === 500 ? 'Falha ao processar operação de backup.' : errorCode === 'BACKUP_REAUTH_REQUIRED' ?
          'Reautentique sua sessão com MFA recente para continuar.' : 'Operação de backup não autorizada ou inválida.' } });
      return true;
    } finally { try { logger({ event: 'backup.admin.request', requestId, method: req.method, path: url.pathname, status, durationMs: Date.now() - startedAt, ...(errorCode ? { errorCode } : {}) }); } catch (_) {} }
  };
}
function requireRecentMfa(principal) {
  const at = principal.mfa_verified_at instanceof Date ? principal.mfa_verified_at.getTime() : Date.parse(principal.mfa_verified_at || '');
  if (!Number.isFinite(at) || at > Date.now() + 5000 || Date.now() - at > RECENT_MFA_MS) throw Object.assign(new Error(), { code: 'BACKUP_REAUTH_REQUIRED' });
}
async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type'] || '')) throw Object.assign(new Error(), { code: 'UNSUPPORTED_MEDIA_TYPE' });
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) { req.resume(); throw Object.assign(new Error(), { code: 'PAYLOAD_TOO_LARGE' }); } chunks.push(chunk); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { throw Object.assign(new Error(), { code: 'INVALID_INPUT' }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error(), { code: 'INVALID_INPUT' }); return data;
}
function exact(body, fields) { if (Object.keys(body).some(key => !fields.includes(key))) throw Object.assign(new Error(), { code: 'INVALID_INPUT' }); }
module.exports = { createBackupAdminHttpHandler, requireRecentMfa, RECENT_MFA_MS };
