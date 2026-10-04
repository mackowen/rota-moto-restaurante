/* UI-facing capability boundary. Keeta protocol and field mappings are not
 * verified; this module intentionally performs no network calls or storage. */
(function (global) {
  'use strict';
  const blocked = () => Promise.reject(Object.assign(
    new Error('Integração Keeta indisponível até validação externa.'),
    { code: 'PROVIDER_BLOCKED_EXTERNAL' }
  ));
  global.RotaMotoKeeta = Object.freeze({
    available: () => false,
    diagnostics: () => ({ provider: 'keeta', capability: 'blocked_external', connectionVerified: false }),
    status: blocked, merchant: blocked, poll: blocked, ack: blocked, order: blocked,
    confirm: blocked, readyForPickup: blocked, dispatch: blocked, delivered: blocked, cancel: blocked,
    normalize: () => { throw Object.assign(new Error('Mapeamento Keeta não validado.'), { code: 'PROVIDER_BLOCKED_EXTERNAL' }); }
  });
})(window);
