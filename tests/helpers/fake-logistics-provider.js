'use strict';

const crypto = require('node:crypto');

// Test-only adapter. It is deliberately located under tests and must never be
// registered by the production server.
function createFakeLogisticsProvider({ outcomes = [], clock = () => Date.now() } = {}) {
  let cursor = 0;
  const events = [];
  const outcome = () => outcomes[cursor++] || 'confirmed';
  return Object.freeze({
    async quote({ commandId }) {
      const id = crypto.createHash('sha256').update(commandId).digest('hex').slice(0, 32);
      return { provider: 'test_fake', externalQuoteReference: `${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-8${id.slice(17,20)}-${id.slice(20,32)}`,
        currency: 'BRL', amountMinor: 1290, issuedAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + 60000).toISOString(), etaAt: null };
    },
    async dispatch(context) {
      const result = outcome();
      if (result === 'timeout') throw Object.assign(new Error('test timeout'), { classification: 'UNKNOWN_OUTCOME' });
      if (result === 'rate_limit') throw Object.assign(new Error('test rate limit'), { classification: 'RATE_LIMIT', retryAfterSeconds: 3 });
      if (result === 'failure') throw Object.assign(new Error('test rejected'), { classification: 'PERMANENT' });
      if (result === 'pending') return { status: 'pending' };
      events.push({ id: crypto.createHash('sha256').update(context.commandId).digest('hex').slice(0, 24), status: 'accepted', occurredAt: new Date(clock()).toISOString() });
      return { status: 'confirmed', externalReference: `test-${context.commandId}` };
    },
    async cancel() { const result = outcome(); if (result === 'timeout') throw Object.assign(new Error('test timeout'), { classification: 'UNKNOWN_OUTCOME' }); return { status: result === 'failure' ? 'rejected' : 'pending' }; },
    async tracking() { return { status: 'in_progress', etaAt: new Date(clock() + 300000).toISOString(), provenance: 'external_provider' }; },
    async reconcile() { return { status: 'confirmed' }; },
    events
  });
}

module.exports = { createFakeLogisticsProvider };
