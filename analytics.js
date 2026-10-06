(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATA_DICTIONARY = Object.freeze({
    orders: { name: 'Pedidos', source: 'Order.createdAt/status/type/source', formula: 'contagem de Orders no período de criação e filtros selecionados', unit: 'pedidos', states: 'todos os estados conhecidos; status ausente fica em “desconhecido”', period: 'Order.createdAt (janela móvel)', missing: 'data inválida é excluída e contada como incompleta', limits: 'origem é comercial, não provider logístico' },
    deliveryFees: { name: 'Taxas de entrega', source: 'Order.deliveryFee; legado Order.value', formula: 'soma/média de taxas válidas apenas para Deliveries concluídas', unit: 'BRL', currency: 'BRL', states: 'DELIVERED e taxa válida', period: 'coorte por Order.createdAt', missing: 'taxa ausente/inválida é excluída do denominador e reduz cobertura', limits: 'não é faturamento de produtos nem valor integral do pedido' },
    orderTicket: { name: 'Ticket médio do pedido', source: 'Order.amountMinor + Order.currency', formula: 'média convertida da unidade mínima ISO 4217 por moeda, somente valores válidos', unit: 'valor médio por pedido', currency: 'agrupado por ISO 4217; moedas nunca são somadas', states: 'qualquer Order do recorte com montante canônico válido', period: 'coorte por Order.createdAt', missing: 'excluído do denominador e indicado na cobertura', limits: 'o contrato não define se montante inclui taxa de entrega; não denominar faturamento de produtos' },
    driverPayout: { name: 'Repasse registrado', source: 'Earning.amountMinor/currency', formula: 'soma/média de Earnings BRL válidos associados às Deliveries do recorte', unit: 'BRL', currency: 'BRL', states: 'Earning ligado a Delivery do recorte', period: 'coorte por Order.createdAt; não por data de pagamento', missing: 'Earning ausente não vira zero; cobertura por entregas associadas', limits: 'repasse ao Driver, não custo operacional integral' },
    estimatedDistance: { name: 'Distância estimada', source: 'Delivery.estimatedDistanceM; legado Order.km', formula: 'média e soma apenas de valores não negativos válidos', unit: 'km', states: 'Deliveries do recorte', period: 'coorte por Order.createdAt', missing: 'excluído e contado como indisponível', limits: 'Route ou estimativa local não é distância percorrida' },
    actualDistance: { name: 'Distância real', source: 'Delivery.actualDistanceM; legado Order.gpsDistanceKm', formula: 'média e soma apenas de distâncias reais válidas', unit: 'km', states: 'Deliveries do recorte', period: 'coorte por Order.createdAt', missing: 'excluído e contado como indisponível', limits: 'cobertura depende de telemetria/projeção sincronizada' },
    durations: { name: 'Tempos operacionais', source: 'Delivery timestamps; fallback de DeliveryEvent único por tipo', formula: 'fim − início para cada etapa, somente sequência válida e estado compatível', unit: 'minutos', states: 'apenas estados que alcançaram o fim da etapa', period: 'coorte por Order.createdAt', missing: 'par ausente, sequência invertida ou ambígua é excluída', limits: 'não mede preparação nem SLA; timestamps dependem de clocks dos dispositivos' },
    status: { name: 'Status e conclusão', source: 'Delivery.status; legado Order.status', formula: 'contagens por estado atual; conclusão = DELIVERED / estados reconhecidos no recorte', unit: 'entregas e percentual', states: 'abertas incluem somente estados operacionais ativos; canceladas/falhas/retornadas são terminais', period: 'coorte por Order.createdAt', missing: 'estado desconhecido não é contado como aberto nem entra no denominador de conclusão', limits: 'não é histórico de transições nem SLA/on-time' },
    deliveryType: { name: 'Tipo de entrega', source: 'Order.type local', formula: 'contagem de Orders por tipo registrado', unit: 'pedidos', states: 'todos os estados', period: 'coorte por Order.createdAt', missing: 'tipo ausente não entra em distribuição por tipo', limits: 'valores locais legados podem não ter mapeamento canônico completo' },
    commercialSource: { name: 'Origem comercial', source: 'Order.sourceId/source.origin/source/channel', formula: 'contagem de Orders por chave comercial normalizada', unit: 'pedidos', states: 'todos os estados', period: 'coorte por Order.createdAt', missing: 'origem ausente recebe “Sem origem registrada”', limits: 'não representa a origem logística/provider' },
    driverPerformance: { name: 'Desempenho por Driver', source: 'Order.bikeId/driverId e status da Delivery', formula: 'contagens por Driver; métricas financeiras/distâncias mantêm seus denominadores próprios', unit: 'pedidos/entregas', states: 'status atual conhecido', period: 'coorte por Order.createdAt', missing: 'Driver ausente fica em “Não atribuído”', limits: 'não avalia qualidade, custo total ou SLA' },
    customerRecurrence: { name: 'Recorrência por cliente', source: 'Order.customer local', formula: 'contagem textual de pedidos por nome com espaços colapsados e caixa ignorada', unit: 'pedidos/clientes', states: 'Orders com nome presente', period: 'Order.createdAt', missing: 'nome ausente fica fora da recorrência; não substitui identidade canônica', limits: 'nomes iguais podem ser pessoas diferentes; dado pessoal exibido somente no relatório autorizado' },
    addressRecurrence: { name: 'Recorrência por endereço', source: 'Order.address local', formula: 'contagem textual com espaços colapsados e caixa ignorada', unit: 'pedidos/endereços', states: 'Orders com endereço presente', period: 'Order.createdAt', missing: 'endereço ausente fica fora do agrupamento', limits: 'não é região geográfica nem heatmap; grafias distintas não são conciliadas' },
    hourlyVolume: { name: 'Volume por hora local', source: 'Order.createdAt', formula: 'contagem por hora civil no timezone IANA da Company', unit: 'pedidos', states: 'todos os estados', period: 'coorte por Order.createdAt', missing: 'indisponível sem timezone operacional válido', limits: 'não inferir timezone do aparelho/servidor' },
    weekdayVolume: { name: 'Volume por dia da semana local', source: 'Order.createdAt', formula: 'contagem por dia civil no timezone IANA da Company', unit: 'pedidos', states: 'todos os estados', period: 'coorte por Order.createdAt', missing: 'indisponível sem timezone operacional válido', limits: 'não inferir timezone do aparelho/servidor' },
  });

  const ORDER_TO_DELIVERY = Object.freeze({ AGUARDANDO: 'CREATED', ATRIBUIDA: 'ASSIGNED', 'EM ROTA': 'OUT_FOR_DELIVERY', CHEGOU: 'ARRIVED', FINALIZADA: 'DELIVERED', CANCELADA: 'CANCELLED', ACCEPTED: 'ACCEPTED', PICKED_UP: 'PICKED_UP', FAILED: 'FAILED', RETURNED: 'RETURNED', REDELIVERY: 'REDELIVERY' });
  const COMPLETED = new Set(['DELIVERED']);
  const OPEN_STATUSES = new Set(['CREATED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'REDELIVERY']);
  const KNOWN_STATUSES = new Set(['CREATED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED', 'REDELIVERY']);

  function timestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  function finiteNonNegative(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
  }
  function canonicalStatus(delivery, order) {
    const raw = delivery?.status || order?.deliveryStatus || order?.canonicalStatus || order?.status;
    const normalized = String(raw || '').trim().toUpperCase();
    return ORDER_TO_DELIVERY[normalized] || (['CREATED', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'CANCELLED', 'FAILED', 'RETURNED', 'REDELIVERY'].includes(normalized) ? normalized : 'UNKNOWN');
  }
  function validCurrency(code) { return typeof code === 'string' && /^[A-Z]{3}$/.test(code); }
  function currencyDivisor(currency) {
    if (!validCurrency(currency)) return null;
    try {
      if (typeof Intl.supportedValuesOf !== 'function' || !Intl.supportedValuesOf('currency').includes(currency)) return null;
      const fractionDigits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
      return 10 ** fractionDigits;
    } catch (_) { return null; }
  }
  function sumAverage(values) {
    if (!values.length) return { total: null, average: null, count: 0 };
    const total = values.reduce((sum, n) => sum + n, 0);
    return Number.isFinite(total) ? { total, average: total / values.length, count: values.length } : { total: null, average: null, count: 0 };
  }
  function validTimezone(zone) {
    if (typeof zone !== 'string' || !zone.trim()) return false;
    try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(0); return true; } catch (_) { return false; }
  }
  function localParts(at, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(at);
    return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  }
  function eventTimestamp(events, delivery, types) {
    if (!delivery?.id) return null;
    const matches = (events || []).filter(e => (e.entityId === delivery.id || e.deliveryId === delivery.id) && types.includes(String(e.type || '').toUpperCase()));
    if (matches.length !== 1) return null;
    return timestamp(matches[0].occurredAt);
  }
  function aggregate(input = {}, options = {}) {
    const now = timestamp(options.now) ?? Date.now();
    const period = options.period === 'all' ? null : Number(options.period);
    const periodDays = Number.isFinite(period) && period > 0 ? period : 30;
    const cutoff = period === null ? null : now - periodDays * 86400000;
    const deliveries = input.deliveries || [];
    const events = input.deliveryEvents || [];
    const allOrders = (input.orders || []).filter(o => !o.deleted && !o.deletedAt);
    const deliveriesByOrder = new Map();
    const deliveriesById = new Map();
    for (const d of deliveries) {
      if (d?.id) deliveriesById.set(d.id, d);
      if (d?.orderId) deliveriesByOrder.set(d.orderId, d);
    }
    const normalized = [];
    let invalidCreatedAt = 0;
    for (const order of allOrders) {
      const createdAt = timestamp(order.createdAt);
      if (createdAt === null || createdAt > now) { invalidCreatedAt++; continue; }
      if (cutoff !== null && createdAt < cutoff) continue;
      const delivery = deliveriesById.get(order.deliveryId) || deliveriesByOrder.get(order.id) || null;
      const status = canonicalStatus(delivery, order);
      const driverId = delivery?.driverId || order.driverId || order.bikeId || '';
      const driverName = order.bike || (input.drivers || []).find(d => d.id === driverId)?.name || (input.bikes || []).find(d => d.id === driverId)?.name || '';
      const source = [order.sourceId, typeof order.source === 'string' ? order.source : order.source?.origin, order.channel].find(value => typeof value === 'string' && value.trim()) || '';
      const rawFee = order.deliveryFee !== undefined && order.deliveryFee !== null ? order.deliveryFee : order.value;
      const fee = finiteNonNegative(rawFee);
      const feeCurrency = order.deliveryFeeCurrency || 'BRL';
      const hasEstimatedM = delivery?.estimatedDistanceM !== null && delivery?.estimatedDistanceM !== undefined;
      const hasActualM = delivery?.actualDistanceM !== null && delivery?.actualDistanceM !== undefined;
      const estimatedM = finiteNonNegative(delivery?.estimatedDistanceM);
      const actualM = finiteNonNegative(delivery?.actualDistanceM);
      const estimatedDistanceKm = hasEstimatedM ? (estimatedM === null ? null : estimatedM / 1000) : finiteNonNegative(order.km);
      const actualDistanceKm = hasActualM ? (actualM === null ? null : actualM / 1000) : finiteNonNegative(order.gpsDistanceKm);
      normalized.push({ order, delivery, createdAt, status, driverId, driverName, source: source.trim() || 'unknown', deliveryFeeBRL: feeCurrency === 'BRL' ? fee : null, estimatedDistanceKm, actualDistanceKm });
    }
    const filtered = normalized.filter(row => (!options.driver || row.driverName === options.driver || row.driverId === options.driver)
      && (!options.status || row.status === (ORDER_TO_DELIVERY[String(options.status).toUpperCase()] || String(options.status).toUpperCase()))
      && (!options.type || row.order.type === options.type)
      && (!options.source || row.source === options.source));

    const completed = filtered.filter(row => COMPLETED.has(row.status));
    const feeValues = [];
    let feeMissing = 0;
    for (const row of completed) {
      if (row.deliveryFeeBRL === null) { feeMissing++; continue; }
      feeValues.push(row.deliveryFeeBRL);
    }
    const fee = sumAverage(feeValues);

    const ticketValues = {};
    let ticketMissing = 0;
    for (const row of filtered) {
      const minor = row.order.amountMinor;
      const currency = row.order.currency;
      if (!Number.isSafeInteger(minor) || minor < 0 || !validCurrency(currency)) { ticketMissing++; continue; }
      const divisor = currencyDivisor(currency);
      if (!divisor) { ticketMissing++; continue; }
      (ticketValues[currency] ||= []).push(minor / divisor);
    }
    const orderTicket = Object.fromEntries(Object.entries(ticketValues).map(([currency, values]) => [currency, sumAverage(values)]));

    const earningsByDelivery = new Map();
    const deliveryAliases = new Map();
    for (const row of filtered) {
      const canonicalId = row.delivery?.id || row.order.deliveryId;
      if (!canonicalId) continue;
      for (const id of [row.delivery?.id, row.delivery?.canonicalId, row.delivery?.sync?.canonicalId, row.order.deliveryId].filter(Boolean)) deliveryAliases.set(id, canonicalId);
    }
    for (const earning of input.earnings || []) {
      const deliveryId = deliveryAliases.get(earning.deliveryId);
      if (!deliveryId || !Number.isSafeInteger(earning.amountMinor) || earning.amountMinor < 0 || earning.currency !== 'BRL') continue;
      const rows = earningsByDelivery.get(deliveryId) || [];
      rows.push(earning.amountMinor / 100);
      earningsByDelivery.set(deliveryId, rows);
    }
    const earningValues = [...earningsByDelivery.values()].map(values => values.reduce((sum, n) => sum + n, 0)).filter(Number.isFinite);
    const earnings = sumAverage(earningValues);
    const earningScope = new Set(filtered.map(row => row.delivery?.id || row.order.deliveryId).filter(Boolean));

    const estimateValues = [];
    const actualValues = [];
    let estimatedMissing = 0;
    let actualMissing = 0;
    for (const row of filtered) {
      const estimateKm = row.estimatedDistanceKm;
      if (estimateKm === null) estimatedMissing++; else estimateValues.push(estimateKm);
      const actualKm = row.actualDistanceKm;
      if (actualKm === null) actualMissing++; else actualValues.push(actualKm);
    }
    const estimatedDistance = sumAverage(estimateValues);
    const actualDistance = sumAverage(actualValues);

    const durationStages = [
      ['assignedToAccepted', 'assignedAt', ['DELIVERY_ASSIGNED', 'ASSIGNED'], 'acceptedAt', ['DELIVERY_ACCEPTED', 'ACCEPTED'], new Set(['ACCEPTED', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED'])],
      ['acceptedToPickedUp', 'acceptedAt', ['DELIVERY_ACCEPTED', 'ACCEPTED'], 'pickedUpAt', ['DELIVERY_PICKED_UP', 'PICKED_UP', 'DELIVERY_STARTED'], new Set(['PICKED_UP', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED'])],
      ['pickedUpToArrived', 'pickedUpAt', ['DELIVERY_PICKED_UP', 'PICKED_UP', 'DELIVERY_STARTED'], 'arrivedAt', ['DELIVERY_ARRIVED', 'ARRIVED'], new Set(['ARRIVED', 'DELIVERED'])],
      ['arrivedToCompleted', 'arrivedAt', ['DELIVERY_ARRIVED', 'ARRIVED'], 'completedAt', ['DELIVERY_COMPLETED', 'DELIVERED', 'COMPLETED'], new Set(['DELIVERED'])],
      ['assignedToCompleted', 'assignedAt', ['DELIVERY_ASSIGNED', 'ASSIGNED'], 'completedAt', ['DELIVERY_COMPLETED', 'DELIVERED', 'COMPLETED'], new Set(['DELIVERED'])],
    ];
    const durations = {};
    for (const [key, startField, startTypes, endField, endTypes, allowedStatuses] of durationStages) {
      const values = [];
      let missing = 0;
      let eligible = 0;
      for (const row of filtered) {
        if (!allowedStatuses.has(row.status)) continue;
        eligible++;
        const d = row.delivery;
        const start = timestamp(d?.[startField]) ?? eventTimestamp(events, d, startTypes);
        const end = timestamp(d?.[endField]) ?? eventTimestamp(events, d, endTypes);
        if (start === null || end === null || end < start || end > now) { missing++; continue; }
        values.push((end - start) / 60000);
      }
      durations[key] = { ...sumAverage(values), eligible, missing };
    }

    const statusCounts = Object.create(null);
    const typeCounts = Object.create(null);
    const sourceCounts = Object.create(null);
    const driverCounts = Object.create(null);
    const customerGroups = new Map();
    const addressGroups = new Map();
    const hourly = Array(24).fill(0);
    const weekdays = Array(7).fill(0);
    const tz = validTimezone(options.timeZone) ? options.timeZone : null;
    for (const row of filtered) {
      statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
      const type = String(row.order.type || '').trim();
      if (type) typeCounts[type] = (typeCounts[type] || 0) + 1;
      sourceCounts[row.source] = (sourceCounts[row.source] || 0) + 1;
      const driverKey = row.driverId || (row.driverName ? `legacy-name:${row.driverName}` : 'unassigned');
      if (!driverCounts[driverKey]) driverCounts[driverKey] = { id: row.driverId || null, name: row.driverName || 'Não atribuído', total: 0, completed: 0, cancelled: 0, failed: 0 };
      const driver = driverCounts[driverKey];
      driver.total++;
      if (row.status === 'DELIVERED') driver.completed++;
      if (row.status === 'CANCELLED') driver.cancelled++;
      if (row.status === 'FAILED') driver.failed++;
      const customer = String(row.order.customer || '').trim();
      const address = String(row.order.address || '').trim();
      const customerKey = customer.replace(/\s+/gu, ' ').trim().toLowerCase();
      if (customerKey) customerGroups.set(customerKey, { label: customer, count: (customerGroups.get(customerKey)?.count || 0) + 1 });
      if (address) {
        const key = address.replace(/\s+/gu, ' ').trim().toLowerCase();
        const group = addressGroups.get(key) || { label: address, count: 0, statuses: {}, drivers: new Set() };
        group.count++;
        group.statuses[row.status] = (group.statuses[row.status] || 0) + 1;
        if (row.driverName) group.drivers.add(row.driverName);
        addressGroups.set(key, group);
      }
      if (tz) {
        const parts = localParts(row.createdAt, tz);
        hourly[Number(parts.hour)]++;
        weekdays[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)]++;
      }
    }
    const knownStatusCount = filtered.filter(row => KNOWN_STATUSES.has(row.status)).length;
    const open = filtered.filter(row => OPEN_STATUSES.has(row.status)).length;
    return {
      ...(options.includeExportRows ? { exportRows: filtered.map(row => ({ num: row.order.num || row.order.number || '', customer: row.order.customer || '', driverName: row.driverName || 'Não atribuído', status: row.status, type: row.order.type || '', source: row.source === 'unknown' ? 'Sem origem registrada' : row.source, deliveryFeeBRL: row.deliveryFeeBRL, estimatedDistanceKm: row.estimatedDistanceKm, actualDistanceKm: row.actualDistanceKm, createdAt: row.createdAt })) } : {}),
      total: filtered.length, invalidCreatedAt,
      completedCount: completed.length,
      cancelledCount: filtered.filter(row => row.status === 'CANCELLED').length,
      failedCount: filtered.filter(row => row.status === 'FAILED').length,
      returnedCount: filtered.filter(row => row.status === 'RETURNED').length,
      openCount: open,
      completionRate: knownStatusCount ? completed.length / knownStatusCount : null,
      knownStatusCount,
      statusCounts, typeCounts, sourceCounts, driverCounts,
      customerGroups: [...customerGroups.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      distinctCustomerCount: customerGroups.size,
      addressGroups: [...addressGroups.values()].sort((a, b) => b.count - a.count).map(group => ({ ...group, drivers: [...group.drivers] })),
      distinctAddressCount: addressGroups.size,
      coverage: {
        deliveryFee: { available: fee.count, total: completed.length, missing: feeMissing },
        orderAmount: { available: Object.values(orderTicket).reduce((sum, item) => sum + item.count, 0), total: filtered.length, missing: ticketMissing },
        status: { available: knownStatusCount, total: filtered.length, missing: filtered.length - knownStatusCount },
        earning: { available: earnings.count, total: earningScope.size, missing: Math.max(0, earningScope.size - earnings.count) },
        estimatedDistance: { available: estimatedDistance.count, total: filtered.length, missing: estimatedMissing },
        actualDistance: { available: actualDistance.count, total: filtered.length, missing: actualMissing },
      },
      deliveryFees: fee, orderTicket, driverPayout: earnings,
      estimatedDistance, actualDistance, durations,
      hourlyVolume: tz ? hourly : null, weekdayVolume: tz ? weekdays : null,
      timeZone: tz,
      cohort: 'Order.createdAt; rolling UTC interval',
      freshness: options.freshness || 'local snapshot; freshness not proven',
    };
  }

  function csvCell(value) {
    let text = value == null ? '' : String(value);
    if (/^[\u0000-\u0020]*[=+@-]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  }
  function csvRow(values) { return values.map(csvCell).join(','); }

  return Object.freeze({ DATA_DICTIONARY, aggregate, canonicalStatus, timestamp, validTimezone, csvCell, csvRow });
});
