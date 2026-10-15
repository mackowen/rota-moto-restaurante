'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createBackupControlStore } = require('../backend/runtime/backup-control');
const { createBackupAdminHttpHandler } = require('../backend/admin/backup-http');

const ADMIN_A = '09a9b439-7047-4b58-9682-8753da4a809f';
const ADMIN_B = '45bd3cc4-4783-4b3d-aeba-fec111708fc9';
const SESSION = 'A'.repeat(43);
const auditEvents = [];
async function call(_unused, { method = 'GET', url = '/api/admin/backup', body = null, actor = ADMIN_A, mfa = new Date(), csrf = 'ok', allowlisted = true, origin = 'http://localhost:8787' } = {}) {
  const payload = body === null ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  Object.assign(req, { method, url, headers: { cookie: `__Host-rotamoto_session=${SESSION}`, host: 'localhost:8787',
    ...(body ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(origin ? { origin } : {}) },
    socket: { remoteAddress: '127.0.0.1', encrypted: false }, clientIp: '127.0.0.1' });
  let status, response;
  const res = { writeHead(code) { status = code; }, end(value) { response = value ? JSON.parse(value) : null; } };
  const identityService = {
    async withAuthenticatedTenant(token, operation, permission) {
      assert.equal(token, SESSION); assert.equal(permission, 'company.manage');
      const principal = { user_id: actor, session_id: 'sess', mfa_verified_at: mfa };
      return operation({ query: async () => ({ rows: [] }) }, principal);
    }, async verifyCsrf(_client, _session, token) { return token === 'ok'; }
  };
  const ids = allowlisted ? [ADMIN_A, ADMIN_B] : [];
  const backupHandler = createBackupAdminHttpHandler({ identityService, store: global.store, adminUserIds: ids, allowedOrigin: ['http://localhost:8787'],
    audit: async entry => auditEvents.push(entry) });
  await backupHandler(req, res); return { status, body: response };
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-backup-admin-http-'));
  global.store = createBackupControlStore({ directory: root });
  try {
    assert.equal((await call(null, { allowlisted: false })).status, 503);
    assert.equal((await call(null, { actor: '99a9b439-7047-4b58-9682-8753da4a809f' })).status, 403);
    assert.equal((await call(null, { method: 'POST', url: '/api/admin/backup/jobs', body: { kind: 'backup' }, origin: null })).body.error.code, 'ORIGIN_INVALID');
    assert.equal((await call(null, { method: 'GET', url: '/api/admin/backup?debug=1' })).body.error.code, 'INVALID_INPUT');
    assert.equal((await call(null, { method: 'PUT', url: '/api/admin/backup/config', body: { frequency: 'daily', timeUtc: '02:00', retentionDays: 30, destination: 'local' }, mfa: new Date(Date.now() - 600_000) })).body.error.code, 'BACKUP_REAUTH_REQUIRED');
    assert.equal((await call(null, { method: 'POST', url: '/api/admin/backup/jobs', body: { kind: 'backup', idempotencyKey: 'browser-req-key-000001' }, csrf: '' })).body.error.code, 'CSRF_INVALID');
    const configured = await call(null, { method: 'PUT', url: '/api/admin/backup/config', body: { frequency: 'daily', timeUtc: '02:00', retentionDays: 30, destination: 'local' } });
    assert.equal(configured.status, 200); assert.equal(configured.body.config.frequency, 'daily');
    const queued = await call(null, { method: 'POST', url: '/api/admin/backup/jobs', body: { kind: 'backup', idempotencyKey: 'browser-req-key-000001' } });
    assert.equal(queued.status, 202); assert.equal(queued.body.status, 'QUEUED');
    const duplicate = await call(null, { method: 'POST', url: '/api/admin/backup/jobs', body: { kind: 'backup', idempotencyKey: 'browser-req-key-000001' } });
    assert.equal(duplicate.body.id, queued.body.id); assert.equal(duplicate.body.duplicate, true);
    const request = await call(null, { method: 'POST', url: '/api/admin/backup/restore-requests', body: { recoverySetId: '09a9b439-7047-4b58-9682-8753da4a809f' } });
    assert.equal(request.body.status, 'PENDING_APPROVAL');
    const duplicateRequest = await call(null, { method: 'POST', url: '/api/admin/backup/restore-requests', body: { recoverySetId: '09a9b439-7047-4b58-9682-8753da4a809f' } });
    assert.equal(duplicateRequest.body.id, request.body.id); assert.equal(duplicateRequest.body.duplicate, true);
    const selfApproval = await call(null, { method: 'POST', url: `/api/admin/backup/restore-requests/${request.body.id}/approve`, body: {}, actor: ADMIN_A });
    assert.equal(selfApproval.body.error.code, 'BACKUP_DUAL_APPROVAL_REQUIRED');
    const approved = await call(null, { method: 'POST', url: `/api/admin/backup/restore-requests/${request.body.id}/approve`, body: {}, actor: ADMIN_B });
    assert.equal(approved.body.job.kind, 'restore_test');
    const status = await call(null); assert.equal(status.status, 200); assert.equal(status.body.jobs.length, 2);
    assert.equal(JSON.stringify(status.body).includes(SESSION), false);
    assert(auditEvents.length >= 5); assert(auditEvents.every(entry => entry.actorRef === ADMIN_A || entry.actorRef === ADMIN_B));
    process.stdout.write('Backup admin HTTP: system allowlist, MFA, CSRF, idempotency, dual approval and sanitized status PASS\n');
  } finally { delete global.store; await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
