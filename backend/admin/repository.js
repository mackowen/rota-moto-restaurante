'use strict';

const crypto = require('node:crypto');
const { publicCatalog } = require('../integrations/registry');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function invalid() { const error = new Error('cursor inválido.'); error.code = 'INVALID_INPUT'; throw error; }
function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) invalid();
  let value;
  try { value = Buffer.from(cursor, 'base64url').toString('utf8').split('\n'); } catch (_) { invalid(); }
  if (value.length !== 2 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(value[0]) || !UUID.test(value[1]) ||
      !Number.isFinite(Date.parse(value[0])) || new Date(value[0]).toISOString().slice(0, 19) !== value[0].slice(0, 19)) invalid();
  return { createdAt: value[0], id: value[1].toLowerCase() };
}
function encodeCursor(row) { return Buffer.from(`${row.created_at_cursor}\n${row.id}`).toString('base64url'); }

function createAdminRepository() {
  async function permissions(client) {
    const result = await client.query(`SELECT permission_key AS key,description FROM rotamoto.permissions
      WHERE catalog_version=1 ORDER BY permission_key`);
    return { permissions: result.rows };
  }
  async function actorPermissions(client, companyId, roleId) {
    const result = await client.query(`SELECT permission_key FROM rotamoto.role_permissions
      WHERE company_id=$1 AND role_id=$2 AND catalog_version=1`, [companyId, roleId]);
    return new Set(result.rows.map(row => row.permission_key));
  }
  function assertGrantable(requested, actor) {
    if (!Array.isArray(requested) || requested.length > 128 || requested.some(value => typeof value !== 'string') ||
        new Set(requested).size !== requested.length || requested.some(value => !actor.has(value))) {
      const error = new Error('Permissões inválidas ou acima do nível do solicitante.'); error.code = 'FORBIDDEN'; throw error;
    }
  }
  async function writeAudit(client, principal, action, type, resourceId, details = {}) {
    await client.query(`INSERT INTO rotamoto.audit_log
      (id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
      VALUES ($1,$2,$3,'user',$4,$5,$6,$7::jsonb)`,
    [crypto.randomUUID(), principal.company_id, principal.user_id, action, type, resourceId, JSON.stringify(details)]);
  }
  async function createRole(client, principal, input) {
    const allowed = await actorPermissions(client, principal.company_id, principal.role_id);
    assertGrantable(input.permissions, allowed);
    if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(input.key) || ['owner', 'admin'].includes(input.key)) {
      const error = new Error('Identificador de perfil inválido ou reservado.'); error.code = 'INVALID_INPUT'; throw error;
    }
    const id = crypto.randomUUID();
    await client.query(`INSERT INTO rotamoto.roles(id,company_id,role_key,display_name)
      VALUES ($1,$2,$3,$4)`, [id, principal.company_id, input.key, input.name]);
    if (input.permissions.length) await client.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
      SELECT $1,$2,p.permission_key,1 FROM rotamoto.permissions p
      WHERE p.catalog_version=1 AND p.permission_key=ANY($3::text[])`, [principal.company_id, id, input.permissions]);
    const count = await client.query(`SELECT count(*)::int AS count FROM rotamoto.role_permissions
      WHERE company_id=$1 AND role_id=$2`, [principal.company_id, id]);
    if (count.rows[0].count !== input.permissions.length) {
      const error = new Error('Catálogo de permissões inválido.'); error.code = 'INVALID_INPUT'; throw error;
    }
    await writeAudit(client, principal, 'role.created', 'role', id, { permissionCount: input.permissions.length });
    return { id, key: input.key, name: input.name, permissions: input.permissions };
  }
  async function updateRole(client, principal, roleId, input) {
    const actor = await actorPermissions(client, principal.company_id, principal.role_id);
    assertGrantable(input.permissions, actor);
    const current = await client.query(`SELECT role_key,is_system_template FROM rotamoto.roles
      WHERE company_id=$1 AND id=$2 FOR UPDATE`, [principal.company_id, roleId]);
    if (!current.rowCount) { const error = new Error('Perfil não encontrado.'); error.code = 'NOT_FOUND'; throw error; }
    if (current.rows[0].role_key === 'owner' || current.rows[0].is_system_template) {
      const error = new Error('Perfil de sistema não pode ser alterado.'); error.code = 'FORBIDDEN'; throw error;
    }
    const actorUsesRole = await client.query(`SELECT 1 FROM rotamoto.memberships
      WHERE company_id=$1 AND user_id=$2 AND role_id=$3 AND status='active'`,
    [principal.company_id, principal.user_id, roleId]);
    if (actorUsesRole.rowCount) { const error = new Error('Não é permitido editar o perfil atualmente associado ao solicitante.'); error.code = 'FORBIDDEN'; throw error; }
    await client.query(`UPDATE rotamoto.roles SET display_name=$3,updated_at=now() WHERE company_id=$1 AND id=$2`,
      [principal.company_id, roleId, input.name]);
    await client.query(`DELETE FROM rotamoto.role_permissions WHERE company_id=$1 AND role_id=$2`, [principal.company_id, roleId]);
    if (input.permissions.length) await client.query(`INSERT INTO rotamoto.role_permissions(company_id,role_id,permission_key,catalog_version)
      SELECT $1,$2,p.permission_key,1 FROM rotamoto.permissions p
      WHERE p.catalog_version=1 AND p.permission_key=ANY($3::text[])`, [principal.company_id, roleId, input.permissions]);
    const count = await client.query(`SELECT count(*)::int AS count FROM rotamoto.role_permissions
      WHERE company_id=$1 AND role_id=$2`, [principal.company_id, roleId]);
    if (count.rows[0].count !== input.permissions.length) {
      const error = new Error('Catálogo de permissões inválido.'); error.code = 'INVALID_INPUT'; throw error;
    }
    if (input.permissions.some(permission => ['company.manage', 'members.invite', 'integrations.manage'].includes(permission))) {
      await client.query(`UPDATE rotamoto.credentials c SET mfa_required=true,updated_at=now()
        FROM rotamoto.memberships m WHERE m.company_id=$1 AND m.role_id=$2 AND m.user_id=c.user_id`,
      [principal.company_id, roleId]);
      await client.query(`UPDATE rotamoto.sessions s SET revoked_at=now() WHERE s.active_company_id=$1 AND s.user_id IN
        (SELECT user_id FROM rotamoto.memberships WHERE company_id=$1 AND role_id=$2) AND s.revoked_at IS NULL`,
      [principal.company_id, roleId]);
    }
    await writeAudit(client, principal, 'role.permissions_changed', 'role', roleId, { permissionCount: input.permissions.length });
    return { id: roleId, permissions: input.permissions };
  }
  async function updateMembership(client, principal, membershipId, input) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, [principal.company_id]);
    const current = await client.query(`SELECT m.id::text,m.user_id::text,m.role_id::text,m.status,r.role_key,
        u.disabled_at,u.email_verified_at,c.password_phc,c.mfa_required
      FROM rotamoto.memberships m JOIN rotamoto.roles r ON r.id=m.role_id AND r.company_id=m.company_id
      JOIN rotamoto.users u ON u.id=m.user_id LEFT JOIN rotamoto.credentials c ON c.user_id=u.id
      WHERE m.company_id=$1 AND m.id=$2 FOR UPDATE OF m`, [principal.company_id, membershipId]);
    if (!current.rowCount) { const error = new Error('Associação não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const row = current.rows[0];
    if (row.user_id === principal.user_id) {
      const error = new Error('Não é permitido alterar a própria associação.'); error.code = 'FORBIDDEN'; throw error;
    }
    let nextRoleId = row.role_id;
    let nextRoleKey = row.role_key;
    let nextPermissions = await actorPermissions(client, principal.company_id, row.role_id);
    let nextStatus = row.status;
    if (input.roleId) {
      const actor = await actorPermissions(client, principal.company_id, principal.role_id);
      const target = await client.query(`SELECT id::text,role_key FROM rotamoto.roles WHERE company_id=$1 AND id=$2`,
        [principal.company_id, input.roleId]);
      if (!target.rowCount) { const error = new Error('Perfil não encontrado.'); error.code = 'NOT_FOUND'; throw error; }
      const grantable = await actorPermissions(client, principal.company_id, target.rows[0].id);
      if ([...grantable].some(permission => !actor.has(permission))) {
        const error = new Error('O solicitante não pode atribuir um nível superior ao próprio.'); error.code = 'FORBIDDEN'; throw error;
      }
      nextRoleId = target.rows[0].id;
      nextRoleKey = target.rows[0].role_key;
      nextPermissions = grantable;
    }
    if (input.status) {
      if (!['active', 'suspended', 'revoked'].includes(input.status) || row.status === 'invited' && input.status === 'active' ||
          row.status === 'revoked' && input.status !== 'revoked') {
        const error = new Error('Transição de associação inválida.'); error.code = 'INVALID_STATE_TRANSITION'; throw error;
      }
      if (input.status === 'active' && (row.disabled_at || !row.password_phc || !row.email_verified_at)) {
        const error = new Error('A conta ainda não pode ser ativada.'); error.code = 'INVALID_STATE_TRANSITION'; throw error;
      }
      nextStatus = input.status;
    }
    const nextIsOwner = nextStatus === 'active' && nextRoleKey === 'owner' && !row.disabled_at &&
      Boolean(row.email_verified_at) && Boolean(row.password_phc) && row.mfa_required === false;
    if (row.status === 'active' && row.role_key === 'owner' && !nextIsOwner) {
      const owners = await client.query(`SELECT count(*)::int AS count FROM rotamoto.memberships m
        JOIN rotamoto.roles r ON r.id=m.role_id AND r.company_id=m.company_id
        JOIN rotamoto.users u ON u.id=m.user_id JOIN rotamoto.credentials c ON c.user_id=u.id
        WHERE m.company_id=$1 AND m.status='active' AND r.role_key='owner' AND u.disabled_at IS NULL
          AND u.email_verified_at IS NOT NULL AND c.mfa_required=false`, [principal.company_id]);
      if (owners.rows[0].count <= 1) { const error = new Error('A empresa precisa manter ao menos um owner ativo.'); error.code = 'LAST_OWNER_REQUIRED'; throw error; }
    }
    await client.query(`UPDATE rotamoto.memberships SET role_id=$3,status=$4,updated_at=now(),
      activated_at=CASE WHEN $4='active' THEN coalesce(activated_at,now()) ELSE activated_at END
      WHERE company_id=$1 AND id=$2`, [principal.company_id, membershipId, nextRoleId, nextStatus]);
    const mfaRequired = ['company.manage', 'members.invite', 'integrations.manage'].some(permission => nextPermissions.has(permission));
    if (mfaRequired) await client.query(`UPDATE rotamoto.credentials SET mfa_required=true,updated_at=now() WHERE user_id=$1`, [row.user_id]);
    await client.query(`UPDATE rotamoto.sessions SET revoked_at=now() WHERE active_company_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [principal.company_id, row.user_id]);
    await writeAudit(client, principal, 'membership.changed', 'membership', membershipId,
      { roleChanged: Boolean(input.roleId), status: nextStatus });
    return { membershipId, roleId: nextRoleId, status: nextStatus };
  }
  async function associateMembershipDriver(client, principal, membershipId, driverId) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [principal.company_id]);
    const member = await client.query(`SELECT m.id::text,m.driver_id::text,m.status,u.disabled_at,u.email_verified_at,
        EXISTS (SELECT 1 FROM rotamoto.role_permissions rp WHERE rp.company_id=m.company_id AND rp.role_id=m.role_id
          AND rp.catalog_version=1 AND rp.permission_key='sync.pull') AND
        EXISTS (SELECT 1 FROM rotamoto.role_permissions rp WHERE rp.company_id=m.company_id AND rp.role_id=m.role_id
          AND rp.catalog_version=1 AND rp.permission_key='sync.push') AS sync_permissions
      FROM rotamoto.memberships m JOIN rotamoto.users u ON u.id=m.user_id
      WHERE m.company_id=$1 AND m.id=$2 FOR UPDATE OF m`, [principal.company_id, membershipId]);
    if (!member.rowCount) { const error = new Error('Associação não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const row = member.rows[0];
    if (row.status !== 'active' || row.disabled_at || !row.email_verified_at || !row.sync_permissions) {
      const error = new Error('A associação precisa estar ativa e autorizada para sincronização Motoboy.'); error.code = 'DRIVER_MEMBERSHIP_INELIGIBLE'; throw error;
    }
    const driver = await client.query(`SELECT 1 FROM rotamoto.domain_records
      WHERE company_id=$1 AND record_id=$2::uuid AND entity_type='Driver' AND deleted_at IS NULL FOR UPDATE`,
    [principal.company_id, driverId]);
    if (!driver.rowCount) { const error = new Error('Motorista canônico não encontrado.'); error.code = 'DRIVER_NOT_FOUND'; throw error; }
    if (row.driver_id === driverId) return { membershipId, driverId, changed: false };
    if (row.driver_id) { const error = new Error('Remova o vínculo atual antes de associar outro motorista.'); error.code = 'MEMBERSHIP_DRIVER_CONFLICT'; throw error; }
    try {
      await client.query(`UPDATE rotamoto.memberships SET driver_id=$3,updated_at=now()
        WHERE company_id=$1 AND id=$2`, [principal.company_id, membershipId, driverId]);
    } catch (cause) {
      if (cause.code === '23505') { const error = new Error('Este motorista já está vinculado a outra associação.'); error.code = 'DRIVER_ALREADY_LINKED'; throw error; }
      if (cause.code === '23503') { const error = new Error('Motorista canônico não encontrado nesta empresa.'); error.code = 'DRIVER_NOT_FOUND'; throw error; }
      throw cause;
    }
    await writeAudit(client, principal, 'membership.driver.linked', 'membership', membershipId, { driverId });
    return { membershipId, driverId, changed: true };
  }
  async function disassociateMembershipDriver(client, principal, membershipId) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [principal.company_id]);
    const member = await client.query(`SELECT id::text,driver_id::text FROM rotamoto.memberships
      WHERE company_id=$1 AND id=$2 FOR UPDATE`, [principal.company_id, membershipId]);
    if (!member.rowCount) { const error = new Error('Associação não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const driverId = member.rows[0].driver_id;
    if (!driverId) return { membershipId, driverId: null, changed: false };
    await client.query('UPDATE rotamoto.memberships SET driver_id=NULL,updated_at=now() WHERE company_id=$1 AND id=$2',
      [principal.company_id, membershipId]);
    await writeAudit(client, principal, 'membership.driver.unlinked', 'membership', membershipId, { driverId });
    return { membershipId, driverId: null, previousDriverId: driverId, changed: true };
  }
  async function company(client, companyId) {
    const result = await client.query(`SELECT id::text,name,status,created_at,updated_at
      FROM rotamoto.companies WHERE id=$1`, [companyId]);
    if (!result.rowCount) { const error = new Error('Empresa não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const row = result.rows[0];
    return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async function memberships(client, companyId, { limit, cursor }) {
    const after = decodeCursor(cursor);
    const params = [companyId];
    let keyset = '';
    if (after) {
      params.push(after.createdAt, after.id);
      keyset = `AND (m.created_at < $2::timestamptz OR (m.created_at=$2::timestamptz AND m.id > $3::uuid))`;
    }
    params.push(limit + 1);
    const result = await client.query(`SELECT m.id::text,m.user_id::text,m.driver_id::text,u.email,u.email_verified_at IS NOT NULL AS email_verified,
        u.disabled_at,m.status,m.role_id::text,r.role_key,r.display_name,m.created_at,m.activated_at,
        to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
        coalesce((SELECT jsonb_agg(rp.permission_key ORDER BY rp.permission_key)
          FROM rotamoto.role_permissions rp WHERE rp.company_id=m.company_id AND rp.role_id=m.role_id),'[]'::jsonb) AS permissions
      FROM rotamoto.memberships m JOIN rotamoto.users u ON u.id=m.user_id
      JOIN rotamoto.roles r ON r.id=m.role_id AND r.company_id=m.company_id
      WHERE m.company_id=$1 ${keyset} ORDER BY m.created_at DESC,m.id ASC LIMIT $${params.length}`, params);
    const hasMore = result.rowCount > limit;
    const rows = result.rows.slice(0, limit);
    return { members: rows.map(row => ({ membershipId: row.id, userId: row.user_id, email: row.email,
      emailVerified: row.email_verified, disabled: Boolean(row.disabled_at), status: row.status, roleId: row.role_id,
      roleKey: row.role_key, roleName: row.display_name, permissions: row.permissions, driverId: row.driver_id,
      createdAt: row.created_at, activatedAt: row.activated_at })),
      nextCursor: hasMore && rows.length ? encodeCursor(rows.at(-1)) : null, hasMore };
  }
  async function roles(client, companyId) {
    const result = await client.query(`SELECT r.id::text,r.role_key,r.display_name,r.is_system_template,r.created_at,r.updated_at,
        coalesce(jsonb_agg(rp.permission_key ORDER BY rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL),'[]'::jsonb) AS permissions
      FROM rotamoto.roles r LEFT JOIN rotamoto.role_permissions rp ON rp.company_id=r.company_id AND rp.role_id=r.id
      WHERE r.company_id=$1 GROUP BY r.id ORDER BY r.role_key`, [companyId]);
    return { roles: result.rows.map(row => ({ id: row.id, key: row.role_key, name: row.display_name,
      systemTemplate: row.is_system_template, permissions: row.permissions,
      createdAt: row.created_at, updatedAt: row.updated_at })) };
  }
  async function integrations(client, companyId) {
    const result = await client.query(`SELECT i.id::text,i.provider,i.status,i.created_at,i.updated_at,
        ea.display_name,ea.link_status,ea.confirmed_at
      FROM rotamoto.integrations i LEFT JOIN rotamoto.external_accounts ea
        ON ea.company_id=i.company_id AND ea.integration_id=i.id
      WHERE i.company_id=$1 ORDER BY i.provider,ea.created_at,ea.id`, [companyId]);
    const persisted = result.rows.map(row => ({ provider: row.provider, status: row.status,
      externalAccount: row.display_name === null ? null : { displayName: row.display_name,
        linkStatus: row.link_status, confirmedAt: row.confirmed_at },
      createdAt: row.created_at, updatedAt: row.updated_at }));
    return { integrations: publicCatalog(persisted) };
  }
  return Object.freeze({ company, memberships, roles, integrations, permissions, createRole, updateRole, updateMembership,
    associateMembershipDriver, disassociateMembershipDriver });
}

module.exports = { createAdminRepository, decodeCursor, encodeCursor };
