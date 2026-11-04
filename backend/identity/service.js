'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { deriveCsrfToken } = require('./csrf');
const { hashPassword, verifyPassword } = require('./passwords');
const { requireEmailProvider } = require('./email-provider');
const { generateSecret, isValidMfaProof, otpauthUri, verifyCode, generateRecoveryCodes, recoveryDigest } = require('./totp');
const { validateInitialSetup } = require('./bootstrap-setup');

const OWNER_PERMISSIONS = Object.freeze([
  'company.manage', 'members.invite', 'members.read', 'orders.read', 'orders.manage', 'integrations.manage',
  'sync.pull', 'sync.push', 'finance.read', 'finance.manage'
]);
const MFA_PERMISSIONS = Object.freeze(['company.manage', 'members.invite', 'integrations.manage', 'finance.manage']);
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
      Object.keys(input).some(key => !['companyName', 'email', 'idempotencyKey', 'initialSetup', 'localOnly'].includes(key)) ||
      input.localOnly !== undefined && typeof input.localOnly !== 'boolean') {
    throw new IdentityError('INVALID_INPUT', 'Dados de provisionamento inválidos.');
  }
  const companyName = requiredText(input.companyName, 'Nome da empresa', 160);
  const email = normalizeEmail(input.email);
  const idempotencyKey = requiredText(input.idempotencyKey, 'Chave idempotente', 128);
  if (Buffer.byteLength(idempotencyKey, 'utf8') < 16) {
    throw new IdentityError('INVALID_INPUT', 'Chave idempotente inválida.');
  }
  return { companyName, email, idempotencyKey, localOnly: input.localOnly === true,
    initialSetup: input.initialSetup === undefined ? null : validateInitialSetup(input.initialSetup) };
}

