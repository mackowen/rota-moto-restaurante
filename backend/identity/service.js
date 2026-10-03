'use strict';

const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('./passwords');
const { requireEmailProvider } = require('./email-provider');

const OWNER_PERMISSIONS = Object.freeze([
  'company.manage', 'members.invite', 'members.read', 'orders.read', 'orders.manage', 'integrations.manage'
]);
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TTL_MS = 60 * 60 * 1000;
const DELIVERY_LEASE_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;

class IdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new IdentityError('INVALID_INPUT', 'Email inválido.');
  const email = value.trim().normalize('NFC').toLowerCase();
  if (email.length < 3 || Buffer.byteLength(email, 'utf8') > 320 ||
      /[\s\u0000-\u001f\u007f]/u.test(email) || !/^[^@]+@[^@.]+(?:\.[^@.]+)+$/u.test(email)) {
    throw new IdentityError('INVALID_INPUT', 'Email inválido.');
  }
  return email;
}

function requiredText(value, field, maxBytes) {
  if (typeof value !== 'string') throw new IdentityError('INVALID_INPUT', `${field} inválido.`);
  const text = value.trim().normalize('NFC');
  if (!text || Buffer.byteLength(text, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new IdentityError('INVALID_INPUT', `${field} inválido.`);
  }
  return text;
}

function tokenDigest(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new IdentityError('INVALID_TOKEN', 'Token inválido ou expirado.');
  }
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, digest: tokenDigest(token) };
}

function digestText(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function validateUuid(value, code = 'INVALID_INPUT') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new IdentityError(code, 'Empresa inválida.');
  }
  return value.toLowerCase();
}

function id(now = Date.now()) {
  const bytes = crypto.randomBytes(16);
  let timestamp = Math.max(0, Math.min(0xffffffffffff, Math.trunc(now)));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function transaction(client, operation) {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function setTenant(client, companyId) {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [companyId]);
}

async function audit(client, { companyId, actorUserId = null, actorKind, action, resourceType, resourceId, details = {} }) {
  await client.query(`
    INSERT INTO rotamoto.audit_log
      (id, company_id, actor_user_id, actor_kind, action, resource_type, resource_id, details)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
  `, [id(), companyId, actorUserId, actorKind, action, resourceType, resourceId, JSON.stringify(details)]);
}

function validateProvisioningInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['companyName', 'email', 'idempotencyKey'].includes(key))) {
    throw new IdentityError('INVALID_INPUT', 'Dados de provisionamento inválidos.');
  }
  const companyName = requiredText(input.companyName, 'Nome da empresa', 160);
  const email = normalizeEmail(input.email);
  const idempotencyKey = requiredText(input.idempotencyKey, 'Chave idempotente', 128);
  if (Buffer.byteLength(idempotencyKey, 'utf8') < 16) {
    throw new IdentityError('INVALID_INPUT', 'Chave idempotente inválida.');
  }
  return { companyName, email, idempotencyKey };
}

