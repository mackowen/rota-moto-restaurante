'use strict';

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
    const result = await client.query(`SELECT m.id::text,m.user_id::text,u.email,u.email_verified_at IS NOT NULL AS email_verified,
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
      roleKey: row.role_key, roleName: row.display_name, permissions: row.permissions,
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
    return { integrations: result.rows.map(row => ({ id: row.id, provider: row.provider, status: row.status,
      externalAccount: row.display_name === null ? null : { displayName: row.display_name,
        linkStatus: row.link_status, confirmedAt: row.confirmed_at },
      createdAt: row.created_at, updatedAt: row.updated_at })) };
  }
  return Object.freeze({ company, memberships, roles, integrations });
}

module.exports = { createAdminRepository, decodeCursor, encodeCursor };
