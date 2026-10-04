'use strict';

const { createBlockedAdapter } = require('./backend/integrations/registry');

// Previous endpoint and request-signature assumptions were not independently
// verified against official Keeta material. No token/signature is generated.
function createKeetaService() {
  const adapter = createBlockedAdapter('keeta');
  const blocked = () => Object.assign(new Error('Integração Keeta bloqueada até validação externa.'), {
    code: 'PROVIDER_BLOCKED_EXTERNAL'
  });
  return Object.freeze({
    authenticate: async () => { throw blocked(); },
    ensureToken: async () => { throw blocked(); },
    merchant: async () => { throw blocked(); },
    poll: async () => { throw blocked(); },
    acknowledge: async () => { throw blocked(); },
    order: async () => { throw blocked(); },
    action: async () => { throw blocked(); },
    signature: () => { throw blocked(); },
    diagnostics: adapter.diagnostics
  });
}

module.exports = { createKeetaService };
