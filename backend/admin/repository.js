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
    const result = await client.query(`SELECT id::text,name,status,time_zone,support_phone,operational_address,operational_latitude,
        operational_longitude,operational_location_provenance,operational_location_version,company_settings_version,route_grouping_policy,created_at,updated_at
      FROM rotamoto.companies WHERE id=$1`, [companyId]);
    if (!result.rowCount) { const error = new Error('Empresa não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const row = result.rows[0];
    return { id: row.id, name: row.name, status: row.status, timeZone: row.time_zone, supportPhone: row.support_phone,
      operationalLocation: row.operational_latitude == null ? null : { address: row.operational_address,
        latitude: Number(row.operational_latitude), longitude: Number(row.operational_longitude),
        provenance: row.operational_location_provenance, version: Number(row.operational_location_version) },
      operationalLocationVersion: Number(row.operational_location_version), settingsVersion: Number(row.company_settings_version),
      routeGroupingPolicy: row.route_grouping_policy, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async function updateCompanyTimeZone(client, principal, timeZone) {
    const current = await client.query(`SELECT time_zone FROM rotamoto.companies WHERE id=$1 FOR UPDATE`, [principal.company_id]);
    if (!current.rowCount) { const error = new Error('Empresa não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const previous = current.rows[0].time_zone;
    const updated = await client.query(`UPDATE rotamoto.companies SET time_zone=$2,company_settings_version=company_settings_version+1,updated_at=now()
      WHERE id=$1 RETURNING time_zone,updated_at`, [principal.company_id, timeZone]);
    await writeAudit(client, principal, 'company.time_zone.changed', 'company', principal.company_id,
      { previousTimeZone: previous, timeZone: updated.rows[0].time_zone });
    return { timeZone: updated.rows[0].time_zone, updatedAt: updated.rows[0].updated_at };
  }
  async function updateCompanyLocation(client, principal, input) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 ||
        (input.latitude == null) !== (input.longitude == null) ||
        input.latitude != null && (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90 ||
          !Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180)) {
      const error = new Error('Localização inválida.'); error.code = 'INVALID_INPUT'; throw error;
    }
    const current = await client.query(`SELECT operational_location_version FROM rotamoto.companies WHERE id=$1 FOR UPDATE`, [principal.company_id]);
    if (!current.rowCount) { const error = new Error('Empresa não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    if (Number(current.rows[0].operational_location_version) !== input.expectedVersion) {
      const error = new Error('A localização mudou em outra sessão.'); error.code = 'REVISION_CONFLICT'; throw error;
    }
    const updated = await client.query(`UPDATE rotamoto.companies SET operational_address=$2,operational_latitude=$3,
      operational_longitude=$4,operational_location_provenance=CASE WHEN $3::double precision IS NULL THEN NULL ELSE 'operator_confirmed' END,
      operational_location_version=operational_location_version+1,company_settings_version=company_settings_version+1,updated_at=now()
      WHERE id=$1 AND operational_location_version=$5
      RETURNING operational_location_version,operational_address,operational_latitude,operational_longitude,operational_location_provenance`,
    [principal.company_id, input.address, input.latitude, input.longitude, input.expectedVersion]);
    if (!updated.rowCount) { const error = new Error('A localização mudou em outra sessão.'); error.code = 'REVISION_CONFLICT'; throw error; }
    const row = updated.rows[0];
    await writeAudit(client, principal, 'company.operational_location.changed', 'company', principal.company_id,
      { configured: row.operational_latitude !== null, provenance: row.operational_location_provenance,
        version: Number(row.operational_location_version) });
    return { operationalLocation: row.operational_latitude == null ? null : { address: row.operational_address,
      latitude: Number(row.operational_latitude), longitude: Number(row.operational_longitude),
      provenance: row.operational_location_provenance, version: Number(row.operational_location_version) },
      operationalLocationVersion: Number(row.operational_location_version) };
  }
  async function updateCompanyProfile(client, principal, input) {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || typeof input.name !== 'string' ||
        input.name.trim().length < 1 || Buffer.byteLength(input.name.trim(), 'utf8') > 160 ||
        /[\u0000-\u001f\u007f]/u.test(input.name) || input.supportPhone !== null &&
        (typeof input.supportPhone !== 'string' || input.supportPhone.trim().length < 1 || Buffer.byteLength(input.supportPhone.trim(), 'utf8') > 40 || /[\u0000-\u001f\u007f]/u.test(input.supportPhone))) {
      const error = new Error('Dados de identidade inválidos.'); error.code = 'INVALID_INPUT'; throw error;
    }
    const updated = await client.query(`UPDATE rotamoto.companies SET name=$2,support_phone=$3,
        company_settings_version=company_settings_version+1,updated_at=now()
      WHERE id=$1 AND company_settings_version=$4
      RETURNING name,support_phone,company_settings_version`,
    [principal.company_id,input.name.trim(),input.supportPhone?.trim()||null,input.expectedVersion]);
    if (!updated.rowCount) {
      const exists = await client.query('SELECT 1 FROM rotamoto.companies WHERE id=$1',[principal.company_id]);
      const error = new Error(exists.rowCount?'A identidade da empresa mudou em outra sessão.':'Empresa não encontrada.');
      error.code = exists.rowCount?'REVISION_CONFLICT':'NOT_FOUND'; throw error;
    }
    await writeAudit(client,principal,'company.profile.changed','company',principal.company_id,{version:Number(updated.rows[0].company_settings_version)});
    return { name:updated.rows[0].name,supportPhone:updated.rows[0].support_phone,settingsVersion:Number(updated.rows[0].company_settings_version) };
  }
  async function updateCompanyRouteGrouping(client, principal, input) {
    const updated = await client.query(`UPDATE rotamoto.companies SET route_grouping_policy=$2,
        company_settings_version=company_settings_version+1,updated_at=now()
      WHERE id=$1 AND company_settings_version=$3
      RETURNING route_grouping_policy,company_settings_version`,
    [principal.company_id,input.policy,input.expectedVersion]);
    if (!updated.rowCount) {
      const exists = await client.query('SELECT 1 FROM rotamoto.companies WHERE id=$1',[principal.company_id]);
      const error = new Error(exists.rowCount?'A configuração mudou em outra sessão.':'Empresa não encontrada.');
      error.code = exists.rowCount?'REVISION_CONFLICT':'NOT_FOUND'; throw error;
    }
    await writeAudit(client,principal,'company.route_grouping.changed','company',principal.company_id,
      { policy:updated.rows[0].route_grouping_policy,version:Number(updated.rows[0].company_settings_version) });
    return { routeGroupingPolicy:updated.rows[0].route_grouping_policy,settingsVersion:Number(updated.rows[0].company_settings_version) };
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
        ea.id::text AS external_account_key,ea.external_account_id,ea.display_name,ea.link_status,ea.confirmed_at,
        ea.account_status,ea.last_sync_at,ea.last_error_code,ea.token_expires_at
      FROM rotamoto.integrations i LEFT JOIN rotamoto.external_accounts ea
        ON ea.company_id=i.company_id AND ea.integration_id=i.id
      WHERE i.company_id=$1 ORDER BY i.provider,ea.created_at,ea.id`, [companyId]);
    const persisted = result.rows.map(row => ({ provider: row.provider, status: row.status,
      externalAccount: row.external_account_key === null ? null : { id:row.external_account_key,externalId:row.external_account_id,
        displayName: row.display_name,linkStatus: row.link_status,accountStatus:row.account_status,
        tokenExpiresAt:row.token_expires_at,lastSyncAt:row.last_sync_at,lastErrorCode:row.last_error_code,confirmedAt: row.confirmed_at },
      createdAt: row.created_at, updatedAt: row.updated_at }));
    return { integrations: publicCatalog(persisted) };
  }
  async function disableIntegrationAccount(client,companyId,provider,accountId){
    if(!['ifood','keeta','99food'].includes(provider))throw Object.assign(new Error('Unsupported provider.'),{code:'INVALID_INPUT'});
    const result=await client.query(`UPDATE rotamoto.external_accounts ea SET account_status='disabled',last_error_code=NULL,updated_at=now()
      FROM rotamoto.integrations i WHERE ea.company_id=$1 AND ea.id=$2 AND ea.integration_id=i.id AND i.company_id=ea.company_id AND i.provider=$3
      RETURNING ea.id::text,ea.account_status,ea.last_sync_at`,[companyId,accountId,provider]);
    if(!result.rowCount)throw Object.assign(new Error('Marketplace account not found.'),{code:'NOT_FOUND'});
    await client.query(`UPDATE rotamoto.marketplace_command_outbox SET status='needs_review',lease_token=NULL,lease_until=NULL,
      completed_at=now(),last_error_code='ACCOUNT_DISABLED',updated_at=now() WHERE company_id=$1 AND external_account_id=$2
        AND status IN ('queued','leased','pending','unknown_outcome')`,[companyId,accountId]);
    return {account:{id:result.rows[0].id,status:result.rows[0].account_status,lastSyncAt:result.rows[0].last_sync_at}};
  }
  return Object.freeze({ company, memberships, roles, integrations, disableIntegrationAccount, permissions, createRole, updateRole, updateMembership,
    updateCompanyTimeZone, updateCompanyLocation, updateCompanyProfile, updateCompanyRouteGrouping, associateMembershipDriver, disassociateMembershipDriver });
}

module.exports = { createAdminRepository, decodeCursor, encodeCursor };
