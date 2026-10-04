'use strict';

const { COLLECTIONS } = require('./query-repository');

const QUERY_PERMISSIONS = Object.freeze({ orders: 'orders.read', deliveries: 'sync.pull', routes: 'sync.pull', drivers: 'sync.pull',
  'delivery-events': 'sync.pull', locations: 'sync.pull', proofs: 'sync.pull', earnings: 'sync.pull' });

function invalid(message) { const error = new Error(message); error.code = 'INVALID_INPUT'; throw error; }
function createDomainQueryService({ repository }) {
  if (!repository || typeof repository.list !== 'function' || typeof repository.get !== 'function') throw new TypeError('Repository de consulta de domínio obrigatório.');
  async function get(client, principal, collection, id) {
    const entityType = COLLECTIONS[collection];
    if (!entityType) { const error = new Error('Coleção não encontrada.'); error.code = 'NOT_FOUND'; throw error; }
    return repository.get(client, { companyId: principal.company_id, entityType, id });
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
    return repository.list(client, { companyId: principal.company_id, entityType,
      limit: Number(rawLimit), cursor: query.cursor || null, includeDeleted: query.includeDeleted === 'true', filters });
  }
  return Object.freeze({ get, list });
}

module.exports = { QUERY_PERMISSIONS, createDomainQueryService };
