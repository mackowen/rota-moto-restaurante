(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoRestaurantOperations = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
  const timestamp = value => {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
    const parsed = Date.parse(value || '');
    return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
  };
  const canonicalBaseVersion = record => {
    const version = Number(record?.sync?.canonicalVersion);
    return Number.isSafeInteger(version) && version > 0 ? { baseVersion: version } : {};
  };

  function safeSourceExtension(value, depth = 0) {
    if (depth > 5) return undefined;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') return value.slice(0, 4000);
    if (Array.isArray(value)) return value.slice(0, 100).map(item => safeSourceExtension(item, depth + 1)).filter(item => item !== undefined);
    if (!value || typeof value !== 'object') return undefined;
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/password|secret|token|authorization|cookie|signature|api[_-]?key|credential/iu.test(key)) continue;
      const safe = safeSourceExtension(item, depth + 1);
      if (safe !== undefined) result[key.slice(0, 120)] = safe;
    }
    return result;
  }

  function canonicalOrder(order, companyId) {
    const record = {
      id: order.id,
      companyId: order.companyId || companyId,
      createdAt: timestamp(order.createdAt),
      updatedAt: timestamp(order.updatedAt || order.createdAt),
      version: Math.max(1, Number(order.version || 0), Number(order.sync?.version || 0)),
      ...canonicalBaseVersion(order),
    };
    const fields = {
      number: order.number ?? order.num,
      customer: order.customer,
      phone: order.phone,
      address: order.address,
      notes: order.notes ?? order.obs,
      source: typeof order.source === 'string' ? order.source : (order.sourceId || order.source?.origin || order.channel),
      externalId: order.externalId || order.source?.id,
      money: order.money,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'string' && value.trim()) record[key] = value.trim();
      else if (key === 'customer' && value && typeof value === 'object' && !Array.isArray(value)) record[key] = value;
      else if (key === 'money' && value && typeof value === 'object') record[key] = value;
    }
    if (Array.isArray(order.items)) record.items = order.items;
    if (Array.isArray(order.payments)) record.payments = order.payments;
    if (Number.isSafeInteger(order.amountMinor)) record.amountMinor = order.amountMinor;
    if (typeof order.currency === 'string' && /^[A-Z]{3}$/u.test(order.currency)) record.currency = order.currency;
    if (order.sourceData !== undefined && order.sourceData !== null) {
      let sourceValue = order.sourceData;
      if (typeof sourceValue === 'string') {
        try { sourceValue = JSON.parse(sourceValue); } catch (_) { sourceValue = null; }
      }
      const sourceData = safeSourceExtension(sourceValue);
      if (sourceData && typeof sourceData === 'object' && !Array.isArray(sourceData) && Object.keys(sourceData).length && JSON.stringify(sourceData).length <= 32768) {
        record.extensions = { x_restaurante_source_data: sourceData };
      }
    }
    if (order.deletedAt) record.deletedAt = timestamp(order.deletedAt);
    return record;
  }

  function canonicalDriver(driver, companyId) {
    const record = {
      id: driver.id,
      companyId: driver.companyId || companyId,
      createdAt: timestamp(driver.createdAt),
      updatedAt: timestamp(driver.updatedAt || driver.createdAt),
      version: Math.max(1, Number(driver.version || 0), Number(driver.sync?.version || 0)),
      ...canonicalBaseVersion(driver),
    };
    for (const key of ['name', 'phone', 'email', 'status']) {
      if (typeof driver[key] === 'string' && driver[key].trim()) record[key] = driver[key].trim();
    }
    if (driver.deletedAt) record.deletedAt = timestamp(driver.deletedAt);
    return record;
  }

  function plannedDeliveryStatus(order, savedStatus, generatedStatus) {
    const local = order?.deliveryStatus || order?.canonicalStatus || order?.status;
    const mapped = ({ AGUARDANDO: 'CREATED', ATRIBUIDA: 'ASSIGNED', 'EM ROTA': 'OUT_FOR_DELIVERY',
      CHEGOU: 'ARRIVED', FINALIZADA: 'DELIVERED', CANCELADA: 'CANCELLED' })[local] || local;
    if (['CREATED', 'ASSIGNED', 'CANCELLED', 'REDELIVERY'].includes(mapped)) return mapped;
    return savedStatus || mapped || generatedStatus || 'CREATED';
  }

  function canonicalDelivery(delivery, order, companyId) {
    const record = {
      id: delivery.id || order.deliveryId,
      companyId: order.companyId || delivery.companyId || companyId,
      orderId: order.id,
      status: delivery.status || order.canonicalStatus || 'CREATED',
      createdAt: timestamp(delivery.createdAt || order.createdAt),
      updatedAt: timestamp(order.updatedAt || delivery.updatedAt || order.createdAt),
      version: Math.max(1, Number(delivery.version || 0), Number(order.version || 0), Number(order.sync?.version || 0)),
      ...canonicalBaseVersion(delivery),
    };
    const driverId = order.bikeId || order.driverId || delivery.driverId;
    if (typeof driverId === 'string' && driverId) record.driverId = driverId;
    if (delivery.priority === 'HIGH' || delivery.priority === 'NORMAL') record.priority = delivery.priority;
    if (delivery.assignedAt) record.assignedAt = timestamp(delivery.assignedAt);
    const distance = Number(delivery.estimatedDistanceM ?? order.km * 1000);
    if (Number.isFinite(distance) && distance >= 0) record.estimatedDistanceM = distance;
    if (delivery.deletedAt) record.deletedAt = timestamp(delivery.deletedAt);
    return record;
  }

  function canonicalRoute(route, companyId) {
    return {
      id: route.id,
      companyId: route.companyId || companyId,
      createdAt: timestamp(route.createdAt),
      updatedAt: timestamp(route.updatedAt || route.createdAt),
      version: Math.max(1, Number(route.version || 0), Number(route.sync?.version || 0)),
      ...canonicalBaseVersion(route),
      deliveryIds: Array.isArray(route.deliveryIds) ? [...route.deliveryIds] : [],
      ...(Array.isArray(route.stops) ? { stops: route.stops } : {}),
      ...(route.origin && typeof route.origin === 'object' && !Array.isArray(route.origin) ? { origin: route.origin } : {}),
      ...(typeof route.status === 'string' ? { status: route.status } : {}),
      ...(route.deletedAt ? { deletedAt: timestamp(route.deletedAt) } : {}),
    };
  }

  function validateRouteMembership(route, deliveryIds, deliveries, routes, companyId) {
    if (!Array.isArray(deliveryIds) || deliveryIds.length > 500) throw new Error('Selecione até 500 entregas para a rota.');
    if (new Set(deliveryIds).size !== deliveryIds.length) throw new Error('A mesma entrega não pode aparecer duas vezes na rota.');
    const deliveryById = new Map();
    for (const delivery of deliveries || []) {
      deliveryById.set(delivery.id, delivery);
      if (delivery.sync?.canonicalId) deliveryById.set(delivery.sync.canonicalId, delivery);
      if (delivery.canonicalId) deliveryById.set(delivery.canonicalId, delivery);
    }
    const normalizedIds = deliveryIds.map(id => deliveryById.get(id)?.id || id);
    if (new Set(normalizedIds).size !== normalizedIds.length) throw new Error('A mesma entrega não pode aparecer duas vezes na rota.');
    for (const id of deliveryIds) {
      const delivery = deliveryById.get(id);
      if (!delivery || delivery.deleted || delivery.deletedAt) throw new Error('A rota contém uma entrega inexistente ou removida.');
      if (delivery.companyId && delivery.companyId !== companyId) throw new Error('A rota não pode incluir entrega de outra empresa.');
      const orderStatus = delivery.status;
      const retainedInCurrentRoute = route && (route.deliveryIds || []).some(existingId => (deliveryById.get(existingId)?.id || existingId) === delivery.id);
      if (['DELIVERED', 'CANCELLED'].includes(orderStatus) && !retainedInCurrentRoute) throw new Error('Entregas finalizadas ou canceladas não podem entrar em uma rota ativa.');
      const owner = (routes || []).find(candidate => candidate.id !== route?.id && !candidate.deleted && !candidate.deletedAt && (candidate.deliveryIds || []).some(existingId => (deliveryById.get(existingId)?.id || existingId) === delivery.id));
      if (owner) throw new Error('Uma entrega já pertence a outra rota ativa. Remova-a do outro planejamento primeiro.');
    }
    return true;
  }

  function localIdForDelivery(order, delivery) {
    return delivery?.id || order?.deliveryId;
  }

  function findOrderForDeliveryId(id, orders, deliveries) {
    const delivery = (deliveries || []).find(row => row.id === id || row.canonicalId === id || row.sync?.canonicalId === id);
    return (orders || []).find(order => order.deliveryId === id || order.deliveryId === delivery?.id || order.id === delivery?.orderId || order.sync?.canonicalId === id) || null;
  }

  function minorUnitsFromDecimal(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return null;
    const minor = Math.round((amount + Number.EPSILON) * 100);
    return Number.isSafeInteger(minor) ? minor : null;
  }

  return Object.freeze({ canonicalOrder, canonicalDriver, canonicalDelivery, plannedDeliveryStatus, canonicalRoute,
    validateRouteMembership, localIdForDelivery, findOrderForDeliveryId, minorUnitsFromDecimal });
});
