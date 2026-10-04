'use strict';

const PROVIDERS = Object.freeze([
  Object.freeze({ key: 'ifood', name: 'iFood', capability: 'blocked_external',
    blockers: Object.freeze(['official_protocol_review', 'merchant_credentials', 'homologation']) }),
  Object.freeze({ key: '99food', name: '99Food', capability: 'blocked_external',
    blockers: Object.freeze(['official_protocol_review', 'partner_credentials', 'homologation']) }),
  Object.freeze({ key: 'keeta', name: 'Keeta', capability: 'blocked_external',
    blockers: Object.freeze(['official_protocol_review', 'partner_credentials', 'homologation']) })
]);

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_SECONDS = 3600;
const MAX_RETRY_ATTEMPTS = 8;

function publicCatalog(persisted = []) {
  const byProvider = new Map(persisted.map(row => [row.provider, row]));
  return PROVIDERS.map(provider => {
    const row = byProvider.get(provider.key);
    const disabled = row?.status === 'disabled';
    return {
      provider: provider.key,
      displayName: provider.name,
      capability: provider.capability,
      state: disabled ? 'disabled' : row?.status === 'error' ? 'error' : 'configuration_required',
      connectionVerified: false,
      lastEventAt: null,
      externalAccount: row?.externalAccount ? {
        displayName: row.externalAccount.displayName,
        linkStatus: row.externalAccount.linkStatus,
        confirmedAt: row.externalAccount.confirmedAt
      } : null,
      actions: Object.freeze({ connect: false, reconnect: false, disable: false }),
      blockers: [...provider.blockers]
    };
  });
}

function classifyProviderFailure(error) {
  const status = Number(error?.status);
  const retryable = RETRYABLE_HTTP.has(status) || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNRESET';
  const retryAfter = Number(error?.retryAfterSeconds);
  return Object.freeze({
    class: status === 401 || status === 403 ? 'reauth_required' : retryable ? 'transient' : 'permanent',
    retryable,
    retryAfterSeconds: retryable && Number.isFinite(retryAfter)
      ? Math.max(1, Math.min(MAX_RETRY_AFTER_SECONDS, Math.trunc(retryAfter))) : null
  });
}

function sanitizeProviderError(error) {
  return Object.freeze({
    code: /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'PROVIDER_ERROR',
    ...classifyProviderFailure(error)
  });
}

function retryDelayMs(error, attempt, random = Math.random) {
  const classification = classifyProviderFailure(error);
  if (!classification.retryable || !Number.isInteger(attempt) || attempt < 0 || attempt >= MAX_RETRY_ATTEMPTS) return null;
  if (classification.retryAfterSeconds !== null) return classification.retryAfterSeconds * 1000;
  const ceiling = Math.min(300_000, 1000 * (2 ** attempt));
  const jitter = Number(random());
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new TypeError('Fonte de jitter inválida.');
  return Math.max(1, Math.round(ceiling * (0.5 + jitter)));
}

function createBlockedAdapter(providerKey) {
  const provider = PROVIDERS.find(item => item.key === providerKey);
  if (!provider) throw new TypeError('Provider desconhecido.');
  const blocked = () => Object.assign(new Error('Integração externa ainda não habilitada.'), {
    code: 'PROVIDER_BLOCKED_EXTERNAL'
  });
  return Object.freeze({
    provider: provider.key,
    capability: provider.capability,
    diagnostics: () => ({ provider: provider.key, capability: provider.capability, connectionVerified: false }),
    connect: async () => { throw blocked(); },
    poll: async () => { throw blocked(); },
    acknowledge: async () => { throw blocked(); },
    execute: async () => { throw blocked(); }
  });
}

module.exports = { PROVIDERS, publicCatalog, classifyProviderFailure, sanitizeProviderError, retryDelayMs, createBlockedAdapter };
