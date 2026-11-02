'use strict';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_INPUT' });
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => keys.includes(key));
}

function validText(value, maxBytes) {
  return typeof value === 'string' && value.trim().length > 0 &&
    Buffer.byteLength(value.trim(), 'utf8') <= maxBytes && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTimeZone(value) {
  if (typeof value !== 'string' || value.length > 128 || /^[+-]\d{2}:?\d{2}$/u.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; }
  catch (_) { return false; }
}

function validateDeliveryPricing(value) {
  if (value === null) return null;
  const keys = ['model', 'minFee', 'perKm', 'fixedFee', 'round', 'roundTo', 'ranges', 'repasseMode', 'repassePercent'];
  // Compare in cents with a small floating point tolerance. A strict equality
  // rejects valid decimal inputs such as 0.29 because IEEE-754 cannot
  // represent every cent exactly.
  const money = amount => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 &&
    amount <= 1000000 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-8;
  if (!exactKeys(value, keys) || !['perKm', 'range', 'perDelivery'].includes(value.model) ||
      !money(value.minFee) || !money(value.perKm) || !money(value.fixedFee) || typeof value.round !== 'boolean' ||
      !money(value.roundTo) || value.roundTo <= 0 || !['full', 'percentage'].includes(value.repasseMode) ||
      typeof value.repassePercent !== 'number' || !Number.isFinite(value.repassePercent) ||
      value.repassePercent < 0 || value.repassePercent > 100 || !Array.isArray(value.ranges) || value.ranges.length > 32) {
    throw invalid('Confira o modelo e os valores de cobrança informados.');
  }
  const ranges = [];
  let previousTo = 0;
  let previousOpen = false;
  for (const range of value.ranges) {
    if (!exactKeys(range, ['from', 'to', 'value']) || typeof range.from !== 'number' ||
        !Number.isFinite(range.from) || range.from < 0 || range.from > 10000 ||
        !(range.to === null || typeof range.to === 'number' && Number.isFinite(range.to) &&
          range.to > range.from && range.to <= 10000) || !money(range.value) || previousOpen ||
        ranges.length && range.from < previousTo) throw invalid('Revise as faixas de cobrança.');
    ranges.push({ from: range.from, to: range.to, value: range.value });
    previousTo = range.to ?? Infinity;
    previousOpen = range.to === null;
  }
  if (value.model === 'range' && (!ranges.length || ranges[0].from !== 0))
    throw invalid('A primeira faixa deve começar em 0 km.');
  if (value.model === 'perKm' && value.perKm <= 0 || value.model === 'perDelivery' && value.fixedFee <= 0)
    throw invalid('Informe um valor maior que zero para o modelo escolhido.');
  return { model: value.model, minFee: value.minFee, perKm: value.perKm, fixedFee: value.fixedFee,
    round: value.round, roundTo: value.roundTo, ranges, repasseMode: value.repasseMode,
    repassePercent: value.repassePercent };
}

function validateInitialSetup(value) {
  if (!exactKeys(value, ['company', 'deliveryPricing']) || !exactKeys(value.company,
      ['supportPhone', 'timeZone', 'routeGroupingPolicy', 'operationalLocation']))
    throw invalid('As configurações iniciais não estão completas.');
  const company = value.company;
  if (!(company.supportPhone === null || validText(company.supportPhone, 40)) || !validTimeZone(company.timeZone) ||
      !['nearest_extension', 'nearest_origin_round_robin'].includes(company.routeGroupingPolicy))
    throw invalid('Confira o telefone, fuso horário e agrupamento de rotas.');
  let operationalLocation = null;
  if (company.operationalLocation !== null) {
    const location = company.operationalLocation;
    if (!exactKeys(location, ['address', 'latitude', 'longitude', 'confirmed']) ||
        !(location.address === null || validText(location.address, 500)) ||
        !(location.latitude === null || typeof location.latitude === 'number' && Number.isFinite(location.latitude) &&
          location.latitude >= -90 && location.latitude <= 90) ||
        !(location.longitude === null || typeof location.longitude === 'number' && Number.isFinite(location.longitude) &&
          location.longitude >= -180 && location.longitude <= 180) ||
        (location.latitude === null) !== (location.longitude === null))
      throw invalid('Confira o endereço e confirme as coordenadas da empresa.');
    if ((location.address !== null || location.latitude !== null) && location.confirmed !== true)
      throw invalid('Confirme a localização antes de continuar.');
    operationalLocation = { address: location.address?.trim() || null, latitude: location.latitude,
      longitude: location.longitude };
  }
  return { company: { supportPhone: company.supportPhone?.trim() || null, timeZone: company.timeZone,
    routeGroupingPolicy: company.routeGroupingPolicy, operationalLocation },
  deliveryPricing: validateDeliveryPricing(value.deliveryPricing) };
}

module.exports = { validateInitialSetup, validateDeliveryPricing };
