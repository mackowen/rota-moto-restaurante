'use strict';

function createAdminService({ repository }) {
  if (!repository) throw new TypeError('Repository administrativo obrigatório.');
  function limitValue(value) {
    const text = value === undefined ? '50' : value;
    if (typeof text !== 'string' || !/^(?:[1-9]\d?|100)$/u.test(text)) {
      const error = new Error('limit deve estar entre 1 e 100.'); error.code = 'INVALID_INPUT'; throw error;
    }
    return Number(text);
  }
  return Object.freeze({
    company: (client, principal) => repository.company(client, principal.company_id),
    memberships(client, principal, query = {}) {
      if (Object.keys(query).some(key => !['limit', 'cursor'].includes(key))) {
        const error = new Error('Parâmetro de consulta não permitido.'); error.code = 'INVALID_INPUT'; throw error;
      }
      if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 512)) {
        const error = new Error('cursor inválido.'); error.code = 'INVALID_INPUT'; throw error;
      }
      return repository.memberships(client, principal.company_id, { limit: limitValue(query.limit), cursor: query.cursor || null });
    },
    roles: (client, principal) => repository.roles(client, principal.company_id),
    permissions: client => repository.permissions(client),
    createRole(client, principal, input) { return repository.createRole(client, principal, input); },
    updateRole(client, principal, roleId, input) { return repository.updateRole(client, principal, roleId, input); },
    updateMembership(client, principal, membershipId, input) {
      return repository.updateMembership(client, principal, membershipId, input);
    },
    integrations: (client, principal) => repository.integrations(client, principal.company_id)
  });
}

module.exports = { createAdminService };
