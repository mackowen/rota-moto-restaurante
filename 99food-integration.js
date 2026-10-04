/* UI-facing capability boundary. 99Food protocol and field mappings are not
 * verified; this module intentionally performs no network calls or storage. */
(function (global) {
  'use strict';
  const blocked = () => Promise.reject(Object.assign(
    new Error('Integração 99Food indisponível até validação externa.'),
    { code: 'PROVIDER_BLOCKED_EXTERNAL' }
  ));
  global.RotaMoto99Food = Object.freeze({
    available: () => false,
    diagnostics: () => ({ provider: '99food', capability: 'blocked_external', connectionVerified: false }),
    status: blocked, orders: blocked, order: blocked, confirm: blocked, ready: blocked,
    dispatch: blocked, cancel: blocked,
    normalize: () => { throw Object.assign(new Error('Mapeamento 99Food não validado.'), { code: 'PROVIDER_BLOCKED_EXTERNAL' }); }
  });
})(window);