function createIdentityService({ pool, authorizeProvisioner, authorizeMfaRecoveryOperator, emailProvider, mfaProvider, secretProvider,
  requireBootstrapAuthorization = false, clock = () => new Date() }) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Pool PostgreSQL obrigatório.');
  const provisionerProofs = new WeakMap();
  // Runtime secret stores may require asynchronous filesystem/keystore validation
  // during startup. Resolve once per operation instead of treating the Promise as
  // the provider object (which would silently make put/get unavailable).
  const secretProviderPromise = secretProvider ? Promise.resolve(secretProvider) : null;
  async function requireSecretProvider(method) {
    if (!secretProviderPromise) throw new IdentityError('MFA_PROVIDER_UNAVAILABLE', 'Keystore MFA indisponível.');
    let provider;
    try { provider = await secretProviderPromise; }
    catch (_) { throw new IdentityError('MFA_PROVIDER_UNAVAILABLE', 'Keystore MFA indisponível.'); }
    if (!provider || typeof provider[method] !== 'function')
      throw new IdentityError('MFA_PROVIDER_UNAVAILABLE', 'Keystore MFA indisponível.');
    return provider;
  }
  let dummyPasswordHash;
  const dummyVerify = async password => {
    if (!dummyPasswordHash) dummyPasswordHash = hashPassword('identity-nonexistent-account-dummy-value');
    await verifyPassword(await dummyPasswordHash, password);
  };

  async function getBootstrapStatus() {
    const client = await pool.connect();
    try {
      const schema = await client.query(`SELECT
        to_regclass('rotamoto.installation_bootstrap') IS NOT NULL AS latch_ready,
        to_regclass('rotamoto.bootstrap_authorizations') IS NOT NULL AS authorization_ready,
        to_regclass('rotamoto.platform_admin_bootstrap_latch') IS NOT NULL AS founder_latch_ready,
        to_regprocedure('rotamoto.platform_admin_bootstrap_status()') IS NOT NULL AS status_function_ready,
        to_regclass('rotamoto.company_delivery_pricing') IS NOT NULL AS pricing_ready,
        EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('rotamoto.provisioning_requests')
          AND attname='bootstrap_capability_digest' AND NOT attisdropped) AS deferred_mfa_ready`);
      const checks = schema.rows[0] || {};
      const ready = checks.latch_ready && checks.authorization_ready && checks.founder_latch_ready &&
        checks.deferred_mfa_ready && checks.status_function_ready && checks.pricing_ready;
      if (!ready) return { state: 'not_ready', checks: { schema: false, pricing: Boolean(checks.pricing_ready) } };
      const status = await client.query('SELECT rotamoto.platform_admin_bootstrap_status() AS state');
      const state = status.rows[0]?.state;
      if (!['ready', 'pending_owner_activation', 'pending_owner_mfa', 'complete', 'unavailable'].includes(state))
        return { state: 'not_ready', checks: { schema: false, pricing: Boolean(checks.pricing_ready) } };
      return { state, checks: { schema: true, pricing: Boolean(checks.pricing_ready) } };
    } catch (error) {
      if (error.code === '42P01' || error.code === '42703') return { state: 'not_ready', checks: { schema: false, pricing: false } };
      throw error;
    } finally { client.release(); }
  }

  async function verifyInitialSetupReadback(client, companyId, companyName, initialSetup) {
    if (!initialSetup) return false;
    const company = await client.query(`SELECT name,support_phone,time_zone,route_grouping_policy,operational_address,
      operational_latitude,operational_longitude FROM rotamoto.companies WHERE id=$1`, [companyId]);
    const expectedLocation = initialSetup.company.operationalLocation;
    const row = company.rows[0];
    const latitude = row?.operational_latitude == null ? null : Number(row.operational_latitude);
    const longitude = row?.operational_longitude == null ? null : Number(row.operational_longitude);
    if (!row || row.name !== companyName || row.support_phone !== initialSetup.company.supportPhone ||
        row.time_zone !== initialSetup.company.timeZone || row.route_grouping_policy !== initialSetup.company.routeGroupingPolicy ||
        row.operational_address !== (expectedLocation?.address ?? null) ||
        latitude !== (expectedLocation?.latitude ?? null) || longitude !== (expectedLocation?.longitude ?? null)) {
      throw new IdentityError('BOOTSTRAP_READBACK_FAILED', 'Não foi possível confirmar a configuração inicial da empresa.');
    }
    const pricing = await client.query('SELECT settings,version FROM rotamoto.company_delivery_pricing WHERE company_id=$1', [companyId]);
    if (initialSetup.deliveryPricing) {
      if (!pricing.rowCount || Number(pricing.rows[0].version) !== 1 ||
          !isDeepStrictEqual(pricing.rows[0].settings, initialSetup.deliveryPricing))
        throw new IdentityError('BOOTSTRAP_READBACK_FAILED', 'Não foi possível confirmar as regras iniciais de entrega.');
    } else if (pricing.rowCount) {
      throw new IdentityError('BOOTSTRAP_READBACK_FAILED', 'A cobrança não configurada não deveria ter sido persistida.');
    }
    return true;
  }

  async function verifyCommittedInitialSetup(companyId, companyName, initialSetup) {
    const client = await pool.connect();
    try {
      await transaction(client, async () => {
        await setTenant(client, companyId);
        await verifyInitialSetupReadback(client, companyId, companyName, initialSetup);
      });
    } finally { client.release(); }
  }

  async function authorizeProvisionerRequest(input, context = undefined) {
    const { email } = validateProvisioningInput(input);
    if (typeof authorizeProvisioner !== 'function') {
      throw new IdentityError('PROVISIONER_NOT_CONFIGURED', 'Autorização administrativa não configurada.');
    }
    let actor;
    try {
      actor = await authorizeProvisioner({ action: 'tenant.owner.provision', email, context });
      requiredText(actor?.actorRef, 'Identidade administrativa', 160);
      if (context?.requestedLocalOnly === true && actor?.localOnly !== true)
        throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'Modo de instalação local não autorizado.');
      if (actor?.bootstrapCapabilityDigest !== undefined &&
          (!Buffer.isBuffer(actor.bootstrapCapabilityDigest) || actor.bootstrapCapabilityDigest.length !== 32))
        throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'Provisionamento administrativo não autorizado.');
      if (requireBootstrapAuthorization && !actor?.bootstrapCapabilityDigest)
        throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'Provisionamento administrativo não autorizado.');
    } catch (_) {
      throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'Provisionamento administrativo não autorizado.');
    }
    const proof = Object.freeze({});
    provisionerProofs.set(proof, { actor, email, request: context?.request,
      requestedLocalOnly: context?.requestedLocalOnly === true });
    return proof;
  }

  async function provisionInitialOwner(input, context = undefined, authorizationProof = undefined) {
    const { companyName, email, idempotencyKey, initialSetup, localOnly: requestedLocalOnly } = validateProvisioningInput(input);
    const suppliedProof = authorizationProof === undefined ? null : provisionerProofs.get(authorizationProof);
    if (authorizationProof !== undefined && (!suppliedProof || suppliedProof.email !== email ||
        suppliedProof.request !== context?.request || suppliedProof.requestedLocalOnly !== (context?.requestedLocalOnly === true)))
      throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'Provisionamento administrativo não autorizado.');
    const proof = authorizationProof === undefined ? await authorizeProvisionerRequest(input, context) : authorizationProof;
    const { actor } = provisionerProofs.get(proof);
    provisionerProofs.delete(proof);
    let actorRef;
    let bootstrapCapabilityDigest = null;
    let localOnly = false;
    actorRef = requiredText(actor?.actorRef, 'Identidade administrativa', 160);
    localOnly = requestedLocalOnly && actor?.localOnly === true;
    if (actor?.bootstrapCapabilityDigest !== undefined) bootstrapCapabilityDigest = actor.bootstrapCapabilityDigest;
    const provider = localOnly ? null : requireEmailProvider(emailProvider);
    const normalizedRequest = { companyName, email, localOnly, ...(initialSetup === null ? {} : { initialSetup }) };
    const requestDigest = digestText(JSON.stringify(normalizedRequest));
    const keyDigest = digestText(idempotencyKey);
    const client = await pool.connect();
    let delivery;
    try {
      delivery = await transaction(client, async () => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 817231))', [keyDigest.toString('hex')]);
        const bootstrapSchema = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_attribute
          WHERE attrelid=to_regclass('rotamoto.provisioning_requests')
            AND attname='bootstrap_capability_digest' AND NOT attisdropped) AS ready`);
        const browserBootstrapReady = bootstrapSchema.rows[0]?.ready === true;
        if ((requireBootstrapAuthorization || bootstrapCapabilityDigest || initialSetup) && !browserBootstrapReady)
          throw new IdentityError('BOOTSTRAP_NOT_READY', 'A primeira instalação ainda não está disponível neste schema.');
        const existing = await client.query(`
          SELECT request_digest, company_id::text, user_id::text, delivery_status, updated_at,
            ${browserBootstrapReady ? 'bootstrap_capability_digest' : 'NULL::bytea AS bootstrap_capability_digest'}
          FROM rotamoto.provisioning_requests WHERE idempotency_key_digest=$1
        `, [keyDigest]);
        if (requireBootstrapAuthorization || bootstrapCapabilityDigest) {
          const latch = await client.query(`SELECT completed_at,request_digest FROM rotamoto.installation_bootstrap
            WHERE singleton=true FOR UPDATE`);
          if (!latch.rowCount) throw new IdentityError('BOOTSTRAP_NOT_READY', 'Bootstrap ainda não está preparado.');
          const storedBootstrapCapability = existing.rows[0]?.bootstrap_capability_digest;
          const isReplayOfBootstrap = Boolean(existing.rowCount && bootstrapCapabilityDigest &&
            Buffer.from(latch.rows[0].request_digest || []).equals(keyDigest) &&
            (storedBootstrapCapability && Buffer.from(storedBootstrapCapability).equals(bootstrapCapabilityDigest) ||
              !storedBootstrapCapability && latch.rows[0].completed_at));
          if (!isReplayOfBootstrap) {
            const installState = await client.query('SELECT rotamoto.platform_admin_bootstrap_status() AS state');
            if (installState.rows[0]?.state !== 'ready')
              throw new IdentityError('BOOTSTRAP_NOT_AVAILABLE', 'A instalação inicial não está disponível neste ambiente.');
          }
          const authorized = bootstrapCapabilityDigest && await client.query(`SELECT token_digest,consumed_at FROM rotamoto.bootstrap_authorizations
            WHERE token_digest=$1 AND installation_scope='rotamoto'
              AND ((expires_at>now() AND consumed_at IS NULL) OR (consumed_at IS NOT NULL AND $2::boolean))
            FOR UPDATE`, [bootstrapCapabilityDigest, isReplayOfBootstrap]);
          if (!authorized?.rowCount || latch.rows[0].completed_at && !isReplayOfBootstrap ||
              latch.rows[0].request_digest && !isReplayOfBootstrap)
            throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'Provisionamento administrativo não autorizado.');
          if (authorized.rows[0].consumed_at === null) await client.query(`UPDATE rotamoto.bootstrap_authorizations SET consumed_at=now()
            WHERE token_digest=$1 AND consumed_at IS NULL`, [bootstrapCapabilityDigest]);
        }
        let companyId;
        let userId;
        if (existing.rowCount) {
          const previous = existing.rows[0];
          if (!Buffer.from(previous.request_digest).equals(requestDigest)) {
            throw new IdentityError('IDEMPOTENCY_CONFLICT', 'Chave idempotente reutilizada para dados diferentes.');
          }
          companyId = previous.company_id;
          userId = previous.user_id;
          if (initialSetup) {
            await setTenant(client, companyId);
            await verifyInitialSetupReadback(client, companyId, companyName, initialSetup);
          }
          if (previous.delivery_status === 'sent') {
            return { companyId, userId, replayed: true, send: false, delivery: 'sent', setupReadback: Boolean(initialSetup) };
          }
          if (previous.delivery_status === 'pending' && !localOnly &&
              new Date(previous.updated_at).getTime() > clock().getTime() - DELIVERY_LEASE_MS) {
            return { companyId, userId, replayed: true, send: false, delivery: 'pending', setupReadback: Boolean(initialSetup) };
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
          const companySettings = initialSetup?.company;
          const location = companySettings?.operationalLocation;
          if (initialSetup) {
            await client.query(`INSERT INTO rotamoto.companies
              (id,name,status,support_phone,time_zone,route_grouping_policy,operational_address,operational_latitude,
               operational_longitude,operational_location_provenance,operational_location_version,company_settings_version)
              VALUES($1,$2,'provisioning',$3,$4,$5,$6,$7,$8,
                CASE WHEN $7::double precision IS NULL THEN NULL ELSE 'operator_confirmed' END,
                CASE WHEN $6::text IS NULL AND $7::double precision IS NULL THEN 0 ELSE 1 END,0)`,
            [companyId, companyName, companySettings.supportPhone, companySettings.timeZone,
              companySettings.routeGroupingPolicy, location?.address ?? null, location?.latitude ?? null, location?.longitude ?? null]);
          } else await client.query(`INSERT INTO rotamoto.companies (id,name,status) VALUES ($1,$2,'provisioning')`, [companyId, companyName]);
          await client.query(`INSERT INTO rotamoto.roles (id,company_id,role_key,display_name,is_system_template)
            VALUES ($1,$2,'owner','Proprietário',false)`, [roleId, companyId]);
          await client.query(`INSERT INTO rotamoto.role_permissions (company_id,role_id,permission_key,catalog_version)
            SELECT $1,$2,permission_key,1 FROM rotamoto.permissions WHERE catalog_version=1 AND permission_key=ANY($3::text[])`,
          [companyId, roleId, OWNER_PERMISSIONS]);
          const granted = await client.query(`SELECT count(*)::int AS count FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2`, [companyId, roleId]);
          if (granted.rows[0].count !== OWNER_PERMISSIONS.length) throw new IdentityError('ROLE_CATALOG_INCOMPLETE', 'Catálogo de permissões incompleto.');
          await client.query(`INSERT INTO rotamoto.users (id,email) VALUES ($1,$2)`, [userId, email]);
          if (initialSetup?.deliveryPricing) await client.query(`INSERT INTO rotamoto.company_delivery_pricing
            (company_id,settings,version,updated_by) VALUES($1,$2::jsonb,1,$3)`,
          [companyId, JSON.stringify(initialSetup.deliveryPricing), userId]);
          await client.query(`INSERT INTO rotamoto.memberships (id,company_id,user_id,role_id,status)
            VALUES ($1,$2,$3,$4,'invited')`, [membershipId, companyId, userId, roleId]);
          await audit(client, { companyId, actorKind: 'admin_provisioner', action: 'tenant.owner.provisioned',
            resourceType: 'membership', resourceId: membershipId, details: { actor_ref: actorRef,
              delivery_status: localOnly ? 'local_handoff' : 'pending', installation_mode: localOnly ? 'local_only' : 'public_invitation' } });
          if (browserBootstrapReady) await client.query(`INSERT INTO rotamoto.provisioning_requests
            (idempotency_key_digest,request_digest,company_id,user_id,delivery_status,bootstrap_capability_digest)
            VALUES ($1,$2,$3,$4,'pending',$5)`, [keyDigest, requestDigest, companyId, userId, bootstrapCapabilityDigest]);
          else await client.query(`INSERT INTO rotamoto.provisioning_requests
            (idempotency_key_digest,request_digest,company_id,user_id,delivery_status)
            VALUES ($1,$2,$3,$4,'pending')`, [keyDigest, requestDigest, companyId, userId]);
          if (initialSetup) await verifyInitialSetupReadback(client, companyId, companyName, initialSetup);
        }
        if (bootstrapCapabilityDigest) {
          const reserved = await client.query(`UPDATE rotamoto.installation_bootstrap SET request_digest=$1
            WHERE singleton=true AND completed_at IS NULL AND (request_digest IS NULL OR request_digest=$1)
            RETURNING request_digest`, [keyDigest]);
          if (!reserved.rowCount) throw new IdentityError('PROVISIONER_UNAUTHORIZED', 'A instalação já está reservada ou foi concluída.');
        }
        const invitation = newToken();
        const expiresAt = new Date(clock().getTime() + INVITATION_TTL_MS);
        await client.query(`INSERT INTO rotamoto.identity_tokens
          (id,company_id,user_id,purpose,token_digest,expires_at)
          VALUES ($1,$2,$3,'owner_invitation',$4,$5)`, [id(), companyId, userId, invitation.digest, expiresAt]);
        if (localOnly) await audit(client, { companyId, actorKind: 'admin_provisioner', action: 'tenant.owner.local_invitation_ready',
          resourceType: 'user', resourceId: userId, details: { installation_mode: 'local_only', delivery_status: 'local_handoff' } });
        return { companyId, userId, replayed: Boolean(existing.rowCount), send: !localOnly, localOnly, setupReadback: Boolean(initialSetup),
          message: { to: email, kind: 'owner_invitation', token: invitation.token, expiresAt, companyName } };
      });
    } finally {
      client.release();
    }
    if (delivery.setupReadback) {
      await verifyCommittedInitialSetup(delivery.companyId, companyName, initialSetup);
    }
    if (delivery.localOnly) return { companyId: delivery.companyId, userId: delivery.userId,
      delivery: 'local_handoff', localInvitationToken: delivery.message.token, replayed: delivery.replayed,
      setupReadback: Boolean(delivery.setupReadback) };
    if (!delivery.send) return { companyId: delivery.companyId, userId: delivery.userId,
      delivery: delivery.delivery, replayed: true, setupReadback: Boolean(delivery.setupReadback) };

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
    return { companyId: delivery.companyId, userId: delivery.userId, delivery: sent ? 'sent' : 'failed', replayed: delivery.replayed,
      setupReadback: Boolean(delivery.setupReadback) };
  }

  async function consumeOwnerInvitation({ token, password }) {
    const digest = tokenDigest(token);
    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      const activation = await transaction(client, async () => {
        const found = await client.query(`SELECT t.id::text,t.company_id::text,t.user_id::text,u.email
          FROM rotamoto.identity_tokens t JOIN rotamoto.users u ON u.id=t.user_id
          WHERE t.token_digest=$1 AND t.purpose='owner_invitation' AND t.consumed_at IS NULL AND t.expires_at>now()
          FOR UPDATE OF t,u`, [digest]);
        if (!found.rowCount) throw new IdentityError('INVALID_TOKEN', 'Token inválido ou expirado.');
        const { id: tokenId, company_id: companyId, user_id: userId, email } = found.rows[0];
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
        await audit(client, { companyId, actorUserId: userId, actorKind: 'user', action: 'identity.activation_confirmation.queued',
          resourceType: 'user', resourceId: userId, details: { notification: 'account_activated' } });
        return { userId, companyId, email };
      });
      let notificationStatus = 'not_configured';
      let notificationCode = null;
      if (emailProvider?.send) {
        try {
          const sent = await emailProvider.send({ to: activation.email, kind: 'account_activated' });
          if (sent !== true) throw Object.assign(new Error('Activation notification was not accepted.'), { code: 'EMAIL_DELIVERY_FAILED' });
          notificationStatus = 'sent';
        } catch (error) {
          notificationStatus = 'failed';
          notificationCode = typeof error?.code === 'string' && /^(?:SMTP_[A-Z0-9_]{1,60}|EMAIL_[A-Z0-9_]{1,60}|INVITATION_LINKS_UNAVAILABLE)$/u.test(error.code)
            ? error.code : 'EMAIL_DELIVERY_FAILED';
        }
      }
      await transaction(client, async () => {
        await setTenant(client, activation.companyId);
        await audit(client, { companyId: activation.companyId, actorUserId: activation.userId, actorKind: 'user',
          action: `identity.activation_confirmation.${notificationStatus}`, resourceType: 'user', resourceId: activation.userId,
          details: { notification: 'account_activated', ...(notificationCode ? { errorCode: notificationCode } : {}) } });
      }).catch(() => {});
      return { userId: activation.userId, companyId: activation.companyId, mfaRequired: true };
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
      catch (deliveryError) {
        await transaction(client, async () => {
          await setTenant(client, prepared.companyId);
          await client.query(`UPDATE rotamoto.identity_tokens SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL`, [prepared.tokenId]);
          await audit(client, { companyId: prepared.companyId, actorUserId: prepared.actorUserId, actorKind: 'user',
            action: 'membership.invitation.delivery_failed', resourceType: 'membership', resourceId: prepared.membershipId });
        });
        if (deliveryError?.code === 'INVITATION_LINKS_UNAVAILABLE')
          throw new IdentityError('INVITATION_LINKS_UNAVAILABLE', 'Convites externos exigem uma URL pública HTTPS; nenhum convite local será enviado por SMTP.');
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

  async function requestMfaRecovery({ email: emailValue, password, companyId: companyValue }) {
    const email = normalizeEmail(emailValue);
    const companyId = validateUuid(companyValue);
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024)
      throw new IdentityError('INVALID_INPUT', 'Credenciais inválidas.');
    const provider = requireEmailProvider(emailProvider);
    const client = await pool.connect();
    let pending = null;
    try {
      pending = await transaction(client, async () => {
        const found = await client.query(`SELECT u.id::text AS user_id,u.email,u.email_verified_at,c.password_phc,
          c.failed_attempts,c.locked_until,c.mfa_required,c.mfa_secret_ref
          FROM rotamoto.users u JOIN rotamoto.credentials c ON c.user_id=u.id
          WHERE lower(u.email)=$1 AND u.disabled_at IS NULL FOR UPDATE OF c`, [email]);
        if (!found.rowCount) { await dummyVerify(password); return null; }
        const account = found.rows[0];
        if (account.locked_until && new Date(account.locked_until) > clock() ||
            !await verifyPassword(account.password_phc, password)) {
          await client.query(`UPDATE rotamoto.credentials SET failed_attempts=least(failed_attempts+1,$2),
            locked_until=CASE WHEN failed_attempts+1 >= $2 THEN now()+interval '15 minutes' ELSE locked_until END,updated_at=now()
            WHERE user_id=$1`, [account.user_id, MAX_FAILED_ATTEMPTS]);
          return null;
        }
        if (!account.email_verified_at || !account.mfa_required || !account.mfa_secret_ref) return null;
        await setTenant(client, companyId);
        const eligible = await client.query(`SELECT 1 FROM rotamoto.memberships m JOIN rotamoto.companies c ON c.id=m.company_id
          JOIN rotamoto.role_permissions rp ON rp.company_id=m.company_id AND rp.role_id=m.role_id
          WHERE m.user_id=$1 AND m.company_id=$2 AND m.status='active' AND c.status='active'
            AND rp.catalog_version=1 AND rp.permission_key='company.manage' LIMIT 1`, [account.user_id, companyId]);
        if (!eligible.rowCount) return null;
        const issued = newToken(), now = clock();
        await client.query(`UPDATE rotamoto.mfa_recovery_challenges SET consumed_at=coalesce(consumed_at,$3)
          WHERE user_id=$1 AND company_id=$2 AND consumed_at IS NULL`, [account.user_id, companyId, now]);
        await client.query(`INSERT INTO rotamoto.mfa_recovery_challenges(id,user_id,company_id,token_digest,expires_at)
          VALUES($1,$2,$3,$4,$5)`, [id(), account.user_id, companyId, issued.digest, new Date(now.getTime()+10*60*1000)]);
        await audit(client, { companyId, actorKind:'system', action:'identity.mfa.recovery_challenge_requested',
          resourceType:'user', resourceId:account.user_id });
        return { userId:account.user_id, to:account.email, token:issued.token,
          expiresAt:new Date(now.getTime()+10*60*1000) };
      });
    } finally { client.release(); }
    if (pending) {
      try { await provider.send({ to:pending.to, kind:'mfa_recovery', token:pending.token, expiresAt:pending.expiresAt }); }
      catch (_) {
        const cleanup = await pool.connect();
        try { await cleanup.query(`UPDATE rotamoto.mfa_recovery_challenges SET consumed_at=now()
          WHERE token_digest=$1 AND consumed_at IS NULL`, [tokenDigest(pending.token)]); }
        finally { cleanup.release(); }
      }
    }
    return { accepted:true };
  }

  async function confirmMfaRecoveryChallenge({ token }) {
    const digest = tokenDigest(token), client = await pool.connect();
    try {
      return await transaction(client, async () => {
        const challenge = await client.query(`SELECT ch.id::text,ch.user_id::text,ch.company_id::text,u.email_verified_at
          FROM rotamoto.mfa_recovery_challenges ch JOIN rotamoto.users u ON u.id=ch.user_id
          WHERE ch.token_digest=$1 AND ch.consumed_at IS NULL AND ch.expires_at>now() AND u.disabled_at IS NULL
          FOR UPDATE OF ch,u`, [digest]);
        if (!challenge.rowCount || !challenge.rows[0].email_verified_at)
          throw new IdentityError('INVALID_TOKEN','Token inválido ou expirado.');
        const row = challenge.rows[0];
        await setTenant(client,row.company_id);
        const expired=await client.query(`UPDATE rotamoto.mfa_recovery_requests SET status='rejected',decided_at=now(),decision_actor_ref='system:expired'
          WHERE company_id=$1 AND user_id=$2 AND status='pending' AND expires_at<=now() RETURNING id::text`,[row.company_id,row.user_id]);
        for(const expiredRequest of expired.rows)await audit(client,{companyId:row.company_id,actorKind:'system',
          action:'identity.mfa.recovery.expired',resourceType:'mfa_recovery_request',resourceId:expiredRequest.id});
        const factor = await client.query(`SELECT mfa_secret_ref,mfa_required FROM rotamoto.credentials
          WHERE user_id=$1 FOR UPDATE`,[row.user_id]);
        if (!factor.rowCount || !factor.rows[0].mfa_required || !factor.rows[0].mfa_secret_ref)
          throw new IdentityError('CONFLICT','A conta não está elegível para recuperação de MFA.');
        let request = await client.query(`SELECT id::text,expires_at FROM rotamoto.mfa_recovery_requests
          WHERE company_id=$1 AND user_id=$2 AND status='pending' AND expires_at>now() FOR UPDATE`,[row.company_id,row.user_id]);
        if (!request.rowCount) request = await client.query(`INSERT INTO rotamoto.mfa_recovery_requests
          (id,company_id,user_id,expires_at,email_verified_at)
          VALUES($1,$2,$3,now()+interval '30 minutes',now()) RETURNING id::text,expires_at`,
        [id(),row.company_id,row.user_id]);
        await client.query('UPDATE rotamoto.mfa_recovery_challenges SET consumed_at=now(),request_id=$2 WHERE id=$1',
          [row.id,request.rows[0].id]);
        await audit(client,{companyId:row.company_id,actorKind:'system',action:'identity.mfa.recovery_requested',
          resourceType:'mfa_recovery_request',resourceId:request.rows[0].id});
        return { accepted:true, requestId:request.rows[0].id, expiresAt:request.rows[0].expires_at };
      });
    } finally { client.release(); }
  }

  async function listMfaRecoveryRequestsForPrincipal(client, principal) {
    const result = await client.query(`SELECT id::text,user_id::text,requested_at,expires_at FROM rotamoto.mfa_recovery_requests
      WHERE company_id=$1 AND status='pending' AND expires_at>now() ORDER BY requested_at`,[principal.company_id]);
    return result.rows.map(row=>({id:row.id,requestedByCurrentUser:row.user_id===principal.user_id,
      requestedAt:row.requested_at,expiresAt:row.expires_at}));
  }

  async function approveMfaRecoveryForPrincipal(client, principal, requestId) {
    const validId = validateUuid(requestId,'INVALID_INPUT');
    const request = await client.query(`SELECT id::text,user_id::text,company_id::text FROM rotamoto.mfa_recovery_requests
      WHERE id=$1 AND company_id=$2 AND status='pending' AND expires_at>now() FOR UPDATE`,[validId,principal.company_id]);
    if (!request.rowCount) throw new IdentityError('NOT_FOUND','Solicitação indisponível ou expirada.');
    const target = request.rows[0];
    if (target.user_id===principal.user_id) throw new IdentityError('FORBIDDEN','Aprovação independente obrigatória.');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('mfa-recovery:' || $1::text, 2323))`,[principal.company_id]);
    const admins = await client.query(`SELECT count(DISTINCT m.user_id)::int AS count FROM rotamoto.memberships m
      JOIN rotamoto.role_permissions rp ON rp.company_id=m.company_id AND rp.role_id=m.role_id
      JOIN rotamoto.users u ON u.id=m.user_id JOIN rotamoto.credentials c ON c.user_id=m.user_id
      WHERE m.company_id=$1 AND m.status='active' AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
        AND c.mfa_required AND c.mfa_secret_ref IS NOT NULL AND rp.catalog_version=1 AND rp.permission_key='company.manage'`,[principal.company_id]);
    if (admins.rows[0].count<2) throw new IdentityError('RECOVERY_LOCAL_OPERATOR_REQUIRED','Recuperação do proprietário único exige procedimento local auditado.');
    const targetAdmin=await client.query(`SELECT 1 FROM rotamoto.memberships m JOIN rotamoto.role_permissions rp
      ON rp.company_id=m.company_id AND rp.role_id=m.role_id WHERE m.user_id=$1 AND m.company_id=$2
        AND m.status='active' AND rp.catalog_version=1 AND rp.permission_key='company.manage' LIMIT 1`,[target.user_id,principal.company_id]);
    if(!targetAdmin.rowCount)throw new IdentityError('CONFLICT','A conta solicitada não é mais administradora ativa.');
    const credential = await client.query(`SELECT mfa_secret_ref FROM rotamoto.credentials WHERE user_id=$1 FOR UPDATE`,[target.user_id]);
    if (!credential.rowCount || !credential.rows[0].mfa_secret_ref) throw new IdentityError('CONFLICT','Fator MFA indisponível.');
    const secretRef=credential.rows[0].mfa_secret_ref,now=clock();
    await client.query(`UPDATE rotamoto.credentials SET mfa_secret_ref=NULL,mfa_required=true,mfa_totp_last_counter=NULL,
      mfa_enrollment_secret_ref=NULL,mfa_enrollment_expires_at=NULL,mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=$2
      WHERE user_id=$1`,[target.user_id,now]);
    await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=$2
      WHERE user_id=$1 AND purpose='mfa_recovery' AND consumed_at IS NULL`,[target.user_id,now]);
    await client.query(`UPDATE rotamoto.sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL`,[target.user_id,now]);
    await client.query(`UPDATE rotamoto.mfa_recovery_requests SET status='approved',decided_at=$2,decided_by_user_id=$3,completed_at=$2
      WHERE id=$1`,[validId,now,principal.user_id]);
    await audit(client,{companyId:principal.company_id,actorUserId:principal.user_id,actorKind:'user',
      action:'identity.mfa.recovery_approved',resourceType:'user',resourceId:target.user_id,
      details:{approval:'independent_mfa_verified_admin'}});
    return {userId:target.user_id,secretRef};
  }

  async function approveSoleOwnerMfaRecoveryLocally(requestId) {
    if (typeof authorizeMfaRecoveryOperator!=='function')
      throw new IdentityError('PROVISIONER_NOT_CONFIGURED','Autorização local de recuperação indisponível.');
    let actorRef;
    try { actorRef=requiredText((await authorizeMfaRecoveryOperator({action:'identity.mfa.recovery.approve',requestId}))?.actorRef,'Operador local',160); }
    catch (_) { throw new IdentityError('PROVISIONER_UNAUTHORIZED','Recuperação local não autorizada.'); }
    const validId=validateUuid(requestId,'INVALID_INPUT'),client=await pool.connect();
    let outcome;
    try {
      outcome=await transaction(client,async()=>{
        await client.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
        const hint=await client.query(`SELECT company_id::text,user_id::text FROM rotamoto.mfa_recovery_challenges
          WHERE request_id=$1 AND consumed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,[validId]);
        if(!hint.rowCount)throw new IdentityError('NOT_FOUND','Solicitação indisponível ou expirada.');
        const {company_id:companyId,user_id:userId}=hint.rows[0];
        await setTenant(client,companyId);
        const candidate=await client.query(`SELECT 1 FROM rotamoto.mfa_recovery_requests
          WHERE id=$1 AND company_id=$2 AND user_id=$3 AND status='pending' AND expires_at>now() FOR UPDATE`,[validId,companyId,userId]);
        if(!candidate.rowCount)throw new IdentityError('NOT_FOUND','Solicitação indisponível ou expirada.');
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('mfa-recovery:' || $1::text, 2323))`,[companyId]);
        const admins=await client.query(`SELECT count(DISTINCT m.user_id)::int AS count,
          (array_agg(DISTINCT m.user_id))[1]::text AS sole_admin_user_id FROM rotamoto.memberships m
          JOIN rotamoto.role_permissions rp ON rp.company_id=m.company_id AND rp.role_id=m.role_id
          JOIN rotamoto.users u ON u.id=m.user_id JOIN rotamoto.credentials c ON c.user_id=m.user_id
          WHERE m.company_id=$1 AND m.status='active' AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
            AND c.mfa_required AND c.mfa_secret_ref IS NOT NULL AND rp.catalog_version=1 AND rp.permission_key='company.manage'`,[companyId]);
        if(admins.rows[0].count!==1||admins.rows[0].sole_admin_user_id!==userId)
          throw new IdentityError('CONFLICT','Recuperação local só é permitida ao único administrador ativo após verificação de email.');
        const factor=await client.query('SELECT mfa_secret_ref FROM rotamoto.credentials WHERE user_id=$1 FOR UPDATE',[userId]);
        if(!factor.rowCount||!factor.rows[0].mfa_secret_ref)throw new IdentityError('CONFLICT','Fator MFA indisponível.');
        const secretRef=factor.rows[0].mfa_secret_ref,now=clock();
        await client.query(`UPDATE rotamoto.credentials SET mfa_secret_ref=NULL,mfa_required=true,mfa_totp_last_counter=NULL,
          mfa_enrollment_secret_ref=NULL,mfa_enrollment_expires_at=NULL,mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=$2 WHERE user_id=$1`,[userId,now]);
        await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=$2 WHERE user_id=$1 AND purpose='mfa_recovery' AND consumed_at IS NULL`,[userId,now]);
        await client.query(`UPDATE rotamoto.sessions SET revoked_at=$2 WHERE user_id=$1 AND revoked_at IS NULL`,[userId,now]);
        await client.query(`UPDATE rotamoto.mfa_recovery_requests SET status='approved',decided_at=$2,decision_actor_ref=$3,completed_at=$2 WHERE id=$1`,[validId,now,actorRef]);
        await audit(client,{companyId,actorKind:'admin_provisioner',action:'identity.mfa.recovery_approved',resourceType:'user',resourceId:userId,
          details:{approval:'local_operator_after_email_and_password_proof'}});
        return {userId,secretRef};
      });
    } finally { client.release(); }
    await finishMfaRecovery(outcome);
    return {completed:true,reenrollmentRequired:true};
  }

  async function finishMfaRecovery(outcome) {
    if (outcome?.secretRef && secretProviderPromise) {
      try { const provider = await requireSecretProvider('remove'); await provider.remove(outcome.secretRef).catch(()=>{}); }
      catch (_) { /* Recovery completion remains safe; provider errors are not logged. */ }
    }
    return { completed:true,reenrollmentRequired:true };
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

  async function changePasswordForPrincipal(client, principal, currentPassword, newPassword) {
    if (typeof currentPassword !== 'string' || !currentPassword || Buffer.byteLength(currentPassword, 'utf8') > 1024 || currentPassword.includes('\0') ||
        typeof newPassword !== 'string' || Buffer.byteLength(newPassword, 'utf8') < 12 ||
        Buffer.byteLength(newPassword, 'utf8') > 1024 || newPassword.includes('\0')) {
      throw new IdentityError('INVALID_INPUT', 'Confira a senha atual e informe uma nova senha com pelo menos 12 caracteres.');
    }
    const result = await client.query(`SELECT password_phc,locked_until FROM rotamoto.credentials
      WHERE user_id=$1 FOR UPDATE`, [principal.user_id]);
    if (!result.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Credencial indisponível.');
    const credential = result.rows[0];
    if (credential.locked_until && new Date(credential.locked_until) > clock()) return { error: 'RATE_LIMITED' };
    if (!await verifyPassword(credential.password_phc, currentPassword)) {
      await client.query(`UPDATE rotamoto.credentials SET failed_attempts=least(failed_attempts+1,$2),
        locked_until=CASE WHEN failed_attempts+1 >= $2 THEN now()+interval '15 minutes' ELSE locked_until END,
        updated_at=now() WHERE user_id=$1`, [principal.user_id, MAX_FAILED_ATTEMPTS]);
      return { error: 'CURRENT_PASSWORD_INVALID' };
    }
    if (await verifyPassword(credential.password_phc, newPassword)) throw new IdentityError('PASSWORD_UNCHANGED', 'Escolha uma senha diferente da atual.');

    // A concurrent password change may have revoked this session while this request
    // waited for the credential row lock. Re-check it before accepting the write.
    const activeSession = await client.query(`SELECT 1 FROM rotamoto.sessions WHERE id=$1 AND user_id=$2
      AND revoked_at IS NULL AND idle_expires_at>now() AND absolute_expires_at>now()`, [principal.session_id, principal.user_id]);
    if (!activeSession.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Sessão inválida ou expirada.');

    const passwordHash = await hashPassword(newPassword);
    const now = clock();
    const updated = await client.query(`UPDATE rotamoto.credentials SET password_phc=$2,password_changed_at=$3,
      failed_attempts=0,locked_until=NULL,updated_at=$3 WHERE user_id=$1 RETURNING user_id`,
    [principal.user_id, passwordHash, now]);
    if (!updated.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Credencial indisponível.');
    await client.query(`UPDATE rotamoto.sessions SET revoked_at=$2
      WHERE user_id=$1 AND id<>$3 AND revoked_at IS NULL`, [principal.user_id, now, principal.session_id]);
    await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
      action: 'identity.password.changed', resourceType: 'user', resourceId: principal.user_id });
    return { changed: true };
  }

  async function startMfaEnrollmentForPrincipal(client, principal, reauthentication = {}) {
    const provider = await requireSecretProvider('put');
    const current = await client.query(`SELECT password_phc,locked_until,mfa_secret_ref,mfa_enrollment_secret_ref,
      mfa_locked_until,mfa_failed_attempts,mfa_totp_last_counter FROM rotamoto.credentials
      WHERE user_id=$1 FOR UPDATE`, [principal.user_id]);
    if (!current.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Credencial indisponível.');
    const credential = current.rows[0];
    if (credential.mfa_secret_ref) {
      if (!principal.mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'Verifique MFA antes de substituir o fator.');
      if (credential.locked_until && new Date(credential.locked_until) > clock()) return { error: 'RATE_LIMITED' };
      if (typeof reauthentication.currentPassword !== 'string' || !reauthentication.currentPassword || reauthentication.currentPassword.includes('\0') ||
          !isValidMfaProof(reauthentication.currentMfaCode))
        return { error: 'MFA_REQUIRED' };
      if (!await verifyPassword(credential.password_phc, reauthentication.currentPassword)) {
        await client.query(`UPDATE rotamoto.credentials SET failed_attempts=least(failed_attempts+1,$2),
          locked_until=CASE WHEN failed_attempts+1 >= $2 THEN now()+interval '15 minutes' ELSE locked_until END,
          updated_at=now() WHERE user_id=$1`, [principal.user_id, MAX_FAILED_ATTEMPTS]);
        return { error: 'CURRENT_PASSWORD_INVALID' };
      }
      if (credential.mfa_locked_until && new Date(credential.mfa_locked_until) > clock()) return { error: 'RATE_LIMITED' };
      let verified = false;
      try { verified = await mfaProvider?.verify?.({ client, userId: principal.user_id,
        code: reauthentication.currentMfaCode, secretRef: credential.mfa_secret_ref }) === true; }
      catch (_) { throw new IdentityError('MFA_PROVIDER_UNAVAILABLE', 'Verificação multifator indisponível.'); }
      if (!verified) {
        await client.query(`UPDATE rotamoto.credentials SET mfa_failed_attempts=least(mfa_failed_attempts+1,10),
          mfa_locked_until=CASE WHEN mfa_failed_attempts+1>=10 THEN now()+interval '15 minutes' ELSE mfa_locked_until END,
          updated_at=now() WHERE user_id=$1`, [principal.user_id]);
        await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
          action: 'identity.mfa.replacement_failed', resourceType: 'user', resourceId: principal.user_id });
        return { error: 'MFA_REQUIRED' };
      }
    }
    const secret = generateSecret();
    const ref = (await provider.put({ name: `identity/mfa/${principal.user_id}`, scope: 'installation', value: secret })).secretRef;
    const oldPending = current.rows[0].mfa_enrollment_secret_ref;
    try {
      await client.query(`UPDATE rotamoto.credentials SET mfa_enrollment_secret_ref=$2,mfa_enrollment_expires_at=now()+interval '10 minutes',
        mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=now() WHERE user_id=$1`, [principal.user_id, ref]);
    } catch (error) { if (typeof provider.remove === 'function') await provider.remove(ref).catch(() => {}); throw error; }
    await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
      action: credential.mfa_secret_ref ? 'identity.mfa.replacement_started' : 'identity.mfa.enrollment_started',
      resourceType: 'user', resourceId: principal.user_id });
    if (oldPending && oldPending !== ref && typeof provider.remove === 'function') await provider.remove(oldPending).catch(() => {});
    const user = await client.query('SELECT email FROM rotamoto.users WHERE id=$1', [principal.user_id]);
    return { secret, otpauthUri: otpauthUri(secret, { account: user.rows[0].email }) };
  }

  async function cancelMfaEnrollmentForPrincipal(client, principal) {
    const result = await client.query(`SELECT mfa_enrollment_secret_ref FROM rotamoto.credentials
      WHERE user_id=$1 FOR UPDATE`, [principal.user_id]);
    if (!result.rowCount) throw new IdentityError('UNAUTHENTICATED', 'Credencial indisponível.');
    const secretRef = result.rows[0].mfa_enrollment_secret_ref;
    if (!secretRef) return { cancelled: false };
    await client.query(`UPDATE rotamoto.credentials SET mfa_enrollment_secret_ref=NULL,
      mfa_enrollment_expires_at=NULL,mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=now()
      WHERE user_id=$1`, [principal.user_id]);
    await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
      action: 'identity.mfa.enrollment_cancelled', resourceType: 'user', resourceId: principal.user_id });
    return { cancelled: true, secretRef };
  }

  async function finishMfaEnrollmentCancellation(outcome) {
    if (outcome?.secretRef && secretProviderPromise) {
      try { const provider = await requireSecretProvider('remove'); await provider.remove(outcome.secretRef).catch(() => {}); }
      catch (_) { /* Database state is authoritative; a stale secret reference is not returned to the user. */ }
    }
    return { cancelled: Boolean(outcome?.cancelled) };
  }

  async function startMfaEnrollment(sessionToken) {
    return withAuthenticatedTenant(sessionToken, startMfaEnrollmentForPrincipal, 'identity.mfa.enroll');
  }

  async function confirmMfaEnrollmentForPrincipal(client, principal, code) {
    const provider = await requireSecretProvider('get');
    const current = await client.query(`SELECT c.mfa_secret_ref,c.mfa_enrollment_secret_ref,c.mfa_enrollment_expires_at,
      c.mfa_totp_last_counter,c.mfa_failed_attempts,c.mfa_locked_until,u.email FROM rotamoto.credentials c
      JOIN rotamoto.users u ON u.id=c.user_id WHERE c.user_id=$1 FOR UPDATE OF c`, [principal.user_id]);
    if (!current.rowCount || !current.rows[0].mfa_enrollment_secret_ref || new Date(current.rows[0].mfa_enrollment_expires_at) <= clock())
      throw new IdentityError('MFA_ENROLLMENT_EXPIRED', 'Enrollment expirado; inicie novamente.');
    if (current.rows[0].mfa_secret_ref && !principal.mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'Verifique MFA antes de substituir o fator.');
    if (current.rows[0].mfa_locked_until && new Date(current.rows[0].mfa_locked_until) > clock()) throw new IdentityError('RATE_LIMITED', 'Muitas tentativas MFA; aguarde antes de tentar novamente.');
    const secret = await provider.get(current.rows[0].mfa_enrollment_secret_ref,
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
    const bootstrapSchema = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_attribute
      WHERE attrelid=to_regclass('rotamoto.provisioning_requests') AND attname='bootstrap_capability_digest' AND NOT attisdropped) AS ready`);
    const pendingBootstrap = bootstrapSchema.rows[0]?.ready ? await client.query(`SELECT p.idempotency_key_digest,p.bootstrap_capability_digest
      FROM rotamoto.provisioning_requests p
      JOIN rotamoto.installation_bootstrap ib ON ib.singleton=true AND ib.request_digest=p.idempotency_key_digest
        AND ib.completed_at IS NULL
      WHERE p.company_id=$1 AND p.user_id=$2 AND p.bootstrap_capability_digest IS NOT NULL
      FOR UPDATE OF p,ib`, [principal.company_id, principal.user_id]) : { rowCount: 0, rows: [] };
    let bootstrapCompleted = false;
    if (pendingBootstrap.rowCount) {
      if (pendingBootstrap.rowCount !== 1) throw new IdentityError('BOOTSTRAP_STATE_INVALID', 'Estado de instalação inconsistente.');
      const pending = pendingBootstrap.rows[0];
      await client.query(`SELECT rotamoto.platform_admin_complete_initial_bootstrap($1,$2,$3,$4)`,
        [principal.user_id, principal.company_id, pending.idempotency_key_digest, pending.bootstrap_capability_digest]);
      const completed = await client.query(`UPDATE rotamoto.installation_bootstrap SET completed_at=$2
        WHERE singleton=true AND completed_at IS NULL AND request_digest=$1 RETURNING completed_at`,
      [pending.idempotency_key_digest, now]);
      if (!completed.rowCount) throw new IdentityError('BOOTSTRAP_STATE_INVALID', 'Não foi possível concluir a instalação.');
      await audit(client, { companyId: principal.company_id, actorUserId: principal.user_id, actorKind: 'user',
        action: 'identity.bootstrap.completed', resourceType: 'company', resourceId: principal.company_id,
        details: { mfa_confirmed: true } });
      bootstrapCompleted = true;
    }
    return { recoveryCodes, oldRef, newRef: current.rows[0].mfa_enrollment_secret_ref, bootstrapCompleted };
  }

  async function finishMfaEnrollment(outcome) {
    if (outcome.invalidCode) throw new IdentityError('MFA_REQUIRED', 'Código MFA inválido.');
    if (outcome.oldRef && outcome.oldRef !== outcome.newRef) {
      const provider = await requireSecretProvider('remove');
      await provider.remove(outcome.oldRef).catch(() => {});
    }
    return { recoveryCodes: outcome.recoveryCodes, bootstrapCompleted: Boolean(outcome.bootstrapCompleted) };
  }

  async function confirmMfaEnrollment(sessionToken, code) {
    const outcome = await withAuthenticatedTenant(sessionToken,
      (client, principal) => confirmMfaEnrollmentForPrincipal(client, principal, code), 'identity.mfa.enroll');
    return finishMfaEnrollment(outcome);
  }

  async function regenerateMfaRecoveryCodesForPrincipal(client, principal) {
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
  }

  async function regenerateMfaRecoveryCodes(sessionToken) {
    const outcome = await withAuthenticatedTenant(sessionToken, regenerateMfaRecoveryCodesForPrincipal, 'company.manage');
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
        let loginOptions = null;
        let companyId;
        if (requestedCompanyId === undefined || requestedCompanyId === null || requestedCompanyId === '') {
          await client.query("SELECT set_config('app.identity_login_user_id',$1,true)", [credential.user_id]);
          const options = await client.query('SELECT * FROM rotamoto.identity_login_company_options($1)', [credential.user_id]);
          if (!options.rowCount) return { error: 'INVALID_CREDENTIALS' };
          loginOptions = options.rows;
          companyId = loginOptions[0].company_id;
        } else companyId = validateUuid(requestedCompanyId);
        await setTenant(client, companyId);
        const membership = await client.query(`SELECT m.company_id::text,m.role_id::text FROM rotamoto.memberships m
          JOIN rotamoto.companies c ON c.id=m.company_id WHERE m.user_id=$1 AND m.company_id=$2
          AND m.status='active' AND c.status='active'`, [credential.user_id, companyId]);
        if (!membership.rowCount) return { error: 'INVALID_CREDENTIALS' };
        const sensitive = await client.query(`SELECT EXISTS (SELECT 1 FROM rotamoto.role_permissions
          WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 AND permission_key=ANY($3::text[])) AS required`,
        [companyId, membership.rows[0].role_id, MFA_PERMISSIONS]);
        const mfaRequired = reset.rows[0].mfa_required || sensitive.rows[0].required ||
          Boolean(loginOptions?.some(option => option.requires_mfa));
        let mfaVerified = false;
        if (mfaRequired) {
          if (!credential.mfa_secret_ref) {
            await client.query('UPDATE rotamoto.credentials SET mfa_required=true,updated_at=now() WHERE user_id=$1', [credential.user_id]);
            return { session: await createSession(client, credential.user_id, membership.rows[0].company_id, false), enrollmentRequired: true,
              loginOptions };
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
        return { session: await createSession(client, credential.user_id, membership.rows[0].company_id, mfaVerified), loginOptions };
      });
      if (result?.error) {
        const messages = { INVALID_CREDENTIALS: 'Email ou senha inválidos.', MFA_REQUIRED: 'A autenticação multifator desta conta ainda não está configurada.' };
        throw new IdentityError(result.error, messages[result.error]);
      }
      if (result?.session) return { ...result.session, mfaEnrollmentRequired: result.enrollmentRequired,
        ...(!result.enrollmentRequired && result.loginOptions ? { loginCompanies: result.loginOptions.map(option => ({ companyId: option.company_id, name: option.company_name })),
          platformAdmin: Boolean(result.loginOptions[0]?.platform_admin) } : {}) };
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
    const scope = await client.query(`SELECT set_config('app.tenant_id',active_company_id::text,true) AS company_id
      FROM rotamoto.sessions
      WHERE token_digest=$1 AND revoked_at IS NULL AND idle_expires_at>$2 AND absolute_expires_at>$2`, [digest, now]);
    if (!scope.rowCount) return null;
    const result = await client.query(`UPDATE rotamoto.sessions s SET last_seen_at=$2,
      idle_expires_at=least(s.absolute_expires_at,$2 + interval '30 minutes')
      FROM rotamoto.users u,rotamoto.memberships m,rotamoto.companies c,rotamoto.credentials cred
      WHERE s.token_digest=$1 AND s.user_id=u.id AND s.active_company_id=m.company_id AND m.user_id=s.user_id
        AND m.company_id=c.id AND s.revoked_at IS NULL AND s.idle_expires_at>$2 AND s.absolute_expires_at>$2
        AND u.disabled_at IS NULL AND m.status='active' AND c.status='active' AND cred.user_id=s.user_id
      RETURNING s.id::text AS session_id,s.user_id::text,s.active_company_id::text AS company_id,m.role_id::text,
        m.driver_id::text AS driver_id,c.name AS company_name,c.time_zone AS company_time_zone,s.mfa_verified_at,cred.mfa_required,cred.mfa_secret_ref IS NOT NULL AS mfa_configured,
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

  async function listCompaniesForSession(sessionToken) {
    return withAuthenticatedTenant(sessionToken, async client => {
      const rows = await client.query(`SELECT company_id,company_name,membership_status,company_status,is_active,can_switch
        FROM rotamoto.identity_company_options($1)`, [tokenDigest(sessionToken)]);
      return rows.rows.map(row => ({ companyId: row.company_id, name: row.company_name,
        membershipStatus: row.membership_status, companyStatus: row.company_status,
        isActive: Boolean(row.is_active), canSwitch: Boolean(row.can_switch) }));
    });
  }

  async function revokeSession(sessionToken, transactionClient = null) {
    let digest;
    try { digest = tokenDigest(sessionToken); } catch (_) { return false; }
    if (transactionClient) {
      const result = await transactionClient.query(`UPDATE rotamoto.sessions SET revoked_at=now()
        WHERE token_digest=$1 AND revoked_at IS NULL RETURNING id`, [digest]);
      return result.rowCount === 1;
    }
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
        const sensitiveRole = await client.query(`SELECT EXISTS (
            SELECT 1 FROM rotamoto.role_permissions
            WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 AND permission_key=ANY($3::text[])
          ) AS required`, [principal.company_id, principal.role_id, MFA_PERMISSIONS]);
        const mfaPending = Boolean(principal.mfa_required || principal.mfa_enrollment_required || sensitiveRole.rows[0]?.required) && !principal.mfa_verified_at;
        const preMfaOperation = ['identity.session', 'identity.mfa.enroll', 'identity.logout'].includes(permissionKey);
        if (mfaPending && !preMfaOperation)
          throw new IdentityError('MFA_REQUIRED', 'Configure e confirme MFA antes de usar a conta.');
        if (permissionKey) {
          const permission = requiredText(permissionKey, 'Permissão', 120);
          if (permission === 'identity.mfa.enroll' || permission === 'identity.session' || permission === 'identity.logout')
            return operation(client, principal);
          const permissions = await client.query(`SELECT
              coalesce(bool_or(rp.permission_key=$3),false) AS allowed,
              coalesce(bool_or(rp.permission_key='company.manage'),false) AS company_manage
            FROM rotamoto.role_permissions rp
            WHERE rp.company_id=$1 AND rp.role_id=$2 AND rp.permission_key=ANY($4::text[])
              AND rp.catalog_version=1`,
          [principal.company_id, principal.role_id, permission, [permission, 'company.manage']]);
          if (!permissions.rows[0]?.allowed) throw new IdentityError('FORBIDDEN', 'Operação não autorizada.');
          Object.defineProperty(principal, 'company_manage', { value: permissions.rows[0].company_manage });
          if (MFA_PERMISSIONS.includes(permission) && !principal.mfa_verified_at) throw new IdentityError('MFA_REQUIRED', 'Esta operação exige MFA verificado.');
        }
        return operation(client, principal);
      });
    } finally { client.release(); }
  }

  return Object.freeze({ authorizeProvisionerRequest, provisionInitialOwner, getBootstrapStatus, consumeOwnerInvitation, inviteMembershipWithSession, consumeMembershipInvitation,
    acceptExistingMembershipInvitation, requestPasswordRecovery, requestMfaRecovery, confirmMfaRecoveryChallenge,
    listMfaRecoveryRequestsForPrincipal, approveMfaRecoveryForPrincipal, approveSoleOwnerMfaRecoveryLocally, finishMfaRecovery,
    consumePasswordRecovery, changePasswordForPrincipal, authenticate, startMfaEnrollment, startMfaEnrollmentForPrincipal,
    cancelMfaEnrollmentForPrincipal, finishMfaEnrollmentCancellation,
    confirmMfaEnrollment, confirmMfaEnrollmentForPrincipal, finishMfaEnrollment,
    regenerateMfaRecoveryCodes, regenerateMfaRecoveryCodesForPrincipal,
    resolveSession, verifyCsrf, renewCsrfToken, switchActiveCompany, listCompaniesForSession, revokeSession, withAuthenticatedTenant });
}

module.exports = { createIdentityService, IdentityError, normalizeEmail, tokenDigest, uuidV7: id,
  SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, INVITATION_TTL_MS, RECOVERY_TTL_MS };
