'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createIdentityService } = require('../backend/identity/service');
const { createEmailDeliveryProvider } = require('../backend/identity/email-provider');
const { verifyPassword } = require('../backend/identity/passwords');
const { createMfaProvider } = require('../backend/identity/mfa-provider');

function savepointPool(client, onQuery = () => {}) {
  let nextSavepoint = 0;
  const scopes = [];
  return { async connect() {
    return {
      async query(sql, values) {
        const normalized = sql.trim().toUpperCase();
        if (normalized === 'BEGIN') {
          const name = `identity_scope_${++nextSavepoint}`;
          scopes.push(name);
          return client.query(`SAVEPOINT ${name}`);
        }
        if (normalized === 'COMMIT') {
          const name = scopes.pop();
          if (!name) throw new Error('unexpected transaction commit');
          return client.query(`RELEASE SAVEPOINT ${name}`);
        }
        if (normalized === 'ROLLBACK') {
          const name = scopes.pop();
          if (!name) throw new Error('unexpected transaction rollback');
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          return client.query(`RELEASE SAVEPOINT ${name}`);
        }
        onQuery(sql, values);
        return client.query(sql, values);
      },
      release() {}
    };
  } };
}

function expectCode(promise, code) {
  return assert.rejects(promise, error => error.code === code);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL PostgreSQL oficial via pgpass é obrigatório.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  const email = `qa-${crypto.randomUUID()}@example.invalid`;
  const password = 'synthetic-owner-password-42';
  const newPassword = 'synthetic-recovery-password-73';
  const delivered = [];
  const auditEntries = [];
  const provider = createEmailDeliveryProvider(async message => { delivered.push(message); return { accepted: true }; });
  const mfaProvider = createMfaProvider(async ({ code }) => code === '654321');
  const pool = savepointPool(client, (sql, values = []) => {
    if (/INSERT\s+INTO\s+rotamoto\.audit_log/iu.test(sql)) {
      auditEntries.push({ action: values[4], details: values[7] });
    }
  });
  const service = createIdentityService({
    pool,
    authorizeProvisioner: async () => ({ actorRef: 'test:transactional-synthetic' }),
    emailProvider: provider, mfaProvider
  });

  try {
    await expectCode(service.provisionInitialOwner({ companyName: 'Synthetic', email, idempotencyKey: 'short' }), 'INVALID_INPUT');
    await expectCode(service.provisionInitialOwner({ companyName: 'Synthetic', email, idempotencyKey: 'synthetic-key-0000001', companyId: crypto.randomUUID() }), 'INVALID_INPUT');
    await expectCode(createIdentityService({ pool, emailProvider: provider }).provisionInitialOwner({
      companyName: 'Synthetic', email, idempotencyKey: 'synthetic-key-0000002'
    }), 'PROVISIONER_NOT_CONFIGURED');
    await expectCode(createIdentityService({ pool, authorizeProvisioner: async () => ({ actorRef: 'test' }) })
      .provisionInitialOwner({ companyName: 'Synthetic', email, idempotencyKey: 'synthetic-key-0000003' }), 'EMAIL_PROVIDER_NOT_CONFIGURED');

    const request = { companyName: 'Synthetic QA Tenant', email, idempotencyKey: `synthetic-${crypto.randomUUID()}` };
    const provisioned = await service.provisionInitialOwner(request);
    assert.equal(provisioned.delivery, 'sent');
    assert.equal(provisioned.replayed, false);
    assert.equal(delivered.length, 1);
    const replay = await service.provisionInitialOwner(request);
    assert.equal(replay.companyId, provisioned.companyId);
    assert.equal(replay.userId, provisioned.userId);
    assert.equal(replay.replayed, true);
    assert.equal(delivered.length, 1, 'successful idempotent replay does not send another invitation');
    await expectCode(service.provisionInitialOwner({ ...request, companyName: 'Changed tenant' }), 'IDEMPOTENCY_CONFLICT');

    const retryEmail = `qa-retry-${crypto.randomUUID()}@example.invalid`;
    const retryRequest = { companyName: 'Synthetic Retry Tenant', email: retryEmail, idempotencyKey: `retry-${crypto.randomUUID()}` };
    let failedInvitation;
    const failingProvider = createEmailDeliveryProvider(async message => { failedInvitation = message; throw new Error('synthetic provider failure'); });
    const failedDelivery = await createIdentityService({ pool, authorizeProvisioner: async () => ({ actorRef: 'test:transactional-synthetic' }),
      emailProvider: failingProvider }).provisionInitialOwner(retryRequest);
    assert.equal(failedDelivery.delivery, 'failed');
    await client.query(`UPDATE rotamoto.identity_tokens SET created_at=now()-interval '2 days',
      expires_at=now()-interval '1 second' WHERE token_digest=$1`,
    [crypto.createHash('sha256').update(failedInvitation.token).digest()]);
    await expectCode(service.consumeOwnerInvitation({ token: failedInvitation.token, password }), 'INVALID_TOKEN');
    const retried = await service.provisionInitialOwner(retryRequest);
    assert.equal(retried.delivery, 'sent');
    assert.equal(retried.replayed, true);
    assert.equal(delivered.length, 2);
    await expectCode(service.consumeOwnerInvitation({ token: failedInvitation.token, password }), 'INVALID_TOKEN');
    assert.equal((await service.consumeOwnerInvitation({ token: delivered.at(-1).token, password })).mfaRequired, true);

    const concurrentRequest = { companyName: 'Synthetic Concurrent Tenant', email: `qa-concurrent-${crypto.randomUUID()}@example.invalid`,
      idempotencyKey: `concurrent-${crypto.randomUUID()}` };
    let unblockDelivery;
    let deliveryStarted;
    const started = new Promise(resolve => { deliveryStarted = resolve; });
    const deliveryGate = new Promise(resolve => { unblockDelivery = resolve; });
    const concurrentProvider = createEmailDeliveryProvider(async message => {
      deliveryStarted(message);
      await deliveryGate;
      return { accepted: true };
    });
    let concurrentMessage;
    const firstProvision = createIdentityService({ pool, authorizeProvisioner: async () => ({ actorRef: 'test:transactional-synthetic' }),
      emailProvider: concurrentProvider }).provisionInitialOwner(concurrentRequest);
    concurrentMessage = await started;
    let duplicateDeliveryCalled = false;
    const duplicateProvider = createEmailDeliveryProvider(async () => { duplicateDeliveryCalled = true; return { accepted: true }; });
    const inFlightReplay = await createIdentityService({ pool, authorizeProvisioner: async () => ({ actorRef: 'test:transactional-synthetic' }),
      emailProvider: duplicateProvider }).provisionInitialOwner(concurrentRequest);
    assert.equal(inFlightReplay.delivery, 'pending');
    assert.equal(duplicateDeliveryCalled, false, 'an in-flight idempotent retry does not invalidate or re-send its token');
    unblockDelivery();
    assert.equal((await firstProvision).delivery, 'sent');
    assert.equal(typeof concurrentMessage.token, 'string');

    const tokenRows = await client.query(`SELECT token_digest FROM rotamoto.identity_tokens WHERE user_id=$1`, [provisioned.userId]);
    assert.equal(tokenRows.rowCount, 1);
    assert.notEqual(Buffer.from(tokenRows.rows[0].token_digest).toString('base64url'), delivered[0].token,
      'database persists only the token digest');
    assert.equal(await client.query(`SELECT 1 FROM rotamoto.credentials WHERE user_id=$1`, [provisioned.userId]).then(r => r.rowCount), 0,
      'no password credential exists before the invited owner chooses a password');

    const activated = await service.consumeOwnerInvitation({ token: delivered[0].token, password });
    assert.equal(activated.companyId, provisioned.companyId);
    assert.equal(activated.userId, provisioned.userId);
    assert.equal(activated.mfaRequired, true, 'owner account requires MFA per DEC-0002');
    await expectCode(service.consumeOwnerInvitation({ token: delivered[0].token, password }), 'INVALID_TOKEN');
    const account = await client.query(`SELECT u.email_verified_at IS NOT NULL AS verified,u.disabled_at,
      m.status AS membership_status,c.status AS company_status,cr.password_phc,cr.mfa_required
      FROM rotamoto.users u JOIN rotamoto.memberships m ON m.user_id=u.id JOIN rotamoto.companies c ON c.id=m.company_id
      JOIN rotamoto.credentials cr ON cr.user_id=u.id WHERE u.id=$1`, [provisioned.userId]);
    assert.equal(account.rows[0].verified, true);
    assert.equal(account.rows[0].membership_status, 'active');
    assert.equal(account.rows[0].company_status, 'active');
    assert.equal(account.rows[0].mfa_required, true);
    assert.match(account.rows[0].password_phc, /^\$argon2id\$/u);
    assert.equal(await verifyPassword(account.rows[0].password_phc, password), true);
    assert.equal(account.rows[0].password_phc.includes(password), false);

    await expectCode(service.authenticate(email, password, provisioned.companyId), 'MFA_REQUIRED');
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [provisioned.companyId]);
    await client.query(`UPDATE rotamoto.credentials SET mfa_required=false WHERE user_id=$1`, [provisioned.userId]);
    await expectCode(service.authenticate(email, 'wrong synthetic password', provisioned.companyId), 'INVALID_CREDENTIALS');
    const failed = await client.query(`SELECT failed_attempts FROM rotamoto.credentials WHERE user_id=$1`, [provisioned.userId]);
    assert.equal(failed.rows[0].failed_attempts, 1, 'failed password attempts persist atomically');
    const session = await service.authenticate(email, password, provisioned.companyId, '654321');
    assert.match(session.cookie, /^__Host-rotamoto_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/u);
    assert.equal(session.maxAgeSeconds, 12 * 60 * 60);
    const storedSession = await client.query(`SELECT token_digest,csrf_digest,mfa_verified_at FROM rotamoto.sessions WHERE id=$1`, [session.sessionId]);
    assert.notEqual(Buffer.from(storedSession.rows[0].token_digest).toString('base64url'), session.sessionToken);
    assert.notEqual(Buffer.from(storedSession.rows[0].csrf_digest).toString('base64url'), session.csrfToken);
    assert(storedSession.rows[0].mfa_verified_at, 'administrative session records completed MFA verification');

    const authorized = await service.withAuthenticatedTenant(session.sessionToken, async (db, principal) => {
      const companies = await db.query('SELECT id::text FROM rotamoto.companies');
      return { principal, companies: companies.rows };
    }, 'orders.read');
    assert.equal(authorized.principal.company_id, provisioned.companyId);
    assert.deepEqual(authorized.companies.map(row => row.id), [provisioned.companyId]);
    await expectCode(service.withAuthenticatedTenant(session.sessionToken, async () => true, 'members.delete'), 'FORBIDDEN');
    await expectCode(service.switchActiveCompany(session.sessionToken, crypto.randomUUID()), 'FORBIDDEN');
    assert.deepEqual(await service.switchActiveCompany(session.sessionToken, provisioned.companyId), { companyId: provisioned.companyId });

    await client.query('SAVEPOINT csrf_check');
    const principal = await service.resolveSession(client, session.sessionToken);
    assert.equal(principal.authenticated, true);
    assert.equal(await service.verifyCsrf(client, principal.session_id, session.csrfToken), true);
    assert.equal(await service.verifyCsrf(client, principal.session_id, 'invalid'), false);
    await client.query('ROLLBACK TO SAVEPOINT csrf_check');
    await client.query('RELEASE SAVEPOINT csrf_check');

    const logoutSession = await service.authenticate(email, password, provisioned.companyId, '654321');
    assert.equal(await service.revokeSession(logoutSession.sessionToken), true);
    assert.equal(await service.revokeSession(logoutSession.sessionToken), false);
    await expectCode(service.withAuthenticatedTenant(logoutSession.sessionToken, async () => true), 'UNAUTHENTICATED');

    const idleExpiredSession = await service.authenticate(email, password, provisioned.companyId, '654321');
    await client.query(`UPDATE rotamoto.sessions SET created_at=now()-interval '2 seconds',last_seen_at=now()-interval '2 seconds',
      idle_expires_at=now()-interval '1 second' WHERE id=$1`, [idleExpiredSession.sessionId]);
    await expectCode(service.withAuthenticatedTenant(idleExpiredSession.sessionToken, async () => true), 'UNAUTHENTICATED');
    const absoluteExpiredSession = await service.authenticate(email, password, provisioned.companyId, '654321');
    await client.query(`UPDATE rotamoto.sessions SET created_at=now()-interval '24 hours',last_seen_at=now()-interval '24 hours',
      idle_expires_at=now()-interval '5 seconds',absolute_expires_at=now()-interval '1 second' WHERE id=$1`, [absoluteExpiredSession.sessionId]);
    await expectCode(service.withAuthenticatedTenant(absoluteExpiredSession.sessionToken, async () => true), 'UNAUTHENTICATED');

    await expectCode(service.authenticate(email, password, crypto.randomUUID()), 'INVALID_CREDENTIALS');
    await client.query(`UPDATE rotamoto.credentials SET failed_attempts=9,locked_until=NULL WHERE user_id=$1`, [provisioned.userId]);
    await expectCode(service.authenticate(email, 'another wrong synthetic password', provisioned.companyId), 'INVALID_CREDENTIALS');
    const locked = await client.query(`SELECT failed_attempts,locked_until>now() AS is_locked FROM rotamoto.credentials WHERE user_id=$1`,
      [provisioned.userId]);
    assert.equal(locked.rows[0].failed_attempts, 10);
    assert.equal(locked.rows[0].is_locked, true, 'failed login attempts apply a temporary account lock');
    await expectCode(service.authenticate(email, password, provisioned.companyId), 'INVALID_CREDENTIALS');
    const recovery = await service.requestPasswordRecovery(email.toUpperCase());
    assert.deepEqual(recovery, { accepted: true });
    const recoveryMessage = delivered.at(-1);
    assert.equal(recoveryMessage.kind, 'password_recovery');
    const recoveryRows = await client.query(`SELECT token_digest FROM rotamoto.recovery_tokens WHERE user_id=$1 AND consumed_at IS NULL`, [provisioned.userId]);
    assert.equal(recoveryRows.rowCount, 1);
    assert.notEqual(Buffer.from(recoveryRows.rows[0].token_digest).toString('base64url'), recoveryMessage.token);
    const changed = await service.consumePasswordRecovery({ token: recoveryMessage.token, password: newPassword });
    assert.equal(changed.userId, provisioned.userId);
    const recoveredCredential = await client.query(`SELECT failed_attempts,locked_until FROM rotamoto.credentials WHERE user_id=$1`,
      [provisioned.userId]);
    assert.equal(recoveredCredential.rows[0].failed_attempts, 0);
    assert.equal(recoveredCredential.rows[0].locked_until, null);
    await expectCode(service.consumePasswordRecovery({ token: recoveryMessage.token, password }), 'INVALID_TOKEN');
    await service.requestPasswordRecovery(email);
    const expiredRecovery = delivered.at(-1);
    await client.query(`UPDATE rotamoto.recovery_tokens SET created_at=now()-interval '2 hours',
      expires_at=now()-interval '1 second' WHERE token_digest=$1`,
      [crypto.createHash('sha256').update(expiredRecovery.token).digest()]);
    await expectCode(service.consumePasswordRecovery({ token: expiredRecovery.token, password }), 'INVALID_TOKEN');
    await expectCode(service.withAuthenticatedTenant(session.sessionToken, async () => true), 'UNAUTHENTICATED');

    const noAccount = await service.requestPasswordRecovery(`missing-${crypto.randomUUID()}@example.invalid`);
    assert.deepEqual(noAccount, { accepted: true }, 'recovery response does not enumerate account existence');
    assert(auditEntries.length > 0, 'identity operations emit audit entries');
    for (const row of auditEntries) {
      assert.equal(JSON.stringify(row.details).includes(password), false);
      assert.equal(JSON.stringify(row.details).includes(delivered[0].token), false);
      assert.equal(JSON.stringify(row.details).includes(recoveryMessage.token), false);
    }
    console.log('identity provision, Argon2id credential, recovery, session, CSRF, RBAC and tenant tests: OK');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    const remaining = await client.query(`SELECT count(*)::int AS count FROM rotamoto.users WHERE email=$1`, [email]).catch(() => ({ rows: [{ count: -1 }] }));
    await client.end();
    assert.equal(remaining.rows[0].count, 0, 'all synthetic identity data must roll back');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
