'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function createLogisticsProviderAdapterRegistry({ ifoodAdapter = null } = {}) {
  const providers = new Map();
  if (ifoodAdapter) {
    providers.set('ifood', Object.freeze({
      async quote(context) {
        const orderId = context.payload?.externalOrderId;
        if (typeof orderId !== 'string' || !UUID.test(orderId)) throw Object.assign(new Error('Pedido não possui referência iFood documentada.'), { classification: 'PERMANENT', code: 'EXTERNAL_ORDER_REFERENCE_MISSING' });
        return { quote: await ifoodAdapter.quote({ companyId: context.companyId, orderId, credentials: context.credentials }) };
      },
      async dispatch(context) {
        const orderId = context.payload?.externalOrderId, quoteId = context.payload?.externalQuoteId;
        if (typeof orderId !== 'string' || !UUID.test(orderId) || typeof quoteId !== 'string' || !UUID.test(quoteId)) throw Object.assign(new Error('Referência externa de cotação ausente.'), { classification: 'PERMANENT', code: 'EXTERNAL_QUOTE_REFERENCE_MISSING' });
        return ifoodAdapter.dispatch({ companyId: context.companyId, orderId, quoteId, credentials: context.credentials });
      },
      async cancel(context) {
        const orderId = context.payload?.externalOrderId;
        if (typeof orderId !== 'string' || !UUID.test(orderId)) throw Object.assign(new Error('Pedido não possui referência iFood documentada.'), { classification: 'PERMANENT', code: 'EXTERNAL_ORDER_REFERENCE_MISSING' });
        return ifoodAdapter.cancel({ companyId: context.companyId, orderId, credentials: context.credentials });
      },
      async tracking(context) {
        const orderId = context.payload?.externalOrderId;
        if (typeof orderId !== 'string' || !UUID.test(orderId)) throw Object.assign(new Error('Pedido não possui referência iFood documentada.'), { classification: 'PERMANENT', code: 'EXTERNAL_ORDER_REFERENCE_MISSING' });
        return ifoodAdapter.tracking({ companyId: context.companyId, orderId, credentials: context.credentials });
      },
      async reconcile(context) {
        return this.tracking(context);
      }
    }));
  }
  return Object.freeze({ get(code) { return providers.get(code) || null; }, codes() { return [...providers.keys()]; } });
}

module.exports = { createLogisticsProviderAdapterRegistry };
