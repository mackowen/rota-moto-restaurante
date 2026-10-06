'use strict';
const assert = require('node:assert/strict');
const Money = require('../order-money');
require('../contract.js');
const Contract = globalThis.RotaMotoContract;
const { validateOrderMoneyRecord } = require('../backend/domain/sync-service');

const partial = Money.fromDecimal(12.34, 'BRL', 'deliveryFeeMinor');
assert.deepEqual(partial, { currency: 'BRL', completeness: 'partial', provenance: { kind: 'manual' }, components: { deliveryFeeMinor: 1234 } });
assert.equal(Money.validateMoney(partial).valid, true);
assert.equal(Money.validateMoney({ ...partial, components: { deliveryFeeMinor: 12.34 } }).valid, false, 'floating point component rejected');
assert.equal(Money.validateMoney({ ...partial, currency: 'ZZZ' }).valid, false, 'unknown ISO code rejected');
assert.equal(Money.currencyScale('JPY'), 0);
assert.equal(Money.currencyScale('BRL'), 2);
assert.equal(Money.currencyScale('KWD'), 3);
assert.equal(Money.fromDecimal(Number.MAX_SAFE_INTEGER, 'BRL', 'deliveryFeeMinor'), null, 'amount bound prevents unsafe conversion');

const complete = { currency: 'BRL', completeness: 'complete', provenance: { kind: 'external', sourceId: 'market_x' }, components: {
  itemsSubtotalMinor: 10000, discountMinor: 1000, deliveryFeeMinor: 1200, serviceFeeMinor: 300, otherFeeMinor: 0, totalMinor: 10500
} };
assert.equal(Money.validateMoney(complete).valid, true);
const editedComplete = Money.withManualDeliveryFee(complete, 13.25);
assert.equal(editedComplete.components.deliveryFeeMinor, 1325);
assert.equal(editedComplete.components.totalMinor, 10625, 'manual fee update preserves known components and recalculates a complete total');
assert.equal(editedComplete.provenance.kind, 'manual');
assert.equal(Money.validateMoney({ ...complete, components: { ...complete.components, totalMinor: 10499 } }).reason, 'total-mismatch');
assert.throws(() => validateOrderMoneyRecord({ source: 'market_x', money: { ...complete, components: { ...complete.components, totalMinor: 10499 } } }), /Order\.money/);
assert.throws(() => validateOrderMoneyRecord({ source: 'market_y', money: complete }), /provenance/);
assert.equal(validateOrderMoneyRecord({ source: 'market_x', money: complete }), true);
assert.throws(() => validateOrderMoneyRecord({ amountMinor: 1.2 }), /amountMinor/);
assert.throws(() => validateOrderMoneyRecord({ amountMinor: -1 }), /amountMinor/);
assert.throws(() => validateOrderMoneyRecord({ amountMinor: 1, currency: 'ZZZ' }), /currency/);
assert.throws(() => validateOrderMoneyRecord({ money: { ...partial, components: { deliveryFeeMinor: Number.MAX_SAFE_INTEGER + 1 } } }), /Order\.money/);

assert.equal(Money.canonicalComponents({ money: partial }).kind, 'canonical_partial');
assert.equal(Money.canonicalComponents({ amountMinor: 5000, currency: 'BRL' }).kind, 'legacy_ambiguous_total');
assert.equal(Money.canonicalComponents({ amountMinor: 5000 }).currency, null, 'missing legacy currency is not inferred');
assert.equal(Money.canonicalComponents({ value: 12, sourceId: 'manual' }).kind, 'legacy_delivery_fee');
assert.equal(Money.canonicalComponents({ value: 12, sourceId: 'ifood' }).currency, null, 'external legacy currency is not assumed');
assert.equal(Money.canonicalComponents({ value: 12 }).currency, null, 'unknown legacy origin does not imply BRL');
assert.equal(Money.canonicalComponents({ value: 12, sourceId: 'telefone' }).currency, 'BRL', 'known local/manual channel retains its documented BRL semantics');
assert.equal(Money.canonicalComponents({ money: { ...partial, currency: 'ZZZ' } }).kind, 'invalid');
assert.equal(Contract.validateEntity('Order', { id: 'o', companyId: 'c', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, money: partial }).valid, true);
console.log('Order money semantics, legacy projection and server validation passed.');
