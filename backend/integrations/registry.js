'use strict';

const PROVIDERS = Object.freeze([
  Object.freeze({ key: 'ifood', name: 'iFood', capability: 'blocked_external',
    capabilityMatrix: Object.freeze({ account: 'SUPPORTED', merchant: 'SUPPORTED', orders: 'SUPPORTED', webhook: 'SUPPORTED', polling: 'SUPPORTED', selfDelivery: 'SUPPORTED', platformDelivery: 'SUPPORTED', quote: 'SUPPORTED', dispatch: 'SUPPORTED', cancelOrder: 'SUPPORTED', cancelDelivery: 'SUPPORTED', tracking: 'SUPPORTED', sandbox: 'SUPPORTED', homologation: 'REQUIRES_PARTNERSHIP' }),
    blockers: Object.freeze(['merchant_credentials', 'merchant_authorization', 'homologation', 'provider_worker_account_routing']) }),
  Object.freeze({ key: '99food', name: '99Food', capability: 'blocked_external',
    capabilityMatrix: Object.freeze({ account: 'REQUIRES_PARTNERSHIP', merchant: 'REQUIRES_PARTNERSHIP', orders: 'REQUIRES_PARTNERSHIP', webhook: 'REQUIRES_PARTNERSHIP', polling: 'REQUIRES_PARTNERSHIP', selfDelivery: 'NOT_PUBLICLY_DOCUMENTED', platformDelivery: 'NOT_PUBLICLY_DOCUMENTED', quote: 'NOT_PUBLICLY_DOCUMENTED', dispatch: 'NOT_PUBLICLY_DOCUMENTED', cancelOrder: 'NOT_PUBLICLY_DOCUMENTED', cancelDelivery: 'NOT_PUBLICLY_DOCUMENTED', tracking: 'NOT_PUBLICLY_DOCUMENTED', sandbox: 'REQUIRES_PARTNERSHIP', homologation: 'REQUIRES_PARTNERSHIP' }),
    blockers: Object.freeze(['certification', 'application_access', 'official_contract_validation', 'merchant_authorization']) }),
  Object.freeze({ key: 'keeta', name: 'Keeta', capability: 'blocked_external',
    capabilityMatrix: Object.freeze({ account: 'SUPPORTED', merchant: 'SUPPORTED', orders: 'SUPPORTED', webhook: 'SUPPORTED', polling: 'SUPPORTED', selfDelivery: 'SUPPORTED', platformDelivery: 'NOT_SUPPORTED', quote: 'NOT_PUBLICLY_DOCUMENTED', dispatch: 'SUPPORTED', cancelOrder: 'SUPPORTED', cancelDelivery: 'NOT_PUBLICLY_DOCUMENTED', tracking: 'SUPPORTED', sandbox: 'SUPPORTED', homologation: 'REQUIRES_PARTNERSHIP' }),
    blockers: Object.freeze(['application_credentials', 'merchant_authorization', 'SIT_certification', 'provider_account_routing']) })
]);

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_SECONDS = 3600;
const MAX_RETRY_ATTEMPTS = 8;

const PUBLICLY_DOCUMENTED = Object.freeze({
  ifood: new Set(['account','merchant','orders','webhook','polling','selfDelivery','platformDelivery','quote','dispatch','cancelOrder','cancelDelivery','tracking','sandbox','homologation']),
  '99food': new Set(),
  keeta: new Set(['account','merchant','orders','webhook','polling','selfDelivery','dispatch','cancelOrder','tracking','sandbox'])
});
const LOCAL_ADAPTERS = Object.freeze({
  ifood: new Set(['merchant', 'orders', 'webhook', 'polling', 'selfDelivery', 'platformDelivery', 'quote', 'dispatch', 'cancelOrder', 'cancelDelivery', 'tracking']),
  '99food': new Set(),
  keeta: new Set(['account', 'merchant', 'orders', 'webhook', 'polling', 'selfDelivery', 'dispatch', 'cancelOrder', 'tracking'])
});
const LOCALLY_TESTED = Object.freeze({
  ifood: new Set(['merchant', 'orders', 'webhook', 'polling', 'selfDelivery', 'platformDelivery', 'quote', 'dispatch', 'cancelOrder', 'cancelDelivery', 'tracking']),
  '99food': new Set(),
  keeta: new Set(['account', 'orders', 'webhook', 'polling', 'selfDelivery', 'dispatch', 'cancelOrder', 'tracking'])
});

function auditedCapabilities(provider) {
  return Object.fromEntries(Object.entries(provider.capabilityMatrix).map(([name, contract]) => [name, Object.freeze({
    DOCUMENTED: PUBLICLY_DOCUMENTED[provider.key].has(name),
    IMPLEMENTED: LOCAL_ADAPTERS[provider.key].has(name),
    RUNTIME_WIRED: false,
    LOCAL_TESTED: LOCALLY_TESTED[provider.key].has(name),
    SANDBOX_TESTED: false,
    PRODUCTION_AUTHORIZED: false
  })]));
}

function publicCatalog(persisted = []) {
  const byProvider = new Map(persisted.map(row => [row.provider, row]));
  return PROVIDERS.map(provider => {
    const row = byProvider.get(provider.key);
    const disabled = row?.status === 'disabled';
    const accountConfirmed = row?.externalAccount?.linkStatus === 'confirmed';
    // A confirmed account link is not a provider health check or proof that tokens work.
    const connectionVerified = false;
    return {
      provider: provider.key,
      displayName: provider.name,
      capability: provider.capability,
      capabilityContract: { ...provider.capabilityMatrix },
      capabilities: auditedCapabilities(provider),
      capabilityNotes: provider.key === 'ifood' ? 'Pedidos, cancelamento de pedido e entrega são recursos diferentes. Ações de Shipping documentadas ainda exigem conta, autorização e worker para funcionar.' :
        provider.key === '99food' ? 'A Open Platform anuncia pedidos e webhooks, mas exige acesso aos contratos detalhados e certificação antes de implementar transporte.' :
          'App token e URL de autorização têm adapter local; callback, vínculo da loja e grant shop-level não estão ligados ao runtime. Dados PII protegidos não são desencriptados nem formam Order canônico. Dispatch e tracking são para entrega própria; não existe contratação avulsa de courier Keeta.' ,
      state: disabled ? 'disabled' : row?.status === 'error' ? 'error' : row?.status === 'active' && accountConfirmed ? 'authorized_unverified' : 'configuration_required',
      connectionVerified,
      lastEventAt: row?.lastEventAt || null,
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
