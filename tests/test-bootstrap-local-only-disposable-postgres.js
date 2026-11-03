'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Client } = require('pg');
const { createPool } = require('../backend/postgres/connection');
const { getMigrations } = require('../backend/postgres/migrate');
const { createIdentityService } = require('../backend/identity/service');
const { createIdentityHttpHandler } = require('../backend/identity/http');
const { createNativeMfaProvider } = require('../backend/identity/native-mfa-provider');
const { codeAt } = require('../backend/identity/totp');
const { issueBrowserBootstrapAuthorization } = require('../scripts/prepare-browser-bootstrap');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { if (stderr.length < 1600) stderr += chunk.slice(0, 1600 - stderr.length); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code ?? 'signal'}): ${stderr.slice(0, 500)}`)));
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

async function runBrowserBootstrapCliInPty({ port, root }) {
  const secretDirectory = path.join(root, 'operator-keystore');
  await fs.mkdir(secretDirectory, { mode: 0o700 });
  const masterKeyFile = path.join(root, 'operator-master.key');
  const key = crypto.randomBytes(32);
  try { await fs.writeFile(masterKeyFile, key, { flag: 'wx', mode: 0o600 }); } finally { key.fill(0); }
  const appDirectory = path.resolve(__dirname, '..');
  const shellCommand = `cd "${appDirectory}" && npm run bootstrap:prepare-browser`;
  const env = { ...process.env, NODE_ENV: 'development', DATABASE_URL: `postgresql://rotamoto_app@127.0.0.1:${port}/rotamoto`,
    ROTAMOTO_SECRET_STORE_DIRECTORY: secretDirectory, ROTAMOTO_SECRET_MASTER_KEY_FILE: masterKeyFile,
    ROTAMOTO_OPERATOR_AUDIT_LOG: path.join(root, 'operator-audit.jsonl'), ROTAMOTO_OPERATOR_ACTOR_REF: 'test:local-termux-operator',
    SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '' };
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-q', '-e', '-c', shellCommand, '/dev/null'], { cwd: appDirectory,
      env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { if (stdout.length < 12000) stdout += chunk.slice(0, 12000 - stdout.length); });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (stderr.length < 1200) stderr += chunk.slice(0, 1200 - stderr.length); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The local bootstrap CLI exceeded its disposable test timeout.')); }, 25000);
    child.once('error', error => { clearTimeout(timer); reject(new Error(`Could not start local bootstrap CLI PTY: ${error.code || 'ERROR'}`)); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Local bootstrap CLI failed in disposable Termux PTY (${code ?? 'signal'}): ${stderr.replace(/[A-Za-z0-9_-]{43}/gu, '[redacted]').slice(-500)}`));
      const tokens = stdout.split(/\r?\n/u).map(line => line.trim()).filter(line => /^[A-Za-z0-9_-]{43}$/u.test(line));
      if (tokens.length !== 1 || !stdout.includes('Autorização inicial (válida por 10 minutos; use uma única vez)'))
        return reject(new Error('Local bootstrap CLI did not emit exactly one expected temporary authorization.'));
      const token = tokens[0]; stdout = '';
      resolve(token);
    });
    child.stdin.end('PREPARAR PRIMEIRA INSTALACAO\n');
  });
}

async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.ROTAMOTO_LOCAL_ONLY_DISPOSABLE, '0304', 'refuse to run outside the explicitly disposable 0304 fixture');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-local-only-0304-'));
  const dataDir = path.join(root, 'pgdata'), port = await freePort();
  const adminUrl = `postgresql://rm_local_test_admin@127.0.0.1:${port}/postgres`;
  let postgresStarted = false, server, verifier;
  const pool = createPool({ connectionString: `postgresql://rotamoto_app@127.0.0.1:${port}/rotamoto`, max: 4, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});
  const admin = new Client({ connectionString: adminUrl });
  try {
    await run('initdb', ['-D', dataDir, '-U', 'rm_local_test_admin', '--auth-local=trust', '--auth-host=trust', '--no-instructions']);
    await run('pg_ctl', ['-D', dataDir, '-l', path.join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=50`, '-w', 'start']);
    postgresStarted = true;
    await admin.connect();
    await admin.query('CREATE ROLE rotamoto_migrator LOGIN');
    await admin.query('CREATE ROLE rotamoto_app LOGIN');
    await admin.query('CREATE ROLE rotamoto_provider_worker LOGIN');
    await admin.query('CREATE ROLE rotamoto_provider_resolver LOGIN');
    await admin.query('CREATE ROLE rotamoto_e2e_app LOGIN');
    await admin.query('CREATE DATABASE rotamoto OWNER rotamoto_migrator');
    await admin.end();

    const migrationAdmin = new Client({ connectionString: `postgresql://rm_local_test_admin@127.0.0.1:${port}/rotamoto` });
    await migrationAdmin.connect();
    try {
      await migrationAdmin.query('CREATE SCHEMA rotamoto');
      await migrationAdmin.query(`CREATE TABLE rotamoto.schema_migrations (
        migration_id text PRIMARY KEY,
        checksum_sha256 char(64) NOT NULL CHECK(checksum_sha256 ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now())`);
      for (const migration of getMigrations()) {
        await migrationAdmin.query('BEGIN');
        try {
          await migrationAdmin.query(migration.up);
          await migrationAdmin.query('INSERT INTO rotamoto.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)', [migration.id, migration.checksum]);
          await migrationAdmin.query('COMMIT');
        } catch (error) {
          await migrationAdmin.query('ROLLBACK');
          throw new Error(`Disposable local-only migration ${migration.id} failed: ${error.code || error.message}`);
        }
      }
      const founderAuditMigration = getMigrations().find(migration => migration.id === '0070_founder_mfa_audit_actor_kind');
      await migrationAdmin.query('BEGIN');
      await migrationAdmin.query(founderAuditMigration.down);
      await migrationAdmin.query("DELETE FROM rotamoto.schema_migrations WHERE migration_id='0070_founder_mfa_audit_actor_kind'");
      await migrationAdmin.query('COMMIT');
      const revertedConstraint = await migrationAdmin.query(`SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='rotamoto.platform_admin_audit_log'::regclass
          AND conname='platform_admin_audit_log_actor_kind_check'`);
      assert.match(revertedConstraint.rows[0].definition, /platform_admin.*local_operator/u);
      assert.doesNotMatch(revertedConstraint.rows[0].definition, /user/u);
      await migrationAdmin.query('BEGIN');
      await migrationAdmin.query(founderAuditMigration.up);
      await migrationAdmin.query('INSERT INTO rotamoto.schema_migrations(migration_id,checksum_sha256) VALUES($1,$2)',
        [founderAuditMigration.id, founderAuditMigration.checksum]);
      await migrationAdmin.query('COMMIT');
      const reappliedConstraint = await migrationAdmin.query(`SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid='rotamoto.platform_admin_audit_log'::regclass
          AND conname='platform_admin_audit_log_actor_kind_check'`);
      assert.match(reappliedConstraint.rows[0].definition, /platform_admin.*local_operator.*user/u);
    } finally { await migrationAdmin.end(); }

    const secretValues = new Map();
    const secretProvider = {
      async put({ value }) { const secretRef = `test-secret:${crypto.randomUUID()}`; secretValues.set(secretRef, value); return { secretRef }; },
      async get(secretRef) { if (!secretValues.has(secretRef)) throw new Error('disposable secret not found'); return secretValues.get(secretRef); },
      async remove(secretRef) { secretValues.delete(secretRef); }
    };
    async function issueInTransaction() {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const issued = await issueBrowserBootstrapAuthorization(client);
        await client.query('COMMIT');
        return issued;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    }
    const issuanceRace = await Promise.allSettled([issueInTransaction(), issueInTransaction()]);
    const issuedCandidates = issuanceRace.filter(item => item.status === 'fulfilled').map(item => item.value);
    const blockedIssuers = issuanceRace.filter(item => item.status === 'rejected');
    assert.equal(issuedCandidates.length, 1, 'the advisory lock permits exactly one active authorization issuance');
    assert.equal(blockedIssuers.length, 1);
    assert.equal(blockedIssuers[0].reason.code, 'BOOTSTRAP_AUTHORIZATION_EXISTS');
    let currentAuthorization = issuedCandidates[0];
    let capability = currentAuthorization.capability.toString('base64url');
    let digest = Buffer.from(currentAuthorization.digest);
    assert.match(capability, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(digest.equals(crypto.createHash('sha256').update(capability).digest()), true);
    const persistedDigest = await pool.query('SELECT token_digest FROM rotamoto.bootstrap_authorizations WHERE token_digest=$1', [digest]);
    assert.equal(persistedDigest.rowCount, 1, 'issuer persisted the digest under the installation scope');
    assert.equal(persistedDigest.rows[0].token_digest.equals(Buffer.from(capability, 'base64url')), false,
      'database never stores the raw capability');
    currentAuthorization.capability.fill(0); currentAuthorization.digest.fill(0);
    const emailDeliveries = [];
    const identityService = createIdentityService({ pool, requireBootstrapAuthorization: true, emailProvider: { async send(message) { emailDeliveries.push(message); } },
      secretProvider, mfaProvider: createNativeMfaProvider({ secretProvider }), authorizeProvisioner: async ({ context }) => {
        const req = context.request, peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/u, '');
        const origin = new URL(req.headers.origin || '');
        const received = req.headers['x-rotamoto-bootstrap-authorization'];
        assert.equal(peer, '127.0.0.1', 'backend authority is tied to the actual socket peer');
        assert(['127.0.0.1', '::1', 'localhost'].includes(origin.hostname), 'origin is loopback-only');
        if (typeof received !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(received))
          throw Object.assign(new Error('unauthorized'), { code: 'PROVISIONER_UNAUTHORIZED' });
        const target = await pool.query('SELECT current_database() AS database,current_user AS role,session_user AS session_role');
        assert.deepEqual(target.rows[0], { database: 'rotamoto', role: 'rotamoto_app', session_role: 'rotamoto_app' });
        const receivedDigest = crypto.createHash('sha256').update(received, 'utf8').digest();
        const active = await pool.query(`SELECT 1 FROM rotamoto.bootstrap_authorizations WHERE token_digest=$1
          AND installation_scope='rotamoto' AND consumed_at IS NULL AND expires_at>now()`, [receivedDigest]);
        receivedDigest.fill(0);
        if (!active.rowCount) throw Object.assign(new Error('unauthorized'), { code: 'PROVISIONER_UNAUTHORIZED' });
        assert.equal((await identityService.getBootstrapStatus()).state, 'ready');
        return { actorRef: 'test:local-only-disposable', localOnly: context.requestedLocalOnly === true,
          bootstrapCapabilityDigest: crypto.createHash('sha256').update(received, 'utf8').digest() };
      } });
    const bootstrapReadiness = async req => ({ mfaKeystoreConfigured: true, smtpTransportConfigured: false,
      invitationDeliveryConfigured: false, localOnlyBootstrapAvailable: req?.socket?.remoteAddress === '127.0.0.1' &&
        ['127.0.0.1', 'localhost'].includes(new URL(req?.headers?.origin || 'http://invalid').hostname) });
    const handler = createIdentityHttpHandler({ identityService, bootstrapReadiness });
    server = http.createServer((req, res) => { req.requestId = crypto.randomUUID(); void handler(req, res); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function call(route, body, authorization = null) {
      const response = await fetch(`${origin}${route}`, { method: route.endsWith('/status') ? 'GET' : 'POST', headers: {
        Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authorization ? { 'X-RotaMoto-Bootstrap-Authorization': authorization } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    const status = await call('/api/identity/bootstrap/status');
    assert.equal(status.status, 200); assert.equal(status.body.state, 'ready');
    assert.equal(status.body.checks.localOnlyBootstrapAvailable, true);
    assert.equal(status.body.checks.smtpTransportConfigured, false);
    assert.equal(status.body.checks.invitationDeliveryConfigured, false);
    const initialSetup = { company: { supportPhone: null, timeZone: 'UTC', routeGroupingPolicy: 'nearest_extension', operationalLocation: null }, deliveryPricing: null };
    const invalidAuthorization = await call('/api/admin/tenants/provision', { companyName: 'Sintética', email: 'invalid@example.invalid',
      idempotencyKey: `invalid-${crypto.randomUUID()}`, initialSetup, localOnly: true }, 'not-a-capability');
    assert.equal(invalidAuthorization.status, 403, 'malformed authorization is rejected');
    await pool.query(`UPDATE rotamoto.bootstrap_authorizations SET created_at=now()-interval '11 minutes',
      expires_at=now()-interval '1 minute' WHERE token_digest=$1`, [digest]);
    const expiredAuthorization = await call('/api/admin/tenants/provision', { companyName: 'Sintética', email: 'expired@example.invalid',
      idempotencyKey: `expired-${crypto.randomUUID()}`, initialSetup, localOnly: true }, capability);
    assert.equal(expiredAuthorization.status, 403, 'expired authorization is rejected');
    capability = await runBrowserBootstrapCliInPty({ port, root });
    digest = crypto.createHash('sha256').update(capability, 'utf8').digest();
    const emitted = await pool.query(`SELECT token_digest FROM rotamoto.bootstrap_authorizations WHERE token_digest=$1
      AND installation_scope='rotamoto' AND consumed_at IS NULL AND expires_at>now()`, [digest]);
    assert.equal(emitted.rowCount, 1, 'the real Termux CLI output is usable by the official capability verifier');
    const operatorAudit = await fs.readFile(path.join(root, 'operator-audit.jsonl'), 'utf8');
    assert.equal(operatorAudit.includes(capability), false, 'operator audit never records the raw authorization');
    assert.doesNotMatch(operatorAudit, /[A-Za-z0-9_-]{43}/u, 'operator audit contains no token-shaped value');
    const unauthenticated = await call('/api/admin/tenants/provision', { companyName: 'Sintética', email: 'synthetic@example.invalid',
      idempotencyKey: `local-only-${crypto.randomUUID()}`, initialSetup, localOnly: true });
    assert.equal(unauthenticated.status, 403, 'local-only still requires temporary proof');
    const nonLocalWithoutPublicEmail = await call('/api/admin/tenants/provision', { companyName: 'Sintética', email: 'synthetic@example.invalid',
      idempotencyKey: `public-${crypto.randomUUID()}`, initialSetup, localOnly: false }, capability);
    assert.equal(nonLocalWithoutPublicEmail.status, 503, 'external invitation remains blocked without SMTP+public URL');

    const email = `owner-${crypto.randomUUID()}@example.invalid`, password = 'synthetic-local-founder-passphrase';
    const provisioned = await call('/api/admin/tenants/provision', { companyName: 'Restaurante sintético local', email,
      idempotencyKey: `local-only-${crypto.randomUUID()}`, initialSetup, localOnly: true }, capability);
    assert.equal(provisioned.status, 202, JSON.stringify(provisioned.body));
    assert.equal(provisioned.body.delivery, 'local_handoff');
    assert.match(provisioned.body.localInvitationToken, /^[A-Za-z0-9_-]{43}$/u);
    const consumedAuthorization = await pool.query('SELECT consumed_at IS NOT NULL AS consumed FROM rotamoto.bootstrap_authorizations WHERE token_digest=$1', [digest]);
    assert.equal(consumedAuthorization.rows[0]?.consumed, true, 'the accepted install atomically consumes the operator authorization');
    assert.equal(emailDeliveries.length, 0, 'local-only never invokes external email transport');
    const consumedReplayAsNewInstall = await call('/api/admin/tenants/provision', { companyName: 'Outra instalação', email: 'replay@example.invalid',
      idempotencyKey: `replay-${crypto.randomUUID()}`, initialSetup, localOnly: true }, capability);
    assert([403, 429].includes(consumedReplayAsNewInstall.status), 'a consumed capability cannot authorize a different installation (direct rejection or rate limit)');
    const rawToken = provisioned.body.localInvitationToken;
    const activated = await identityService.consumeOwnerInvitation({ token: rawToken, password });
    assert.equal(activated.mfaRequired, true);
    await assert.rejects(identityService.consumeOwnerInvitation({ token: rawToken, password }), error => error.code === 'INVALID_TOKEN', 'local invitation is one-time');
    const firstLogin = await identityService.authenticate(email, password, activated.companyId);
    assert.equal(firstLogin.mfaEnrollmentRequired, true, 'new owner cannot use privileged access before MFA enrollment');
    const enrollment = await identityService.startMfaEnrollment(firstLogin.sessionToken);
    const enrolled = await identityService.confirmMfaEnrollment(firstLogin.sessionToken, codeAt(enrollment.secret, Math.floor(Date.now() / 30000)));
    assert.equal(enrolled.recoveryCodes.length, 10);
    const installed = await identityService.getBootstrapStatus();
    assert(['complete', 'pending_owner_mfa'].includes(installed.state), `founder/MFA state must be a valid completed path: ${installed.state}`);
    await assert.rejects(issueInTransaction(), error => error.code === 'BOOTSTRAP_NOT_AVAILABLE',
      'the official issuer refuses a second authorization after the installation latch is complete');
    capability = '';
    digest.fill(0);
    verifier = new Client({ connectionString: `postgresql://rm_local_test_admin@127.0.0.1:${port}/rotamoto` }); verifier.on('error', () => {}); await verifier.connect();
    const counts = await verifier.query(`SELECT (SELECT count(*)::int FROM rotamoto.companies) AS companies,
      (SELECT count(*)::int FROM rotamoto.users) AS users,
      (SELECT count(*)::int FROM rotamoto.platform_administrators WHERE revoked_at IS NULL AND grant_kind='founder_bootstrap') AS founders,
      (SELECT count(*)::int FROM rotamoto.sessions WHERE user_id=$1) AS sessions,
      (SELECT count(*)::int FROM rotamoto.credentials WHERE user_id=$1 AND mfa_secret_ref IS NOT NULL AND mfa_required=true) AS active_mfa`, [activated.userId]);
    assert.deepEqual(counts.rows[0], { companies: 1, users: 1, founders: 1, sessions: 1, active_mfa: 1 });
    await verifier.end(); verifier = null;
    assert.equal(secretValues.size, 1, 'the synthetic MFA factor uses only disposable in-memory key storage');
    process.stdout.write('Bootstrap local-only disposable PostgreSQL E2E: loopback/proof gate, invitation SMTP separation, one-time local handoff, password, mandatory TOTP/MFA, atomic founder latch/grant PASS; isolated cluster discarded\n');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (verifier) await verifier.end().catch(() => {});
    await pool.end().catch(() => {});
    await admin.end().catch(() => {});
    if (postgresStarted) await run('pg_ctl', ['-D', dataDir, '-m', 'fast', '-w', 'stop']).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { process.stderr.write(`Bootstrap local-only disposable E2E FAIL: ${error.code || 'ERROR'} ${error.message}\n`); process.exitCode = 1; });
