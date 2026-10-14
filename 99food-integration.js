/* Browser-facing boundary: credentials and webhook secrets remain server-side. */
(function (global) {
  'use strict';
  const serverOnly = () => Promise.reject(Object.assign(new Error('A 99Food é operada pela área autenticada Administração → Integrações.'),
    { code: 'SERVER_MANAGED_INTEGRATION' }));
  global.RotaMoto99Food = Object.freeze({
    available: () => true,
    diagnostics: () => Object.freeze({ provider: '99food', protocol: '99food_recommended', contractAvailable: true,
      protocolAdapter: 'runtime_enabled', runtimeEnabled: true, connectionVerified: false,
      polling: false, pollingReason: 'not_applicable_to_99food_recommended_protocol',
      blockers: Object.freeze(['application_credentials', 'merchant_binding', 'sandbox_whitelist', 'certification']) }),
    status: serverOnly, orders: serverOnly, order: serverOnly, confirm: serverOnly, ready: serverOnly,
    dispatch: serverOnly, cancel: serverOnly
  });
})(window);
