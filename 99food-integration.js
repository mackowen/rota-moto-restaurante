/* Browser-facing capability boundary. The backend protocol adapter has local
 * contract coverage, but no authenticated persistence/runtime wiring yet. */
(function (global) {
  'use strict';
  const blocked = () => Promise.reject(Object.assign(
    new Error('99Food ainda não está conectado ao processamento persistente de pedidos.'),
    { code: 'PROVIDER_RUNTIME_NOT_WIRED' }
  ));
  global.RotaMoto99Food = Object.freeze({
    available: () => false,
    diagnostics: () => Object.freeze({ provider: '99food', protocol: '99food_recommended', contractAvailable: true,
      protocolAdapter: 'local_tested', runtimeEnabled: false, connectionVerified: false,
      blockers: Object.freeze(['database_runtime_support', 'application_credentials', 'merchant_binding', 'certification']) }),
    status: blocked, orders: blocked, order: blocked, confirm: blocked, ready: blocked,
    dispatch: blocked, cancel: blocked,
    normalize: () => { throw Object.assign(new Error('A normalização canônica de 99Food ainda requer o runtime persistente.'), { code: 'PROVIDER_RUNTIME_NOT_WIRED' }); }
  });
})(window);
