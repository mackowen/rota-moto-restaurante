'use strict';

const ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';
const CELL_PRECISION = 5;
const MIN_CELL_SAMPLE = 5;
const MAX_MAP_ACCURACY_M = 1500;
const MAX_ROWS = 10000;
const STATUSES = new Set(['CREATED','ASSIGNED','ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY','ARRIVED','DELIVERED','CANCELLED','FAILED','RETURNED','REDELIVERY','UNKNOWN']);
const PERIODS = new Set([7,30,90,365]);
const ORDER_STATUS = Object.freeze({ AGUARDANDO:'CREATED', ATRIBUIDA:'ASSIGNED', 'EM ROTA':'OUT_FOR_DELIVERY', CHEGOU:'ARRIVED', FINALIZADA:'DELIVERED', CANCELADA:'CANCELLED' });
const Money = require('../../order-money');

function fail(message) { const error = new Error(message); error.code = 'INVALID_INPUT'; throw error; }
function geohash(latitude, longitude, precision = CELL_PRECISION) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isInteger(precision) || precision < 1 || precision > 8) fail('Coordenada inválida.');
  let lat = [-90, 90], lon = [-180, 180], even = true, bit = 0, value = 0, hash = '';
  while (hash.length < precision) {
    const range = even ? lon : lat, coordinate = even ? longitude : latitude, mid = (range[0] + range[1]) / 2;
    if (coordinate >= mid) { value = (value << 1) | 1; range[0] = mid; } else { value <<= 1; range[1] = mid; }
    even = !even;
    if (++bit === 5) { hash += ALPHABET[value]; bit = 0; value = 0; }
  }
  return hash;
}
function cellCenter(hash) {
  if (typeof hash !== 'string' || hash.length !== CELL_PRECISION || [...hash].some(ch => !ALPHABET.includes(ch))) fail('Célula inválida.');
  let lat = [-90, 90], lon = [-180, 180], even = true;
  for (const ch of hash) {
    const value = ALPHABET.indexOf(ch);
    for (let mask = 16; mask; mask >>= 1) {
      const range = even ? lon : lat, mid = (range[0] + range[1]) / 2;
      if (value & mask) range[0] = mid; else range[1] = mid;
      even = !even;
    }
  }
  return { latitude: (lat[0] + lat[1]) / 2, longitude: (lon[0] + lon[1]) / 2 };
}
function timezoneValid(zone) { try { if (typeof zone !== 'string' || !zone.trim()) return false; new Intl.DateTimeFormat('en',{timeZone:zone}).format(0); return true; } catch (_) { return false; } }
function zonedParts(at, zone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);
  return Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
}
function shiftDate(key, days) { const date=new Date(`${key}T00:00:00.000Z`);date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10); }
function zonedMidnight(key, zone) {
  const [year,month,day]=key.split('-').map(Number), target=Date.UTC(year,month-1,day);let guess=target;
  for(let attempt=0;attempt<4;attempt++) {
    const p=zonedParts(new Date(guess),zone), represented=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day));
    const local=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess));
    const values=Object.fromEntries(local.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
    const localMs=represented+((Number(values.hour)*3600+Number(values.minute)*60+Number(values.second))*1000);
    const delta=target-localMs;if(!delta)break;guess+=delta;
  }
  return new Date(guess);
}
function normalizeFilters(query = {}, now = new Date(), timeZone = null) {
  const allowed = new Set(['period','status','source','type','driverId','mode','providerId','metric']);
  if (Object.keys(query).some(key => !allowed.has(key))) fail('Filtro não permitido.');
  const period = query.period === undefined ? 30 : Number(query.period);
  if (!PERIODS.has(period)) fail('Período inválido.');
  const status = query.status === undefined || query.status === '' ? null : ORDER_STATUS[String(query.status).trim().toUpperCase()] || String(query.status).trim().toUpperCase();
  if (status && !STATUSES.has(status)) fail('Status inválido.');
  const boundedText = (key, max) => {
    if (query[key] === undefined || query[key] === '') return null;
    if (typeof query[key] !== 'string' || query[key].length > max || /[\u0000-\u001f\u007f]/u.test(query[key])) fail('Filtro inválido.');
    return query[key].trim();
  };
  const source = boundedText('source', 64), type = boundedText('type', 40);
  const driverId = boundedText('driverId', 36), providerId = boundedText('providerId', 36);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (driverId && !uuid.test(driverId) || providerId && !uuid.test(providerId)) fail('Identificador inválido.');
  const mode = boundedText('mode', 16);
  if (mode && !['internal','external'].includes(mode)) fail('Modo inválido.');
  const metric = query.metric === undefined ? 'volume' : query.metric;
  if (!['volume','delivery_fee','duration','actual_distance','estimated_distance'].includes(metric)) fail('Métrica inválida.');
  const end = new Date(now), zone=timezoneValid(timeZone)?timeZone:null;
  let start;
  if(zone){const today=zonedParts(end,zone),key=`${today.year}-${today.month}-${today.day}`;start=zonedMidnight(shiftDate(key,-(period-1)),zone);}
  else start=new Date(end.getTime()-period*86400000);
  return Object.freeze({ period, start, end, timeZone:zone, status, source, type, driverId, mode, providerId, metric });
}
function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
function statusOf(row) {
  const raw = String(row.delivery?.status || row.order?.deliveryStatus || row.order?.status || '').trim().toUpperCase();
  return ORDER_STATUS[raw] || (STATUSES.has(raw) ? raw : 'UNKNOWN');
}
function commercialSource(order) { return String(order?.sourceId || (typeof order?.source === 'string' ? order.source : order?.source?.origin) || order?.channel || 'unknown').trim().slice(0, 64) || 'unknown'; }
function numeric(value, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}
function band(count) { return count < 10 ? '5–9' : count < 25 ? '10–24' : '25+'; }
function metricAverage(values) { return values.length >= MIN_CELL_SAMPLE ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function deliveryFee(order) {
  const money = Money.canonicalComponents(order || {});
  if (money.currency !== 'BRL') return null;
  if (Number.isSafeInteger(money.deliveryFeeMinor) && money.deliveryFeeMinor >= 0) return money.deliveryFeeMinor / 100;
  if (money.kind === 'legacy_delivery_fee' && Number.isFinite(money.legacyDeliveryFee) && money.legacyDeliveryFee >= 0) return money.legacyDeliveryFee;
  return null;
}
function aggregate(rows, filters, now = Date.now()) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('Recorte indisponível.');
  const selected = [];
  for (const row of rows) {
    const order = row.order || {}, delivery = row.delivery || {};
    const createdAt = timestamp(order.createdAt ?? row.order_created_at);
    if (createdAt === null || createdAt > now || createdAt < filters.start.getTime() || createdAt > filters.end.getTime()) continue;
    const status = statusOf({ order, delivery });
    const source = commercialSource(order);
    const type = typeof order.type === 'string' ? order.type : '';
    const driverId = delivery.driverId || order.driverId || order.bikeId || null;
    const mode = row.mode || (driverId ? 'internal' : null);
    if (filters.status && status !== filters.status || filters.source && source !== filters.source || filters.type && type !== filters.type || filters.driverId && driverId !== filters.driverId || filters.mode && mode !== filters.mode || filters.providerId && row.providerId !== filters.providerId) continue;
    selected.push({ row, order, delivery, status, source, type, driverId, mode });
  }
  if (selected.length > MAX_ROWS) fail('Recorte excede o limite permitido.');
  const cells = new Map(); let located = 0, lowPrecision = 0;
  for (const item of selected) {
    const lat = item.row.latitude == null ? null : Number(item.row.latitude), lon = item.row.longitude == null ? null : Number(item.row.longitude);
    const valid = Number.isFinite(lat) && lat >= -90 && lat <= 90 && Number.isFinite(lon) && lon >= -180 && lon <= 180;
    if (!valid) continue;
    const accuracy = numeric(item.row.accuracyM);
    if (accuracy !== null && accuracy > MAX_MAP_ACCURACY_M) { lowPrecision++; continue; }
    located++;
    const key = geohash(lat, lon);
    const cell = cells.get(key) || { count: 0, completed: 0, cancelled: 0, failed: 0, internal: 0, external: 0, actualDistances: [], estimatedDistances: [], durations: [], fees: [], providers: new Map() };
    cell.count++;
    if (item.status === 'DELIVERED') cell.completed++;
    if (item.status === 'CANCELLED') cell.cancelled++;
    if (item.status === 'FAILED') cell.failed++;
    if (item.mode === 'internal') cell.internal++;
    if (item.mode === 'external') cell.external++;
    const provider = item.row.providerId ? String(item.row.providerCode || 'provider') : null;
    if (provider) cell.providers.set(provider, (cell.providers.get(provider) || 0) + 1);
    const actualM = numeric(item.delivery.actualDistanceM) ?? (numeric(item.order.gpsDistanceKm) === null ? null : numeric(item.order.gpsDistanceKm) * 1000);
    const estimatedM = numeric(item.delivery.estimatedDistanceM) ?? (numeric(item.order.km) === null ? null : numeric(item.order.km) * 1000);
    if (actualM !== null && actualM <= 1000000) cell.actualDistances.push(actualM / 1000);
    if (estimatedM !== null && estimatedM <= 1000000) cell.estimatedDistances.push(estimatedM / 1000);
    const start = timestamp(item.delivery.assignedAt), end = timestamp(item.delivery.completedAt);
    if (item.status === 'DELIVERED' && start !== null && end !== null && end >= start && end - start <= 30 * 86400000) cell.durations.push((end - start) / 60000);
    const fee = deliveryFee(item.order); if (fee !== null) cell.fees.push(fee);
    cells.set(key, cell);
  }
  const visible = [...cells.entries()].filter(([, value]) => value.count >= MIN_CELL_SAMPLE).map(([key, value]) => ({
    cell: key, ...cellCenter(key), countBand: band(value.count),
    completed: value.completed >= MIN_CELL_SAMPLE ? value.completed : null,
    cancelled: value.cancelled >= MIN_CELL_SAMPLE ? value.cancelled : null,
    failed: value.failed >= MIN_CELL_SAMPLE ? value.failed : null,
    internalFleet: value.internal >= MIN_CELL_SAMPLE ? value.internal : null,
    external: value.external >= MIN_CELL_SAMPLE ? value.external : null,
    completionRate: value.completed + value.cancelled + value.failed >= MIN_CELL_SAMPLE ? value.completed / (value.completed + value.cancelled + value.failed) : null,
    averageActualDistanceKm: metricAverage(value.actualDistances), averageEstimatedDistanceKm: metricAverage(value.estimatedDistances),
    averageDurationMinutes: metricAverage(value.durations), averageDeliveryFeeBRL: metricAverage(value.fees),
    providers: [...value.providers.entries()].filter(([, count]) => count >= MIN_CELL_SAMPLE).map(([code, count]) => ({ code, countBand: band(count) }))
  }));
  const metricValue = cell => filters.metric === 'delivery_fee' ? cell.averageDeliveryFeeBRL
    : filters.metric === 'duration' ? cell.averageDurationMinutes
      : filters.metric === 'actual_distance' ? cell.averageActualDistanceKm
        : filters.metric === 'estimated_distance' ? cell.averageEstimatedDistanceKm
          : Number(cell.countBand === '5–9' ? 7 : cell.countBand === '10–24' ? 17 : 25);
  const values = visible.map(metricValue).filter(Number.isFinite).sort((a,b)=>a-b);
  const low=values[0] ?? 0, high=values.at(-1) ?? 0;
  for (const cell of visible) {
    const value = metricValue(cell);
    cell.intensity = value == null ? 0 : high === low ? 2 : value <= low + (high-low)/3 ? 1 : value >= high - (high-low)/3 ? 3 : 2;
  }
  visible.sort((a,b) => b.intensity - a.intensity || a.cell.localeCompare(b.cell));
  return Object.freeze({ algorithm: 'geohash5-v1', minimumSample: MIN_CELL_SAMPLE, maximumMapAccuracyM:MAX_MAP_ACCURACY_M, metric: filters.metric,
    period: filters.period, totalEligible: selected.length, withLocation: located, withoutLocation: selected.length - located,
    lowPrecision, coverage: selected.length ? located / selected.length : null, suppressedCells: cells.size - visible.length,
    cells: visible, source: 'server-aggregate', generatedAt: new Date(now).toISOString() });
}
module.exports = Object.freeze({ ALPHABET, CELL_PRECISION, MIN_CELL_SAMPLE, MAX_ROWS, geohash, cellCenter, normalizeFilters, aggregate });
