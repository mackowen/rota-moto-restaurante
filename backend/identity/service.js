'use strict';

const crypto = require('node:crypto');
const { deriveCsrfToken } = require('./csrf');
const { hashPassword, verifyPassword } = require('./passwords');
const { requireEmailProvider } = require('./email-provider');
const { generateSecret, otpauthUri, verifyCode, generateRecoveryCodes, recoveryDigest } = require('./totp');

const OWNER_PERMISSIONS = Object.freeze([
  'company.manage', 'members.invite', 'members.read', 'orders.read', 'orders.manage', 'integrations.manage',
  'sync.pull', 'sync.push'
]);
const MFA_PERMISSIONS = Object.freeze(['company.manage', 'members.invite', 'integrations.manage']);
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

function createIdentityService({ pool, authorizeProvisioner, emailProvider, mfaProvider, secretProvider, clock = () => new Date() }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Pool PostgreSQL obrigatório.');
  let dummyPasswordHash;
  const dummyVerify = async password => {
    if (!dummyPasswordHash) dummyPasswordHash = hashPassword('identity-nonexistent-account-dummy-value');
    await verifyPassword(await dummyPasswordHash, password);
  };

  async function provisionInitialOwner(input, context = undefined) {
    const { companyName, email, idempotencyKey } = validateProvisioningInput(input);
    if (typeof authorizeProvisioner !== 'function') {
      throw new IdentityError('PROVISIONER_NOT_CONFIGURED', 'Autorização administrativa não configurada.');
    }
    let actorRef;
    try {
      const actor = await authorizeProvisioner({ action: 'tenant.owner.provision', email, context });
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

  async function inviteMembership(client, principal, { email: emailValue, roleId: roleIdValue }) {
    const email = normalizeEmail(emailValue);
    const roleId = validateUuid(roleIdValue);
    const role = await client.query(`SELECT r.role_key,coalesce(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL),'{}') AS permissions
      FROM rotamoto.roles r LEFT JOIN rotamoto.role_permissions rp ON rp.company_id=r.company_id AND rp.role_id=r.id AND rp.catalog_version=1
      WHERE r.company_id=$1 AND r.id=$2 GROUP BY r.id`, [principal.company_id, roleId]);
    if (!role.rowCount) throw new IdentityError('NOT_FOUND', 'Perfil não encontrado.');
    const actor = await client.query(`SELECT permission_key FROM rotamoto.role_permissions
      WHERE company_id=$1 AND role_id=$2 AND catalog_version=1`, [principal.company_id, principal.role_id]);
    const actorKeys = new Set(actor.rows.map(row => row.permission_key));
    if (role.rows[0].permissions.some(key => !actorKeys.has(key))) throw new IdentityError('FORBIDDEN', 'Não é permitido conceder permissões acima do nível do solicitante.');
    const found = await client.query(`SELECT id::text,disabled_at FROM rotamoto.users WHERE lower(email)=$1`, [email]);
    if (found.rowCount && found.rows[0].disabled_at) throw new IdentityError('CONFLICT', 'A conta não pode receber novo vínculo.');
    const userId = found.rows[0]?.id || id(clock().getTime());
    if (!found.rowCount) await client.query(`INSERT INTO rotamoto.users(id,email) VALUES ($1,$2)`, [userId, email]);
    const existing = await client.query(`SELECT id::text,status FROM rotamoto.memberships WHERE company_id=$1 AND user_id=$2 FOR UPDATE`,
      [principal.company_id, userId]);
    if (existing.rowCount && existing.rows[0].status !== 'invited') throw new IdentityError('CONFLICT', 'Já existe uma associação para esta conta.');
    const membershipId = existing.rows[0]?.id || id(clock().getTime());
    if (existing.rowCount) await client.query(`UPDATE rotamoto.memberships SET role_id=$3,invited_by_user_id=$4,updated_at=now()
      WHERE company_id=$1 AND id=$2`, [principal.company_id, membershipId, roleId, principal.user_id]);
    else await client.query(`INSERT INTO rotamoto.memberships(id,company_id,user_id,role_id,status,invited_by_user_id)
      VALUES ($1,$2,$3,$4,'invited',$5)`, [membershipId, principal.company_id, userId, roleId, principal.user_id]);
    await client.query(`UPDATE rotamoto.identity_tokens SET consumed_at=now() WHERE company_id=$1 AND user_id=$2
      AND purpose='membership_invitation' AND consumed_at IS NULL`, [principal.company_id, userId]);
    const invitation = newToken();
    const expiresAt = new Date(clock().getTime() + INVITATION_TTL_MS);
    const company = await client.query(`SELECT name FROM rotamoto.companies WHERE id=$1`, [principal.company_id]);
    const tokenId = id(clock().getTime());
    await client.query(`INSERT INTO rotamoto.identity_tokens(id,company_id,user_id,purpose,token_digest,expires_at)
      VALUES ($1,$2,$3,'membership_invitation',$4,$5)`, [tokenId, principal.company_id, userId,
      invitation.digest, expiresAt]);
    await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
      action: 'membership.invitation.created', resourceType: 'membership', resourceId: membershipId,
      details: { roleId, existingUser: Boolean(found.rowCount) } });
    return { membershipId, companyId: principal.company_id, actorUserId: principal.user_id, tokenId,
      message: { kind: 'membership_invitation', to: email, token: invitation.token,
        companyId: principal.company_id, companyName: company.rows[0]?.name || '', expiresAt } };
  }

  async function inviteMembershipWithSession(sessionToken, csrfToken, input) {
    const email = normalizeEmail(input?.email);
    const roleId = validateUuid(input?.roleId);
    const lockKey = `membership_invitation:${email}`;
    const client = await pool.connect();
    let lockHeld = false; let provider;
    try {
      await client.query(`SELECT pg_advisory_lock(hashtextextended($1,0))`, [lockKey]); lockHeld = true;
      const prepared = await transaction(client, async () => {
        const principal = await resolveSession(client, sessionToken);
        if (!principal) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
        await setTenant(client, principal.company_id);
        if (!await verifyCsrf(client, principal.session_id, csrfToken)) throw new IdentityError('CSRF_INVALID', 'Validação CSRF inválida.');
        const allowed = await client.query(`SELECT 1 FROM rotamoto.role_permissions WHERE company_id=$1
          AND role_id=$2 AND permission_key='members.invite' AND catalog_version=1`, [principal.company_id, principal.role_id]);
        if (!allowed.rowCount) throw new IdentityError('FORBIDDEN', 'Operação não autorizada.');
        if (!principal.mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'O envio de convites exige MFA verificado.');
        provider = requireEmailProvider(emailProvider);
        return inviteMembership(client, principal, { ...input, email, roleId });
      });
      try { await provider.send(prepared.message); }
      catch (_) {
        await transaction(client, async () => {
          await setTenant(client, prepared.companyId);
          await client.query(`UPDATE rotamoto.identity_tokens SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL`, [prepared.tokenId]);
          await audit(client, { companyId: prepared.companyId, actorUserId: prepared.actorUserId, actorKind: 'user',
            action: 'membership.invitation.delivery_failed', resourceType: 'membership', resourceId: prepared.membershipId });
        });
        throw new IdentityError('EMAIL_DELIVERY_FAILED', 'Entrega do convite indisponível.');
      }
      await transaction(client, async () => {
        await setTenant(client, prepared.companyId);
        await audit(client, { companyId: prepared.companyId, actorUserId: prepared.actorUserId, actorKind: 'user',
          action: 'membership.invitation.sent', resourceType: 'membership', resourceId: prepared.membershipId });
      });
      return { membershipId: prepared.membershipId, delivery: 'sent' };
    } finally {
      if (lockHeld) await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [lockKey]).catch(() => {});
      client.release();
    }
  }

  async function consumeMembershipInvitation({ token, password }) {
    const digest = tokenDigest(token);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const found = await client.query(`SELECT id::text,company_id::text,user_id::text FROM rotamoto.identity_tokens
          WHERE token_digest=$1 AND purpose='membership_invitation' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [digest]);
        if (!found.rowCount) throw new IdentityError('INVALID_TOKEN', 'Convite inválido ou expirado.');
        const row = found.rows[0]; await setTenant(client, row.company_id);
        const member = await client.query(`SELECT m.status,u.disabled_at,c.user_id IS NOT NULL AS has_credential,m.role_id::text
          FROM rotamoto.memberships m JOIN rotamoto.users u ON u.id=m.user_id
          LEFT JOIN rotamoto.credentials c ON c.user_id=u.id
          WHERE m.company_id=$1 AND m.user_id=$2 AND m.status='invited' FOR UPDATE OF m`, [row.company_id, row.user_id]);
        if (!member.rowCount || member.rows[0].disabled_at) throw new IdentityError('INVALID_TOKEN', 'Convite inválido ou expirado.');
        if (member.rows[0].has_credential) throw new IdentityError('AUTHENTICATION_REQUIRED', 'Entre na conta existente para aceitar o convite.');
        const roleMfa = await client.query(`SELECT EXISTS (SELECT 1 FROM rotamoto.role_permissions
          WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 AND permission_key=ANY($3::text[])) AS required`,
        [row.company_id, member.rows[0].role_id, [...MFA_PERMISSIONS]]);
        const passwordHash = await hashPassword(password);
        await client.query(`INSERT INTO rotamoto.credentials(user_id,password_phc,mfa_required) VALUES ($1,$2,$3)`,
          [row.user_id, passwordHash, roleMfa.rows[0].required]);
        await client.query(`UPDATE rotamoto.users SET email_verified_at=now(),updated_at=now() WHERE id=$1`, [row.user_id]);
        await client.query(`UPDATE rotamoto.memberships SET status='active',activated_at=now(),updated_at=now()
          WHERE company_id=$1 AND user_id=$2`, [row.company_id, row.user_id]);
        await client.query(`UPDATE rotamoto.identity_tokens SET consumed_at=now() WHERE id=$1`, [row.id]);
        await audit(client, { companyId: row.company_id, actorUserId: row.user_id, actorKind: 'user',
          action: 'membership.invitation.accepted', resourceType: 'membership', resourceId: row.user_id });
        return { userId: row.user_id, companyId: row.company_id };
      });
    } finally { client.release(); }
  }

  async function acceptExistingMembershipInvitation(sessionToken, token) {
    const digest = tokenDigest(token);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const session = await resolveSession(client, sessionToken);
        if (!session) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
        const invitation = await client.query(`SELECT id::text,company_id::text,user_id::text FROM rotamoto.identity_tokens
          WHERE token_digest=$1 AND purpose='membership_invitation' AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, [digest]);
        if (!invitation.rowCount || invitation.rows[0].user_id !== session.user_id) throw new IdentityError('INVALID_TOKEN', 'Convite inválido ou expirado.');
        const row = invitation.rows[0]; await setTenant(client, row.company_id);
        const membership = await client.query(`SELECT m.id::text,m.role_id::text FROM rotamoto.memberships m
          WHERE m.company_id=$1 AND m.user_id=$2 AND m.status='invited' FOR UPDATE`, [row.company_id, row.user_id]);
        if (!membership.rowCount) throw new IdentityError('INVALID_TOKEN', 'Convite inválido ou expirado.');
        const roleMfa = await client.query(`SELECT EXISTS (SELECT 1 FROM rotamoto.role_permissions
          WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 AND permission_key=ANY($3::text[])) AS required`,
        [row.company_id, membership.rows[0].role_id, [...MFA_PERMISSIONS]]);
        await client.query(`UPDATE rotamoto.memberships SET status='active',activated_at=now(),updated_at=now()
          WHERE company_id=$1 AND user_id=$2`, [row.company_id, row.user_id]);
        if (roleMfa.rows[0].required) {
          await client.query(`UPDATE rotamoto.credentials SET mfa_required=true,updated_at=now() WHERE user_id=$1`, [row.user_id]);
          await client.query(`UPDATE rotamoto.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [row.user_id]);
        }
        await client.query(`UPDATE rotamoto.identity_tokens SET consumed_at=now() WHERE id=$1`, [row.id]);
        await audit(client, { companyId: row.company_id, actorUserId: row.user_id, actorKind: 'user',
          action: 'membership.invitation.accepted', resourceType: 'membership', resourceId: membership.rows[0].id });
        return { membershipId: membership.rows[0].id, companyId: row.company_id };
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
        await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=coalesce(consumed_at,now()) WHERE user_id=$1 AND purpose='password_recovery' AND consumed_at IS NULL`, [userId]);
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
              WHERE purpose='password_recovery' AND token_digest=$1 AND consumed_at IS NULL`, [tokenDigest(pending.token)]);
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
          AND r.purpose='password_recovery' AND r.expires_at>now() AND u.disabled_at IS NULL FOR UPDATE OF r,u`, [digest]);
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

  async function startMfaEnrollment(sessionToken) {
    if (!secretProvider || typeof secretProvider.put !== 'function') throw new IdentityError('MFA_PROVIDER_UNAVAILABLE', 'Keystore MFA indisponível.');
    return withAuthenticatedTenant(sessionToken, async (client, principal) => {
      const current = await client.query(`SELECT mfa_secret_ref,mfa_enrollment_secret_ref FROM rotamoto.credentials
        WHERE user_id=$1 FOR UPDATE`, [principal.user_id]);
      if (!current.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Credencial indisponível.');
      if (current.rows[0].mfa_secret_ref && !principal.mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'Verifique MFA antes de substituir o fator.');
      const secret = generateSecret();
      const ref = (await secretProvider.put({ name: `identity/mfa/${principal.user_id}`, scope: 'installation', value: secret })).secretRef;
      const oldPending = current.rows[0].mfa_enrollment_secret_ref;
      try {
        await client.query(`UPDATE rotamoto.credentials SET mfa_enrollment_secret_ref=$2,mfa_enrollment_expires_at=now()+interval '10 minutes',
          mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=now() WHERE user_id=$1`, [principal.user_id, ref]);
      } catch (error) { await secretProvider.remove(ref).catch(() => {}); throw error; }
      await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
        action: 'identity.mfa.enrollment_started', resourceType: 'user', resourceId: principal.user_id });
      if (oldPending && oldPending !== ref) await secretProvider.remove(oldPending).catch(() => {});
      const user = await client.query('SELECT email FROM rotamoto.users WHERE id=$1', [principal.user_id]);
      return { secret, otpauthUri: otpauthUri(secret, { account: user.rows[0].email }) };
    }, 'identity.mfa.enroll');
  }

  async function confirmMfaEnrollment(sessionToken, code) {
    if (!secretProvider || typeof secretProvider.get !== 'function') throw new IdentityError('MFA_PROVIDER_UNAVAILABLE', 'Keystore MFA indisponível.');
    const outcome = await withAuthenticatedTenant(sessionToken, async (client, principal) => {
      const current = await client.query(`SELECT c.mfa_secret_ref,c.mfa_enrollment_secret_ref,c.mfa_enrollment_expires_at,
        c.mfa_totp_last_counter,c.mfa_failed_attempts,c.mfa_locked_until,u.email FROM rotamoto.credentials c
        JOIN rotamoto.users u ON u.id=c.user_id WHERE c.user_id=$1 FOR UPDATE OF c`, [principal.user_id]);
      if (!current.rowCount || !current.rows[0].mfa_enrollment_secret_ref || new Date(current.rows[0].mfa_enrollment_expires_at) <= clock())
        throw new IdentityError('MFA_ENROLLMENT_EXPIRED', 'Enrollment expirado; inicie novamente.');
      if (current.rows[0].mfa_secret_ref && !principal.mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'Verifique MFA antes de substituir o fator.');
      if (current.rows[0].mfa_locked_until && new Date(current.rows[0].mfa_locked_until) > clock()) throw new IdentityError('RATE_LIMITED', 'Muitas tentativas MFA; aguarde antes de tentar novamente.');
      const secret = await secretProvider.get(current.rows[0].mfa_enrollment_secret_ref,
        { name: `identity/mfa/${principal.user_id}`, scope: 'installation' });
      const counter = verifyCode(secret, code, { now: clock().getTime(), lastCounter: -1 });
      if (counter === null) {
        await client.query(`UPDATE rotamoto.credentials SET mfa_failed_attempts=least(mfa_failed_attempts+1,10),
          mfa_locked_until=CASE WHEN mfa_failed_attempts+1>=10 THEN now()+interval '15 minutes' ELSE mfa_locked_until END,updated_at=now()
          WHERE user_id=$1`, [principal.user_id]);
        await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
          action: 'identity.mfa.enrollment_failed', resourceType: 'user', resourceId: principal.user_id });
        return { invalidCode: true };
      }
      const oldRef = current.rows[0].mfa_secret_ref;
      const recoveryCodes = generateRecoveryCodes();
      const now = clock();
      await client.query(`UPDATE rotamoto.credentials SET mfa_secret_ref=mfa_enrollment_secret_ref,mfa_required=true,
        mfa_enrollment_secret_ref=NULL,mfa_enrollment_expires_at=NULL,mfa_totp_last_counter=$2,
        mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=$3 WHERE user_id=$1`, [principal.user_id, counter, now]);
      await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=$2 WHERE user_id=$1 AND purpose='mfa_recovery' AND consumed_at IS NULL`, [principal.user_id, now]);
      for (const recoveryCode of recoveryCodes) await client.query(`INSERT INTO rotamoto.recovery_tokens
        (id,user_id,token_digest,expires_at,purpose) VALUES ($1,$2,$3,$4,'mfa_recovery')`,
      [id(), principal.user_id, recoveryDigest(recoveryCode), new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)]);
      await client.query('UPDATE rotamoto.sessions SET mfa_verified_at=$2 WHERE id=$1', [principal.session_id, now]);
      await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
        action: 'identity.mfa.enabled', resourceType: 'user', resourceId: principal.user_id,
        details: { recovery_codes_issued: recoveryCodes.length } });
      return { recoveryCodes, oldRef, newRef: current.rows[0].mfa_enrollment_secret_ref };
    }, 'identity.mfa.enroll');
    if (outcome.invalidCode) throw new IdentityError('MFA_REQUIRED', 'Código MFA inválido.');
    if (outcome.oldRef && outcome.oldRef !== outcome.newRef) await secretProvider.remove(outcome.oldRef).catch(() => {});
    return { recoveryCodes: outcome.recoveryCodes };
  }

  async function regenerateMfaRecoveryCodes(sessionToken) {
    const outcome = await withAuthenticatedTenant(sessionToken, async (client, principal) => {
      const credential = await client.query('SELECT mfa_secret_ref FROM rotamoto.credentials WHERE user_id=$1 FOR UPDATE', [principal.user_id]);
      if (!credential.rowCount || !credential.rows[0].mfa_secret_ref) throw new IdentityError('MFA_REQUIRED', 'MFA não está habilitado.');
      const codes = generateRecoveryCodes(), now = clock();
      await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=$2
        WHERE user_id=$1 AND purpose='mfa_recovery' AND consumed_at IS NULL`, [principal.user_id, now]);
      for (const recoveryCode of codes) await client.query(`INSERT INTO rotamoto.recovery_tokens
        (id,user_id,token_digest,expires_at,purpose) VALUES ($1,$2,$3,$4,'mfa_recovery')`,
      [id(), principal.user_id, recoveryDigest(recoveryCode), new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)]);
      await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
        action: 'identity.mfa.recovery_codes_regenerated', resourceType: 'user', resourceId: principal.user_id,
        details: { recovery_codes_issued: codes.length } });
      return codes;
    }, 'company.manage');
    return { recoveryCodes: outcome };
  }

  async function authenticate(emailValue, password, requestedCompanyId, mfaCode) {
    const email = normalizeEmail(emailValue);
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024) {
      throw new IdentityError('INVALID_CREDENTIALS', 'Email ou senha inválidos.');
    }
    const client = await pool.connect();
    try {
      const result = await transaction(client, async () => {
        const found = await client.query(`SELECT u.id::text AS user_id,u.disabled_at,c.password_phc,c.locked_until,c.mfa_required,
          c.mfa_secret_ref,c.mfa_locked_until FROM rotamoto.users u JOIN rotamoto.credentials c ON c.user_id=u.id
          WHERE lower(u.email)=$1 FOR UPDATE OF c`, [email]);
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
        const companyId = validateUuid(requestedCompanyId);
        await setTenant(client, companyId);
        const membership = await client.query(`SELECT m.company_id::text,m.role_id::text FROM rotamoto.memberships m
          JOIN rotamoto.companies c ON c.id=m.company_id WHERE m.user_id=$1 AND m.company_id=$2
          AND m.status='active' AND c.status='active'`, [credential.user_id, companyId]);
        if (!membership.rowCount) return { error: 'INVALID_CREDENTIALS' };
        const sensitive = await client.query(`SELECT EXISTS (SELECT 1 FROM rotamoto.role_permissions
          WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 AND permission_key=ANY($3::text[])) AS required`,
        [companyId, membership.rows[0].role_id, MFA_PERMISSIONS]);
        const mfaRequired = reset.rows[0].mfa_required || sensitive.rows[0].required;
        let mfaVerified = false;
        if (mfaRequired) {
          if (!credential.mfa_secret_ref) {
            await client.query('UPDATE rotamoto.credentials SET mfa_required=true,updated_at=now() WHERE user_id=$1', [credential.user_id]);
            return { session: await createSession(client, credential.user_id, membership.rows[0].company_id, false), enrollmentRequired: true };
          }
          if (credential.mfa_locked_until && new Date(credential.mfa_locked_until) > clock()) {
            await audit(client, { companyId, actorUserId: credential.user_id, actorKind: 'user',
              action: 'identity.mfa.verification_throttled', resourceType: 'user', resourceId: credential.user_id });
            return { error: 'RATE_LIMITED' };
          }
          if (!mfaProvider || typeof mfaProvider.verify !== 'function' || typeof mfaCode !== 'string' || !mfaCode) {
            await audit(client, { companyId, actorUserId: credential.user_id, actorKind: 'user',
              action: 'identity.mfa.verification_failed', resourceType: 'user', resourceId: credential.user_id });
            return { error: 'MFA_REQUIRED' };
          }
          try { mfaVerified = await mfaProvider.verify({ client, userId: credential.user_id, code: mfaCode, secretRef: credential.mfa_secret_ref }) === true; }
          catch (_) { throw new IdentityError('MFA_PROVIDER_UNAVAILABLE', 'Verificação multifator indisponível.'); }
          if (!mfaVerified) {
            await client.query(`UPDATE rotamoto.credentials SET mfa_failed_attempts=least(mfa_failed_attempts+1,10),
              mfa_locked_until=CASE WHEN mfa_failed_attempts+1>=10 THEN now()+interval '15 minutes' ELSE mfa_locked_until END,updated_at=now()
              WHERE user_id=$1`, [credential.user_id]);
            await audit(client, { companyId, actorUserId: credential.user_id, actorKind: 'user',
              action: 'identity.mfa.verification_failed', resourceType: 'user', resourceId: credential.user_id });
            return { error: 'MFA_REQUIRED' };
          }
          await client.query('UPDATE rotamoto.credentials SET mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=now() WHERE user_id=$1', [credential.user_id]);
          await audit(client, { companyId, actorUserId: credential.user_id, actorKind: 'user',
            action: 'identity.mfa.login_verified', resourceType: 'user', resourceId: credential.user_id,
            details: { method: /^\d{6}$/u.test(mfaCode) ? 'totp' : 'recovery_code' } });
        }
        return createSession(client, credential.user_id, membership.rows[0].company_id, mfaVerified);
      });
      if (result?.error) {
        const messages = { INVALID_CREDENTIALS: 'Email ou senha inválidos.', MFA_REQUIRED: 'A autenticação multifator desta conta ainda não está configurada.' };
        throw new IdentityError(result.error, messages[result.error]);
      }
      if (result?.session) return { ...result.session, mfaEnrollmentRequired: result.enrollmentRequired };
      return result;
    } finally { client.release(); }
  }

  async function createSession(client, userId, companyId, mfaVerified = false) {
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const csrfToken = deriveCsrfToken(sessionToken);
    const now = clock();
    const sessionId = id();
    const inserted = await client.query(`INSERT INTO rotamoto.sessions
      (id,user_id,active_company_id,token_digest,csrf_digest,idle_expires_at,absolute_expires_at,mfa_verified_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 THEN $9::timestamptz ELSE NULL END WHERE EXISTS (
        SELECT 1 FROM rotamoto.memberships WHERE company_id=$3 AND user_id=$2 AND status='active'
      ) RETURNING id::text`, [sessionId, userId, companyId, digestText(sessionToken), digestText(csrfToken),
      new Date(now.getTime() + SESSION_IDLE_MS), new Date(now.getTime() + SESSION_ABSOLUTE_MS), mfaVerified, now]);
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
      FROM rotamoto.users u,rotamoto.memberships m,rotamoto.companies c,rotamoto.credentials cred
      WHERE s.token_digest=$1 AND s.user_id=u.id AND s.active_company_id=m.company_id AND m.user_id=s.user_id
        AND m.company_id=c.id AND s.revoked_at IS NULL AND s.idle_expires_at>$2 AND s.absolute_expires_at>$2
        AND u.disabled_at IS NULL AND m.status='active' AND c.status='active' AND cred.user_id=s.user_id
      RETURNING s.id::text AS session_id,s.user_id::text,s.active_company_id::text AS company_id,m.role_id::text,
        m.driver_id::text AS driver_id,c.time_zone AS company_time_zone,s.mfa_verified_at,cred.mfa_required,cred.mfa_secret_ref IS NOT NULL AS mfa_configured,
        (cred.mfa_required AND cred.mfa_secret_ref IS NULL) AS mfa_enrollment_required`, [digest, now]);
    return result.rowCount ? { ...result.rows[0], authenticated: true } : null;
  }

  async function verifyCsrf(client, sessionId, csrfToken) {
    let digest;
    try { digest = tokenDigest(csrfToken); } catch (_) { return false; }
    const result = await client.query(`SELECT 1 FROM rotamoto.sessions WHERE id=$1 AND csrf_digest=$2
      AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()`, [sessionId, digest]);
    return result.rowCount === 1;
  }

  async function renewCsrfToken(client, sessionId, sessionToken) {
    if (typeof sessionToken !== 'string' || !sessionToken) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
    const csrfToken = deriveCsrfToken(sessionToken);
    const result = await client.query(`UPDATE rotamoto.sessions SET csrf_digest=$2
      WHERE id=$1 AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()
      RETURNING id`, [sessionId, digestText(csrfToken)]);
    if (!result.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
    return csrfToken;
  }

  async function switchActiveCompany(sessionToken, companyId) {
    const selectedCompanyId = validateUuid(companyId);
    const digest = tokenDigest(sessionToken);
    const client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const session = await client.query(`SELECT id::text,user_id::text,mfa_verified_at FROM rotamoto.sessions
          WHERE token_digest=$1 AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()
          FOR UPDATE`, [digest]);
        if (!session.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');
        const { id: sessionId, user_id: userId } = session.rows[0];
        await setTenant(client, selectedCompanyId);
        const membership = await client.query(`SELECT m.role_id::text FROM rotamoto.memberships m
          JOIN rotamoto.companies c ON c.id=m.company_id WHERE m.company_id=$1 AND m.user_id=$2
          AND m.status='active' AND c.status='active'`, [selectedCompanyId, userId]);
        if (!membership.rowCount) throw new IdentityError('FORBIDDEN', 'Empresa sem associação ativa.');
        const requiresMfa = await client.query(`SELECT EXISTS (SELECT 1 FROM rotamoto.role_permissions
          WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 AND permission_key=ANY($3::text[])) AS required`,
        [selectedCompanyId, membership.rows[0].role_id, MFA_PERMISSIONS]);
        if (requiresMfa.rows[0].required && !session.rows[0].mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'A empresa exige sessão com MFA verificado.');
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
        if (principal.mfa_enrollment_required && permissionKey && permissionKey !== 'identity.mfa.enroll')
          throw new IdentityError('MFA_REQUIRED', 'Configure MFA antes de usar a conta.');
        if (permissionKey) {
          const permission = requiredText(permissionKey, 'Permissão', 120);
          if (permission === 'identity.mfa.enroll') return operation(client, principal);
          const allowed = await client.query(`SELECT 1 FROM rotamoto.role_permissions rp
            WHERE rp.company_id=$1 AND rp.role_id=$2 AND rp.permission_key=$3 AND rp.catalog_version=1`,
          [principal.company_id, principal.role_id, permission]);
          if (!allowed.rowCount) throw new IdentityError('FORBIDDEN', 'Operação não autorizada.');
          if (MFA_PERMISSIONS.includes(permission) && !principal.mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'Esta operação exige MFA verificado.');
        }
        return operation(client, principal);
      });
    } finally { client.release(); }
  }

  return Object.freeze({ provisionInitialOwner, consumeOwnerInvitation, inviteMembershipWithSession, consumeMembershipInvitation,
    acceptExistingMembershipInvitation, requestPasswordRecovery,
    consumePasswordRecovery, authenticate, startMfaEnrollment, confirmMfaEnrollment, regenerateMfaRecoveryCodes,
    resolveSession, verifyCsrf, renewCsrfToken, switchActiveCompany, revokeSession, withAuthenticatedTenant });
}

module.exports = { createIdentityService, IdentityError, normalizeEmail, tokenDigest, uuidV7: id,
  SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, INVITATION_TTL_MS, RECOVERY_TTL_MS };
