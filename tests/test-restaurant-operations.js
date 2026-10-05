'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../contract.js');
const Contract = globalThis.RotaMotoContract;
const Operations = require('../restaurant-operations.js');
const createdAt = '2026-10-04T10:00:00.000Z';
const base = { id: 'd_local', companyId: 'company_1', orderId: 'o_local', status: 'ASSIGNED', createdAt, updatedAt: createdAt, version: 2 };

const order = Operations.canonicalOrder({
  id: 'o_local', companyId: 'company_1', createdAt, updatedAt: createdAt, num: '42',
  customer: 'Ana', obs: 'Portaria', channel: 'ifood', bike: 'Driver name',
  location: { latitude: 1 }, accessToken: 'must-not-sync', sourceData: { orderId: 'external-1', password: 'must-not-sync', items: [{ name: 'meal', token: 'must-not-sync' }] }, version: 3,
}, 'company_fallback');
assert.equal(order.number, '42');
assert.equal(order.notes, 'Portaria');
assert.equal(order.source, 'ifood');
assert.equal(Operations.canonicalOrder({ id: 'o-canonical', createdAt, updatedAt: createdAt,
  sync: { state: 'local', version: 2, canonicalId: 'o-canonical', canonicalVersion: 1 } }, 'company_1').baseVersion, 1,
  'changed imported Orders carry their last observed canonical revision');
assert.equal(Contract.validateEntity('Order', Operations.canonicalOrder({ id: 'o-canonical', createdAt, updatedAt: createdAt,
  sync: { state: 'local', version: 2, canonicalVersion: 1 } }, 'company_1')).valid, true,
  'canonical revision metadata is part of the shared update contract');
assert.equal(order.bike, undefined);
assert.equal(order.accessToken, undefined);
assert.equal(order.extensions.x_restaurante_source_data.orderId, 'external-1');
assert.equal(order.extensions.x_restaurante_source_data.password, undefined);
assert.equal(order.extensions.x_restaurante_source_data.items[0].token, undefined);
assert.equal(Operations.canonicalOrder({ id: 'o2', createdAt, updatedAt: createdAt, sourceData: '{\"password\":\"raw-secret\"}' }, 'company_1').extensions, undefined);
assert.equal(Contract.validateEntity('Order', order).valid, true);

const driver = Operations.canonicalDriver({
  id: 'driver_1', companyId: 'company_1', createdAt, updatedAt: createdAt, version: 1,
  name: 'Bia', phone: '555', status: 'AVAILABLE', latitude: -23.5, coords: [-23.5, -46.6],
  presence: { inside: true }, location: 'private GPS',
}, 'company_fallback');
assert.equal(driver.latitude, undefined);
assert.equal(driver.coords, undefined);
assert.equal(driver.presence, undefined);
assert.equal(Operations.canonicalDriver({ id: 'driver-canonical', createdAt, updatedAt: createdAt,
  sync: { state: 'local', version: 2, canonicalVersion: 1 } }, 'company_1').baseVersion, 1);
assert.equal(Contract.validateEntity('Driver', driver).valid, true);

const delivery = Operations.canonicalDelivery({ ...base, driverId: 'driver_1' }, { id: 'o_local', deliveryId: 'd_local', companyId: 'company_1', createdAt, updatedAt: createdAt, version: 2, bikeId: 'driver_1' }, 'company_1');
assert.equal(delivery.driverId, 'driver_1');
assert.equal(Operations.canonicalDelivery({ ...base, sync: { state: 'local', version: 2, canonicalVersion: 1 } },
  { id: 'o_local', deliveryId: 'd_local', companyId: 'company_1', createdAt, updatedAt: createdAt, version: 2 }, 'company_1').baseVersion, 1);
assert.equal(Contract.validateEntity('Delivery', delivery).valid, true);
assert.equal(Operations.plannedDeliveryStatus({ status: 'AGUARDANDO' }, 'OUT_FOR_DELIVERY', 'CREATED'), 'CREATED');
assert.equal(Operations.plannedDeliveryStatus({ status: 'FINALIZADA' }, 'FAILED', 'DELIVERED'), 'FAILED');
assert.equal(Operations.plannedDeliveryStatus({ deliveryStatus: 'REDELIVERY' }, 'FAILED', 'FAILED'), 'REDELIVERY');
assert.equal(Operations.plannedDeliveryStatus({ status: 'CANCELADA' }, null, 'CREATED'), 'CANCELLED');

const route = Operations.canonicalRoute({ id: 'route_1', createdAt, updatedAt: createdAt, version: 1, deliveryIds: ['d_local'], internalCache: true }, 'company_fallback');
assert.equal(route.internalCache, undefined);
assert.equal(route.companyId, 'company_fallback');
assert.equal(Operations.canonicalRoute({ id: 'route-canonical', createdAt, updatedAt: createdAt, version: 2,
  deliveryIds: [], sync: { state: 'local', version: 2, canonicalVersion: 1 } }, 'company_1').baseVersion, 1);
assert.equal(Contract.validateEntity('Route', route).valid, true);
const deliveries = [{ ...base, sync: { canonicalId: 'd_canonical' } }];
assert.equal(Operations.validateRouteMembership(null, ['d_local'], deliveries, [], 'company_1'), true);
assert.equal(Operations.validateRouteMembership(null, ['d_canonical'], deliveries, [], 'company_1'), true);
assert.throws(() => Operations.validateRouteMembership(null, ['d_local', 'd_canonical'], deliveries, [], 'company_1'), /duas vezes/);
assert.throws(() => Operations.validateRouteMembership(null, ['d_local'], [{ ...base, companyId: 'company_2' }], [], 'company_1'), /outra empresa/);
assert.throws(() => Operations.validateRouteMembership(null, ['d_local'], [{ ...base, status: 'DELIVERED' }], [], 'company_1'), /finalizadas/);
assert.equal(Operations.validateRouteMembership({ id: 'route_current', deliveryIds: ['d_local'] }, ['d_local'], [{ ...base, status: 'DELIVERED' }], [], 'company_1'), true);
assert.throws(() => Operations.validateRouteMembership(null, ['d_local'], deliveries, [{ id: 'route_old', deliveryIds: ['d_canonical'] }], 'company_1'), /outra rota ativa/);
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const routeEditor = appSource.slice(appSource.indexOf('function openRouteEditor'), appSource.indexOf('function revenueChart'));
assert.match(routeEditor, /addEventListener\('submit',async submitEvent=>/);
assert.match(routeEditor, /event\('success',current\?/);
assert.equal(Operations.minorUnitsFromDecimal(12.345), 1235);
assert.equal(Operations.minorUnitsFromDecimal(Number.MAX_VALUE), null);
assert.equal(Operations.minorUnitsFromDecimal('invalid'), null);
console.log('Restaurant canonical operations projections and route planning validation: OK');
