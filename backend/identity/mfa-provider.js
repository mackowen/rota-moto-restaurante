'use strict';

class MfaProviderNotConfiguredError extends Error {
  constructor() { super('Verificação MFA não configurada.'); this.code = 'MFA_REQUIRED'; }
}

function createMfaProvider(verify) {
  if (typeof verify !== 'function') throw new TypeError('O provider MFA deve implementar verify({ userId, code }).');
  return Object.freeze({ async verify({ userId, code }) {
    if (typeof userId !== 'string' || typeof code !== 'string' || code.length < 6 || code.length > 128 || /[\u0000-\u001f\u007f]/u.test(code)) return false;
    return await verify(Object.freeze({ userId, code })) === true;
  } });
}

function requireMfaProvider(provider) {
  if (!provider || typeof provider.verify !== 'function') throw new MfaProviderNotConfiguredError();
  return provider;
}

module.exports = { createMfaProvider, requireMfaProvider, MfaProviderNotConfiguredError };
