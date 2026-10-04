'use strict';

const { createBlockedAdapter } = require('./backend/integrations/registry');

// The old endpoint/signature assumptions were not verified against official
// 99Food material. Keep this compatibility boundary fail-closed until F4's
// external protocol and homologation dependencies are available.
function create99FoodService() {
  const adapter = createBlockedAdapter('99food');
  const blocked = () => Object.assign(new Error('Integração 99Food bloqueada até validação externa.'), {
    code: 'PROVIDER_BLOCKED_EXTERNAL'
  });
  return Object.freeze({
    configured: () => false,
    authenticate: async () => { throw blocked(); },
    ensureToken: async () => { throw blocked(); },
    orders: async () => { throw blocked(); },
    order: async () => { throw blocked(); },
    action: async () => { throw blocked(); },
    verifyWebhook: () => ({ configured: false, valid: null }),
    diagnostics: adapter.diagnostics
  });
}

module.exports = { create99FoodService };
