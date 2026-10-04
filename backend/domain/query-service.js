'use strict';

const { COLLECTIONS } = require('./query-repository');

const QUERY_PERMISSIONS = Object.freeze({ orders: 'orders.read', deliveries: 'sync.pull', routes: 'sync.pull', drivers: 'sync.pull',
  'delivery-events': 'sync.pull', locations: 'sync.pull', proofs: 'sync.pull', earnings: 'sync.pull' });

function invalid(message) { const error = new Error(message); error.code = 'INVALID_INPUT'; throw error; }
function createDomainQueryService({ repository }) {
  if (!repository || typeof repository.list !== 'function' || typeof repository.get !== 'function') throw new TypeError('Repository de consulta de domínio obrigatório.');
  async function assertDomainPrincipal(client, principal) {
    const admin = await client.query(`SELECT 1 FROM rotamoto.role_permissions
      WHERE company_id=$1 AND role_id=$2 AND catalog_version=1 AND permission_key='company.manage'`,
    [principal.company_id, principal.role_id]);
    if (admin.rowCount) return null;
    if (principal.driver_id) return principal.driver_id;
    if (!admin.rowCount) { const error = new Error('A associação desta conta a um motorista precisa ser configurada pela empresa.'); error.code = 'DRIVER_LINK_REQUIRED'; throw error; }
    return null;
  }
  async function get(client, principal, collection, id) {
    const entityType = COLLECTIONS[collection];
    if (!entityType) { const error = new Error('Coleção não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const driverId = await assertDomainPrincipal(client, principal);
    return repository.get(client, { companyId: principal.company_id, entityType, id, driverId });
  }
  async function list(client, principal, collection, query = {}) {
    const entityType = COLLECTIONS[collection];
    if (!entityType) { const error = new Error('Coleção não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    const allowed = new Set(['limit', 'cursor', 'includeDeleted', 'status', 'driverId', 'orderId', 'relatedId']);
    if (Object.keys(query).some(key => !allowed.has(key))) invalid('Parâmetro de consulta não permitido.');
    const rawLimit = query.limit === undefined ? '50' : query.limit;
    if (typeof rawLimit !== 'string' || !/^(?:[1-9]\d?|100)$/u.test(rawLimit)) invalid('limit deve estar entre 1 e 100.');
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 512)) invalid('cursor inválido.');
    if (query.includeDeleted !== undefined && !['true', 'false'].includes(query.includeDeleted)) invalid('includeDeleted inválido.');
    const filters = Object.fromEntries(['status', 'driverId', 'orderId', 'relatedId']
      .filter(key => query[key] !== undefined).map(key => [key, query[key]]));
    const driverId = await assertDomainPrincipal(client, principal);
    return repository.list(client, { companyId: principal.company_id, entityType,
      limit: Number(rawLimit), cursor: query.cursor || null, includeDeleted: query.includeDeleted === 'true', filters, driverId });
  }
  return Object.freeze({ get, list });
}

module.exports = { QUERY_PERMISSIONS, createDomainQueryService };