function createIdentityService({ pool, authorizeProvisioner, emailProvider, clock = () => new Date() }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Pool PostgreSQL obrigatório.');
  let dummyPasswordHash;
  const dummyVerify = async password => {
    if (!dummyPasswordHash) dummyPasswordHash = hashPassword('identity-nonexistent-account-dummy-value');
    await verifyPassword(await dummyPasswordHash, password);
  };

  async function provisionInitialOwner(input) {
    const { companyName, email, idempotencyKey } = validateProvisioningInput(input);
    if (typeof authorizeProvisioner !== 'function') {
      throw new IdentityError('PROVISIONER_NOT_CONFIGURED', 'Autorização administrativa não configurada.');
    }
    let actorRef;
    try {
      const actor = await authorizeProvisioner({ action: 'tenant.owner.provision', email });
      actorRef = requiredText(actor?.actorRef, 'Identidade administrativa', 160);
    } catch (_) {
      throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'Provisionamento administrativo não autorizado.');
    }
    const provider = requireEmailProvider(emailProvider);
    const requestDigest = digestText(JSON.stringify({ companyName, email }));
    const keyDigest = digestText(idempotencyKey);
    const client = await pool.connect();
    let delivery;
    try {
      delivery = await transaction(client, async () => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 817231))', [keyDigest.toString('hex')]);
        const existing = await client.query(`
          SELECT request_digest, company_id::text, user_id::text, delivery_status, updated_at
          FROM rotamoto.provisioning_requests WHERE idempotency_key_digest=$1
        `, [keyDigest]);
        let companyId;
        let userId;
        if (existing.rowCount) {
          const previous = existing.rows[0];
          if (!Buffer.from(previous.request_digest).equals(requestDigest)) {
            throw new IdentityError('IDEMPOTENCY_CONFLICT', 'Chave idempotente reutilizada para dados diferentes.');
          }
          companyId = previous.company_id;
          userId = previous.user_id;
          if (previous.delivery_status === 'sent') {
            return { companyId, userId, replayed: true, send: false, delivery: 'sent' };
          }
          if (previous.delivery_status === 'pending' &&
              new Date(previous.updated_at).getTime() > clock().getTime() - DELIVERY_LEASE_MS) {
            return { companyId, userId, replayed: true, send: false, delivery: 'pending' };
          }
          await setTenant(client, companyId);
          await client.query(`UPDATE rotamoto.provisioning_requests SET delivery_status='pending',updated_at=now()
            WHERE idempotency_key_digest=$1`, [keyDigest]);
          await client.query(`UPDATE rotamoto.identity_tokens SET consumed_at=coalesce(consumed_at,now())
            WHERE company_id=$1 AND user_id=$2 AND purpose='owner_invitation' AND consumed_at IS NULL`, [companyId, userId]);
        } else {
          companyId = id();
          userId = id();
          const roleId = id();
          const membershipId = id();
          await setTenant(client, companyId);
          await client.query(`INSERT INTO rotamoto.companies (id,name,status) VALUES ($1,$2,'provisioning')`, [companyId, companyName]);
          await client.query(`INSERT INTO rotamoto.roles (id,company_id,role_key,display_name,is_system_template)
            VALUES ($1,$2,'owner','Proprietário',false)`, [roleId, companyId]);
          await client.query(`INSERT INTO rotamoto.role_permissions (company_id,role_id,permission_key,catalog_version)
            SELECT $1,$2,permission_key,1 FROM rotamoto.permissions WHERE catalog_version=1 AND permission_key=ANY($3::text[])`,
          [companyId, roleId, OWNER_PERMISSIONS]);
          const granted = await client.query(`SELECT count(*)::int AS count FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2`, [companyId, roleId]);
          if (granted.rows[0].count !== OWNER_PERMISSIONS.length) throw new IdentityError('ROLE_CATALOG_INCOMPLETE', 'Catálogo de permissões incompleto.');
          await client.query(`INSERT INTO rotamoto.users (id,email) VALUES ($1,$2)`, [userId, email]);
          await client.query(`INSERT INTO rotamoto.memberships (id,company_id,user_id,role_id,status)
            VALUES ($1,$2,$3,$4,'invited')`, [membershipId, companyId, userId, roleId]);
          await audit(client, { companyId, actorKind: 'admin_provisioner', action: 'tenant.owner.provisioned',
            resourceType: 'membership', resourceId: membershipId, details: { actor_ref: actorRef, delivery_status: 'pending' } });
          await client.query(`INSERT INTO rotamoto.provisioning_requests
            (idempotency_key_digest,request_digest,company_id,user_id,delivery_status) VALUES ($1,$2,$3,$4,'pending')`,
          [keyDigest, requestDigest, companyId, userId]);
        }
        const invitation = newToken();
        const expiresAt = new Date(clock().getTime() + INVITATION_TTL_MS);
        await client.query(`INSERT INTO rotamoto.identity_tokens
          (id,company_id,user_id,purpose,token_digest,expires_at)
          VALUES ($1,$2,$3,'owner_invitation',$4,$5)`, [id(), companyId, userId, invitation.digest, expiresAt]);
        return { companyId, userId, replayed: Boolean(existing.rowCount), send: true,
          message: { to: email, kind: 'owner_invitation', token: invitation.token, expiresAt, companyName } };
      });
    } finally {
      client.release();
    }
    if (!delivery.send) return { companyId: delivery.companyId, userId: delivery.userId,
      delivery: delivery.delivery, replayed: true };

    let sent = false;
    try {
      await provider.send(delivery.message);
      sent = true;
    } catch (_) {
      // Do not log provider errors: they may contain recipient or token material.
    }
    const statusClient = await pool.connect();
    try {
      await transaction(statusClient, async () => {
        await setTenant(statusClient, delivery.companyId);
        await statusClient.query(`UPDATE rotamoto.provisioning_requests SET delivery_status=$1,updated_at=now()
          WHERE idempotency_key_digest=$2`, [sent ? 'sent' : 'failed', keyDigest]);
        await audit(statusClient, { companyId: delivery.companyId, actorKind: 'system',
          action: sent ? 'tenant.owner.invitation_sent' : 'tenant.owner.invitation_delivery_failed',
          resourceType: 'user', resourceId: delivery.userId, details: { provider_result: sent ? 'accepted' : 'failed' } });
      });
    } finally {
      statusClient.release();
    }
    return { companyId: delivery.companyId, userId: delivery.userId, delivery: sent ? 'sent' : 'failed', replayed: delivery.replayed };
  }

  async function consumeOwnerInvitation({ token, password }) {
    const digest = tokenDigest(token);
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const found = await client.query(`SELECT id::text,company_id::text,user_id::text FROM rotamoto.identity_tokens
          WHERE token_digest=$1 AND purpose='owner_invitation' AND consumed_at IS NULL AND expires_at>now()
          FOR UPDATE`, [digest]);
        if (!found.rowCount) throw new IdentityError('INVALID_TOKEN', 'Token inválido ou expirado.');
        const { id: tokenId, company_id: companyId, user_id: userId } = found.rows[0];
        await setTenant(client, companyId);
        const eligible = await client.query(`SELECT 1 FROM rotamoto.users u JOIN rotamoto.memberships m ON m.user_id=u.id
          JOIN rotamoto.companies c ON c.id=m.company_id WHERE u.id=$1 AND m.company_id=$2
          AND u.disabled_at IS NULL AND m.status='invited' AND c.status='provisioning' FOR UPDATE OF u,m,c`, [userId, companyId]);
        if (!eligible.rowCount) throw new IdentityError('INVALID_TOKEN', 'Token inválido ou expirado.');
        const now = clock();
        await client.query(`INSERT INTO rotamoto.credentials (user_id,password_phc,mfa_required)
          VALUES ($1,$2,true)`, [userId, passwordHash]);
        await client.query(`UPDATE rotamoto.users SET email_verified_at=$2,updated_at=$2 WHERE id=$1`, [userId, now]);
        await client.query(`UPDATE rotamoto.memberships SET status='active',activated_at=$3,updated_at=$3
          WHERE company_id=$1 AND user_id=$2 AND status='invited'`, [companyId, userId, now]);
        await client.query(`UPDATE rotamoto.companies SET status='active',updated_at=$2 WHERE id=$1 AND status='provisioning'`, [companyId, now]);
        await client.query(`UPDATE rotamoto.identity_tokens SET consumed_at=$2 WHERE id=$1 AND consumed_at IS NULL`, [tokenId, now]);
        await audit(client, { companyId, actorUserId: userId, actorKind: 'user', action: 'identity.owner_invitation.accepted',
          resourceType: 'user', resourceId: userId });
        await audit(client, { companyId, actorUserId: userId, actorKind: 'user', action: 'identity.email.verified',
          resourceType: 'user', resourceId: userId, details: { verification_method: 'owner_invitation' } });
        return { userId, companyId, mfaRequired: true };
      });
    } finally { client.release(); }
  }

  async function requestPasswordRecovery(value) {
    const email = normalizeEmail(value);
    const provider = requireEmailProvider(emailProvider);
    const client = await pool.connect();
    let pending;
    try {
      pending = await transaction(client, async () => {
        const user = await client.query(`SELECT id::text,email FROM rotamoto.users WHERE lower(email)=$1 AND disabled_at IS NULL`, [email]);
        if (!user.rowCount) return null;
        const { id: userId } = user.rows[0];
        const memberships = await client.query(`SELECT company_id::text FROM rotamoto.memberships WHERE user_id=$1 AND status='active'`, [userId]);
        const issued = newToken();
        const expiresAt = new Date(clock().getTime() + RECOVERY_TTL_MS);
        await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=coalesce(consumed_at,now()) WHERE user_id=$1 AND consumed_at IS NULL`, [userId]);
        await client.query(`INSERT INTO rotamoto.recovery_tokens (id,user_id,token_digest,expires_at) VALUES ($1,$2,$3,$4)`,
          [id(), userId, issued.digest, expiresAt]);
        for (const row of memberships.rows) {
          const companyId = row.company_id;
          await setTenant(client, companyId);
          await audit(client, { companyId, actorKind: 'system', action: 'identity.recovery.requested',
            resourceType: 'user', resourceId: userId });
        }
        return { userId, to: user.rows[0].email, token: issued.token, expiresAt };
      });
    } finally { client.release(); }
    if (pending) {
      let sent = false;
      try { await provider.send({ to: pending.to, kind: 'password_recovery', token: pending.token, expiresAt: pending.expiresAt }); sent = true; }
      catch (_) { /* keep response indistinguishable; invalidate below */ }
      if (!sent) {
        const invalidate = await pool.connect();
        try {
          await transaction(invalidate, async () => {
            await invalidate.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=now()
              WHERE token_digest=$1 AND consumed_at IS NULL`, [tokenDigest(pending.token)]);
            const memberships = await invalidate.query(`SELECT company_id::text FROM rotamoto.memberships WHERE user_id=$1`, [pending.userId]);
            for (const row of memberships.rows) {
              await setTenant(invalidate, row.company_id);
              await audit(invalidate, { companyId: row.company_id, actorKind: 'system',
                action: 'identity.recovery.delivery_result', resourceType: 'user', resourceId: pending.userId,
                details: { provider_result: 'failed' } });
            }
          });
        }
        finally { invalidate.release(); }
      } else {
        const deliveryAudit = await pool.connect();
        try {
          await transaction(deliveryAudit, async () => {
            const memberships = await deliveryAudit.query(`SELECT company_id::text FROM rotamoto.memberships WHERE user_id=$1`, [pending.userId]);
            for (const row of memberships.rows) {
              await setTenant(deliveryAudit, row.company_id);
              await audit(deliveryAudit, { companyId: row.company_id, actorKind: 'system',
                action: 'identity.recovery.delivery_result', resourceType: 'user', resourceId: pending.userId,
                details: { provider_result: 'accepted' } });
            }
          });
        } finally { deliveryAudit.release(); }
      }
    }
    return { accepted: true };
  }

  async function consumePasswordRecovery({ token, password }) {
    const digest = tokenDigest(token);
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const found = await client.query(`SELECT r.id::text,r.user_id::text FROM rotamoto.recovery_tokens r
          JOIN rotamoto.users u ON u.id=r.user_id WHERE r.token_digest=$1 AND r.consumed_at IS NULL
          AND r.expires_at>now() AND u.disabled_at IS NULL FOR UPDATE OF r,u`, [digest]);
        if (!found.rowCount) throw new IdentityError('INVALID_TOKEN', 'Token inválido ou expirado.');
        const { id: tokenId, user_id: userId } = found.rows[0];
        const now = clock();
        const changed = await client.query(`UPDATE rotamoto.credentials SET password_phc=$2,password_changed_at=$3,
          failed_attempts=0,locked_until=NULL,updated_at=$3 WHERE user_id=$1 RETURNING user_id`, [userId, passwordHash, now]);
        if (!changed.rowCount) throw new IdentityError('CREDENTIAL_NOT_FOUND', 'Credencial indisponível.');
        await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=$2 WHERE id=$1`, [tokenId, now]);
        await client.query(`UPDATE rotamoto.sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL`, [userId, now]);
        const memberships = await client.query(`SELECT company_id::text FROM rotamoto.memberships WHERE user_id=$1`, [userId]);
        for (const row of memberships.rows) {
          await setTenant(client, row.company_id);
          await audit(client, { companyId: row.company_id, actorUserId: userId, actorKind: 'user',
            action: 'identity.password.recovered', resourceType: 'user', resourceId: userId });
        }
        return { userId, changedAt: now };
      });
    } finally { client.release(); }
  }

  async function authenticate(emailValue, password, requestedCompanyId) {
    const email = normalizeEmail(emailValue);
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024) {
      throw new IdentityError('INVALID_CREDENTIALS', 'Email ou senha inválidos.');
    }
    const client = await pool.connect();
    try {
      const result = await transaction(client, async () => {
        const found = await client.query(`SELECT u.id::text AS user_id,u.disabled_at,c.password_phc,c.locked_until,c.mfa_required
          FROM rotamoto.users u JOIN rotamoto.credentials c ON c.user_id=u.id WHERE lower(u.email)=$1`, [email]);
        if (!found.rowCount || found.rows[0].disabled_at ||
            (found.rows[0].locked_until && new Date(found.rows[0].locked_until) > clock())) {
          await dummyVerify(password);
          return { error: 'INVALID_CREDENTIALS' };
        }
        const credential = found.rows[0];
        const valid = await verifyPassword(credential.password_phc, password);
        if (!valid) {
          await client.query(`UPDATE rotamoto.credentials SET failed_attempts=least(failed_attempts+1,$2),
            locked_until=CASE WHEN failed_attempts+1 >= $2 THEN now()+interval '15 minutes' ELSE locked_until END,updated_at=now()
          WHERE user_id=$1`, [credential.user_id, MAX_FAILED_ATTEMPTS]);
          return { error: 'INVALID_CREDENTIALS' };
        }
        const reset = await client.query(`UPDATE rotamoto.credentials SET failed_attempts=0,locked_until=NULL,updated_at=now()
          WHERE user_id=$1 AND (locked_until IS NULL OR locked_until<=now()) RETURNING mfa_required`, [credential.user_id]);
        if (!reset.rowCount) return { error: 'INVALID_CREDENTIALS' };
        if (reset.rows[0].mfa_required) return { error: 'MFA_REQUIRED' };
        const companyId = validateUuid(requestedCompanyId);
        await setTenant(client, companyId);
        const membership = await client.query(`SELECT m.company_id::text,m.role_id::text FROM rotamoto.memberships m
          JOIN rotamoto.companies c ON c.id=m.company_id WHERE m.user_id=$1 AND m.company_id=$2
          AND m.status='active' AND c.status='active'`, [credential.user_id, companyId]);
        if (!membership.rowCount) return { error: 'INVALID_CREDENTIALS' };
        return createSession(client, credential.user_id, membership.rows[0].company_id);
      });
      if (result?.error) {
        const messages = { INVALID_CREDENTIALS: 'Email ou senha inválidos.', MFA_REQUIRED: 'A autenticação multifator desta conta ainda não está configurada.' };
        throw new IdentityError(result.error, messages[result.error]);
      }
      return result;
    } finally { client.release(); }
  }

  async function createSession(client, userId, companyId) {
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const now = clock();
    const sessionId = id();
    const inserted = await client.query(`INSERT INTO rotamoto.sessions
      (id,user_id,active_company_id,token_digest,csrf_digest,idle_expires_at,absolute_expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS (
        SELECT 1 FROM rotamoto.memberships WHERE company_id=$3 AND user_id=$2 AND status='active'
      ) RETURNING id::text`, [sessionId, userId, companyId, digestText(sessionToken), digestText(csrfToken),
      new Date(now.getTime() + SESSION_IDLE_MS), new Date(now.getTime() + SESSION_ABSOLUTE_MS)]);
    if (!inserted.rowCount) throw new IdentityError('INVALID_CREDENTIALS', 'Email ou senha inválidos.');
    return { sessionId, sessionToken, csrfToken, companyId, userId,
      cookie: `__Host-rotamoto_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      maxAgeSeconds: Math.floor(SESSION_ABSOLUTE_MS / 1000) };
  }

  async function resolveSession(client, sessionToken) {
    let digest;
    try { digest = tokenDigest(sessionToken); } catch (_) { return null; }
    const now = clock();
    const scope = await client.query(`SELECT active_company_id::text AS company_id FROM rotamoto.sessions
      WHERE token_digest=$1 AND revoked_at IS NULL AND idle_expires_at>$2 AND absolute_expires_at>$2`, [digest, now]);
    if (!scope.rowCount) return null;
    await setTenant(client, scope.rows[0].company_id);
    const result = await client.query(`UPDATE rotamoto.sessions s SET last_seen_at=$2,
      idle_expires_at=least(s.absolute_expires_at,$2 + interval '30 minutes')
      FROM rotamoto.users u,rotamoto.memberships m,rotamoto.companies c
      WHERE s.token_digest=$1 AND s.user_id=u.id AND s.active_company_id=m.company_id AND m.user_id=s.user_id
        AND m.company_id=c.id AND s.revoked_at IS NULL AND s.idle_expires_at>$2 AND s.absolute_expires_at>$2
        AND u.disabled_at IS NULL AND m.status='active' AND c.status='active'
      RETURNING s.id::text AS session_id,s.user_id::text,s.active_company_id::text AS company_id,m.role_id::text`, [digest, now]);
    return result.rowCount ? { ...result.rows[0], authenticated: true } : null;
  }

  async function verifyCsrf(client, sessionId, csrfToken) {
    let digest;
    try { digest = tokenDigest(csrfToken); } catch (_) { return false; }
    const result = await client.query(`SELECT 1 FROM rotamoto.sessions WHERE id=$1 AND csrf_digest=$2
      AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()`, [sessionId, digest]);
    return result.rowCount === 1;
  }

  async function switchActiveCompany(sessionToken, companyId) {
    const selectedCompanyId = validateUuid(companyId);
    const digest = tokenDigest(sessionToken);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const session = await client.query(`SELECT id::text,user_id::text FROM rotamoto.sessions
          WHERE token_digest=$1 AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()
          FOR UPDATE`, [digest]);
        if (!session.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
        const { id: sessionId, user_id: userId } = session.rows[0];
        await setTenant(client, selectedCompanyId);
        const membership = await client.query(`SELECT 1 FROM rotamoto.memberships m
          JOIN rotamoto.companies c ON c.id=m.company_id WHERE m.company_id=$1 AND m.user_id=$2
          AND m.status='active' AND c.status='active'`, [selectedCompanyId, userId]);
        if (!membership.rowCount) throw new IdentityError('FORBIDDEN', 'Empresa sem associação ativa.');
        await client.query(`UPDATE rotamoto.sessions SET active_company_id=$2,last_seen_at=now() WHERE id=$1`,
          [sessionId, selectedCompanyId]);
        return { companyId: selectedCompanyId };
      });
    } finally { client.release(); }
  }

  async function revokeSession(sessionToken) {
    let digest;
    try { digest = tokenDigest(sessionToken); } catch (_) { return false; }
    const client = await pool.connect();
    try {
      const result = await client.query(`UPDATE rotamoto.sessions SET revoked_at=now()
        WHERE token_digest=$1 AND revoked_at IS NULL RETURNING id`, [digest]);
      return result.rowCount === 1;
    } finally { client.release(); }
  }

  async function withAuthenticatedTenant(sessionToken, operation, permissionKey) {
    if (typeof operation !== 'function') throw new TypeError('Operação de tenant obrigatória.');
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const principal = await resolveSession(client, sessionToken);
        if (!principal) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
        await setTenant(client, principal.company_id);
        if (permissionKey) {
          const permission = requiredText(permissionKey, 'Permissão', 120);
          const allowed = await client.query(`SELECT 1 FROM rotamoto.role_permissions rp
            WHERE rp.company_id=$1 AND rp.role_id=$2 AND rp.permission_key=$3 AND rp.catalog_version=1`,
          [principal.company_id, principal.role_id, permission]);
          if (!allowed.rowCount) throw new IdentityError('FORBIDDEN', 'Operação não autorizada.');
        }
        return operation(client, principal);
      });
    } finally { client.release(); }
  }

  return Object.freeze({ provisionInitialOwner, consumeOwnerInvitation, requestPasswordRecovery,
    consumePasswordRecovery, authenticate, resolveSession, verifyCsrf, switchActiveCompany, revokeSession, withAuthenticatedTenant });
}

module.exports = { createIdentityService, IdentityError, normalizeEmail, tokenDigest, uuidV7: id,
  SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, INVITATION_TTL_MS, RECOVERY_TTL_MS };
