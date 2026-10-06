(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoOrderMoney = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_MINOR = 9000000000000000;
  const COMPONENTS = Object.freeze(['itemsSubtotalMinor', 'discountMinor', 'deliveryFeeMinor', 'serviceFeeMinor', 'otherFeeMinor', 'totalMinor']);
  const ISO_CURRENCY = /^[A-Z]{3}$/u;

  function currencyScale(currency) {
    if (typeof currency !== 'string' || !ISO_CURRENCY.test(currency)) return null;
    try {
      if (typeof Intl.supportedValuesOf !== 'function' || !Intl.supportedValuesOf('currency').includes(currency)) return null;
      const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
      return Number.isInteger(digits) && digits >= 0 && digits <= 3 ? digits : null;
    } catch (_) { return null; }
  }

  function validateMoney(money) {
    if (!money || typeof money !== 'object' || Array.isArray(money)) return { valid: false, reason: 'shape' };
    if (Object.keys(money).some(key => !['currency', 'completeness', 'provenance', 'components'].includes(key))) return { valid: false, reason: 'unknown-field' };
    if (currencyScale(money.currency) === null) return { valid: false, reason: 'currency' };
    if (!['complete', 'partial', 'unknown'].includes(money.completeness)) return { valid: false, reason: 'completeness' };
    const provenance = money.provenance;
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) ||
        Object.keys(provenance).some(key => !['kind', 'sourceId'].includes(key)) ||
        !['manual', 'external', 'import'].includes(provenance.kind) ||
        (provenance.sourceId !== undefined && (typeof provenance.sourceId !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,79}$/iu.test(provenance.sourceId)))) return { valid: false, reason: 'provenance' };
    const components = money.components;
    if (!components || typeof components !== 'object' || Array.isArray(components) ||
        Object.keys(components).some(key => !COMPONENTS.includes(key)) || money.completeness === 'unknown' && Object.keys(components).length) return { valid: false, reason: 'components' };
    for (const [key, value] of Object.entries(components)) {
      if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_MINOR || (key === 'discountMinor' ? value < 0 : value < 0)) return { valid: false, reason: 'amount' };
    }
    if (money.completeness === 'complete') {
      if (COMPONENTS.some(key => !Object.hasOwn(components, key))) return { valid: false, reason: 'incomplete-components' };
      const expected = components.itemsSubtotalMinor - components.discountMinor + components.deliveryFeeMinor + components.serviceFeeMinor + components.otherFeeMinor;
      if (!Number.isSafeInteger(expected) || expected !== components.totalMinor) return { valid: false, reason: 'total-mismatch' };
    }
    if (COMPONENTS.every(key => Object.hasOwn(components, key))) {
      const expected = components.itemsSubtotalMinor - components.discountMinor + components.deliveryFeeMinor + components.serviceFeeMinor + components.otherFeeMinor;
      if (!Number.isSafeInteger(expected) || expected !== components.totalMinor) return { valid: false, reason: 'total-mismatch' };
    }
    return { valid: true, currency: money.currency, scale: currencyScale(money.currency) };
  }

  function fromDecimal(value, currency, component, provenance = { kind: 'manual' }) {
    if (!COMPONENTS.includes(component) || component === 'discountMinor') return null;
    const scale = currencyScale(currency);
    if (scale === null || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MINOR / (10 ** scale)) return null;
    const amount = Math.round((value + Number.EPSILON) * (10 ** scale));
    if (!Number.isSafeInteger(amount) || amount > MAX_MINOR) return null;
    const money = { currency, completeness: 'partial', provenance, components: { [component]: amount } };
    return validateMoney(money).valid ? money : null;
  }

  function withManualDeliveryFee(existing, value, currency = 'BRL') {
    const fee = fromDecimal(value, currency, 'deliveryFeeMinor');
    if (!fee) return null;
    if (!validateMoney(existing).valid || existing.completeness === 'unknown') return fee;
    const components = { ...existing.components, deliveryFeeMinor: fee.components.deliveryFeeMinor };
    let completeness = existing.completeness;
    if (completeness === 'complete') {
      const total = components.itemsSubtotalMinor - components.discountMinor + components.deliveryFeeMinor + components.serviceFeeMinor + components.otherFeeMinor;
      if (!Number.isSafeInteger(total) || total < 0 || total > MAX_MINOR) return null;
      components.totalMinor = total;
    }
    const updated = { currency, completeness, provenance: { kind: 'manual' }, components };
    return validateMoney(updated).valid ? updated : fee;
  }

  function canonicalComponents(order) {
    const money = order?.money;
    if (money && !validateMoney(money).valid) return { kind: 'invalid', currency: null, scale: null };
    if (validateMoney(money).valid && money.completeness !== 'unknown') return { kind: `canonical_${money.completeness}`, currency: money.currency, scale: currencyScale(money.currency), ...money.components };
    if (money) return { kind: 'unknown', currency: money.currency, scale: currencyScale(money.currency) };
    const currency = currencyScale(order?.currency) === null ? null : order.currency;
    const source = String(order?.sourceId || (typeof order?.source === 'string' ? order.source : order?.source?.origin) || order?.channel || '').toLowerCase();
    const deliveryFee = order?.deliveryFee ?? order?.value;
    if (typeof deliveryFee === 'number' && Number.isFinite(deliveryFee) && deliveryFee >= 0) {
      const knownManualChannel = new Set(['manual', 'telefone', 'whatsapp', 'site', 'outro']).has(source);
      const feeCurrency = typeof order.deliveryFeeCurrency === 'string' && currencyScale(order.deliveryFeeCurrency) !== null
        ? order.deliveryFeeCurrency : (knownManualChannel ? 'BRL' : null);
      return { kind: 'legacy_delivery_fee', currency: feeCurrency, scale: feeCurrency ? currencyScale(feeCurrency) : null, legacyDeliveryFee: deliveryFee,
        ...(Number.isSafeInteger(order?.amountMinor) && order.amountMinor >= 0 ? { legacyAmountMinor: order.amountMinor } : {}) };
    }
    if (Number.isSafeInteger(order?.amountMinor) && order.amountMinor >= 0) return { kind: 'legacy_ambiguous_total', currency, scale: currency === null ? null : currencyScale(currency), legacyAmountMinor: order.amountMinor };
    return { kind: 'unknown', currency: null, scale: null };
  }

  return Object.freeze({ MAX_MINOR, COMPONENTS, currencyScale, validateMoney, fromDecimal, withManualDeliveryFee, canonicalComponents });
});
