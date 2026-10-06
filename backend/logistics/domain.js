'use strict';

const crypto = require('node:crypto');
const Money = require('../../order-money');
const MAX_MINOR = 9000000000000000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_CLASSES = Object.freeze(['partner', 'marketplace']);
const CAPABILITIES = Object.freeze(['manual_assignment']);
const FULFILLMENT_STATUSES = Object.freeze(['selected', 'dispatch_requested', 'accepted', 'in_progress', 'arrived', 'completed', 'cancelled', 'failed', 'superseded']);
const ACTIVE_STATUSES = Object.freeze(['selected', 'dispatch_requested', 'accepted', 'in_progress', 'arrived']);
const TRANSITIONS = Object.freeze({
  selected: ['dispatch_requested', 'cancelled', 'failed', 'superseded'],
  dispatch_requested: ['accepted', 'in_progress', 'cancelled', 'failed', 'superseded'],
  accepted: ['in_progress', 'arrived', 'completed', 'cancelled', 'failed', 'superseded'],
  in_progress: ['arrived', 'completed', 'failed', 'superseded'],
  arrived: ['completed', 'failed', 'superseded'],
  completed: [], cancelled: [], failed: [], superseded: []
});
class LogisticsError extends Error {
  constructor(code, message) { super(message); this.name = 'LogisticsError'; this.code = code; }
}
function fail(code, message) { throw new LogisticsError(code, message); }
function uuid(value, name) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_INPUT', `${name} inválido.`); return value.toLowerCase(); }
function safeMoney(amount, currency, field) {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_MINOR || Money.currencyScale(currency) === null)
    fail('INVALID_INPUT', `${field} inválido.`);
  return { amountMinor: amount, currency };
}
function validateCode(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/u.test(value) || value === 'internal_fleet') fail('INVALID_INPUT', 'Código de provider inválido ou reservado.');
  return value;
}
function validateName(value) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > 120 || /[\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_INPUT', 'Nome do provider inválido.');
  return value.trim();
}
function validateConfiguration(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['dispatchInstructions', 'portalUrl'].includes(key))) fail('INVALID_INPUT', 'Configuração de provider contém campos não permitidos.');
  const out = {};
  if (value.dispatchInstructions !== undefined) {
    if (typeof value.dispatchInstructions !== 'string' || Buffer.byteLength(value.dispatchInstructions, 'utf8') > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.dispatchInstructions)) fail('INVALID_INPUT', 'Instruções do provider inválidas.');
    out.dispatchInstructions = value.dispatchInstructions.trim();
  }
  if (value.portalUrl !== undefined && value.portalUrl !== '') {
    let url;
    try { url = new URL(value.portalUrl); } catch (_) { fail('INVALID_INPUT', 'URL do provider inválida.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 512) fail('INVALID_INPUT', 'URL do provider deve ser HTTPS e não pode conter credenciais.');
    out.portalUrl = url.href;
  }
  return out;
}
function assertFulfillmentTransition(from, to) {
  if (!FULFILLMENT_STATUSES.includes(to) || from === to || !TRANSITIONS[from]?.includes(to)) fail('INVALID_STATE_TRANSITION', 'Transição manual de fulfillment inválida.');
  return true;
}
function requestDigest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest(); }
function validateFulfillmentPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Atualização de fulfillment inválida.');
  const allowed = new Set(['expectedRevision', 'status', 'externalReference', 'etaAt', 'estimatedCostMinor', 'estimatedCostCurrency', 'finalCostMinor', 'finalCostCurrency']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail('INVALID_INPUT', 'Campo de fulfillment não permitido.');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision > 2147483646) fail('INVALID_INPUT', 'expectedRevision inválida.');
  if (input.status !== undefined && (!FULFILLMENT_STATUSES.includes(input.status) || input.status === 'superseded')) fail('INVALID_INPUT', 'Status de fulfillment inválido.');
  if (input.externalReference !== undefined && input.externalReference !== null &&
      (typeof input.externalReference !== 'string' || !input.externalReference.trim() || Buffer.byteLength(input.externalReference.trim(), 'utf8') > 160 || /[\u0000-\u001f\u007f]/u.test(input.externalReference))) fail('INVALID_INPUT', 'Referência externa inválida.');
  if (input.etaAt !== undefined && input.etaAt !== null && (typeof input.etaAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/u.test(input.etaAt) || !Number.isFinite(Date.parse(input.etaAt)))) fail('INVALID_INPUT', 'ETA inválido.');
  const out = { expectedRevision: input.expectedRevision };
  for (const field of ['status', 'externalReference', 'etaAt']) if (Object.hasOwn(input, field)) out[field] = input[field] === '' ? null : input[field];
  for (const [amountField, currencyField] of [['estimatedCostMinor', 'estimatedCostCurrency'], ['finalCostMinor', 'finalCostCurrency']]) {
    if (Object.hasOwn(input, amountField) !== Object.hasOwn(input, currencyField)) fail('INVALID_INPUT', `${amountField} requer moeda explícita.`);
    if (Object.hasOwn(input, amountField)) Object.assign(out, { [amountField]: safeMoney(input[amountField], input[currencyField], amountField).amountMinor, [currencyField]: input[currencyField] });
  }
  return out;
}
module.exports = Object.freeze({ LogisticsError, MAX_MINOR, UUID, PROVIDER_CLASSES, CAPABILITIES, FULFILLMENT_STATUSES, ACTIVE_STATUSES, TRANSITIONS, uuid, validateCode, validateName, validateConfiguration, safeMoney, assertFulfillmentTransition, requestDigest, validateFulfillmentPatch });
