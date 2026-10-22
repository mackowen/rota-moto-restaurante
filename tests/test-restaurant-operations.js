'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../contract.js');
const Contract = globalThis.RotaMotoContract;
const Operations = require('../restaurant-operations.js');
const createdAt = '2026-10-04T10:00:00.000Z';
const base = { id: 'd_local', companyId: 'company_1', orderId: 'o_local', status: 'ASSIGNED', createdAt, updatedAt: createdAt, version: 2 };

for (const source of ['ifood', 'keeta', '99', '99food']) {
  assert.equal(Operations.shouldGenerateDeliveryForOrder({source}, false), false,
    `${source} Order does not fabricate operational Delivery`);
  assert.equal(Operations.shouldGenerateDeliveryForOrder({source,extensions:{x_rotamoto_external_order:{fulfillment:'unknown'}}}, true), false,
    `${source} Order with unknown fulfillment does not gain a Delivery even if a local row is present`);
  assert.equal(Operations.shouldGenerateDeliveryForOrder({source,extensions:{x_rotamoto_external_order:{fulfillment:'merchant'}}}, true), true,
    `${source} Order may retain an explicitly existing local Delivery`);
}
assert.equal(Operations.shouldGenerateDeliveryForOrder({source:'manual'}, false), true,
  'own Orders retain the existing Delivery projection');

const order = Operations.canonicalOrder({
  id: 'o_local', companyId: 'company_1', createdAt, updatedAt: createdAt, num: '42',
  customer: 'Ana', obs: 'Portaria', channel: 'ifood', bike: 'Driver name',
  location: { latitude: 1 }, accessToken: 'must-not-sync', sourceData: { orderId: 'external-1', password: 'must-not-sync', items: [{ name: 'meal', token: 'must-not-sync' }] }, version: 3,
}, 'company_fallback');
assert.equal(order.number, '42');
assert.equal(order.notes, 'Portaria');
assert.equal(order.source, 'ifood');
assert.equal(Operations.canonicalOrder({ id: 'source-priority', createdAt, updatedAt: createdAt,
  sourceId: 'legacy-alias', channel: 'whatsapp', source: { origin: 'ifood' } }, 'company_1').source, 'ifood',
  'canonical commercial source prefers the explicit source object over legacy aliases');
const mergedKnownSource = Operations.mergeCanonicalOrder({ id: 'local-order', source: { origin: 'ifood', id: 'ext-1', status: 'ACCEPTED' },
  sourceId: 'ifood', channel: 'ifood', localOnly: true }, { id: 'canonical-order', source: 'ifood', customer: 'Cliente' });
assert.deepEqual(mergedKnownSource.source, { origin: 'ifood', id: 'ext-1', status: 'ACCEPTED' });
assert.equal(mergedKnownSource.sourceId, 'ifood');
assert.equal(mergedKnownSource.localOnly, true);
const mergedExternal = Operations.mergeCanonicalOrder({ id:'local-provider',source:{origin:'ifood',id:'provider-order-1'},
  sync:{state:'local',version:1} }, { id:'canonical-provider',companyId:'company_1',number:'F-41',source:'ifood',externalId:'provider-order-1',
  status:'AGUARDANDO',extensions:{x_rotamoto_external_order:{providerStatus:'PLACED',displayId:'F-41',fulfillment:'unknown'}} });
assert.equal(mergedExternal.id,'local-provider','provider identity matching preserves the local IndexedDB key');
assert.equal(mergedExternal.num,'F-41');
assert.equal(mergedExternal.externalStatus,'PLACED');
assert.equal(mergedExternal.statusSource,'external');
assert.equal(mergedExternal.sync.state,'local','sync metadata is updated by the reconciliation transaction, not fabricated here');
const revisedExternal = Operations.mergeCanonicalOrder(mergedExternal,{id:'canonical-provider',number:'F-42',source:'ifood',externalId:'provider-order-1',
  extensions:{x_rotamoto_external_order:{providerStatus:'CONFIRMED',displayId:'F-42',fulfillment:'unknown'}}});
assert.equal(revisedExternal.id,'local-provider');assert.equal(revisedExternal.num,'F-42');assert.equal(revisedExternal.externalStatus,'CONFIRMED');
const mergedUnknownSource = Operations.mergeCanonicalOrder({ id: 'local-order', source: { origin: 'whatsapp', id: 'thread-1' },
  sourceId: 'whatsapp', channel: 'whatsapp' }, { id: 'canonical-order', customer: 'Cliente' });
assert.deepEqual(mergedUnknownSource.source, { origin: 'whatsapp', id: 'thread-1' }, 'missing canonical source preserves known local commercial origin');
assert.equal(Operations.mergeCanonicalOrder({ id: 'unknown' }, { id: 'canonical' }).source, undefined,
  'unknown origin stays unknown');
assert.equal(Operations.canonicalOrder({ id: 'logistics-only', createdAt, updatedAt: createdAt,
  logisticsProvider: { code: 'ifood' } }, 'company_1').source, undefined,
  'commercial source is never inferred from the logistics provider');
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
const geoOrder=Operations.canonicalOrder({id:'geo-order',createdAt,updatedAt:createdAt,coords:[-23.5,-46.6]},'company_1');
assert.deepEqual(geoOrder.extensions.x_rotamoto_navigation_coordinates,{latitude:-23.5,longitude:-46.6,provenance:'restaurant_order_coordinates'});
assert.equal(Operations.canonicalOrder({id:'bad-geo-order',createdAt,updatedAt:createdAt,coords:[91,181]},'company_1').extensions,undefined,
  'invalid coordinates are not published as navigation points');
assert.equal(Operations.canonicalOrder({ id: 'o2', createdAt, updatedAt: createdAt, sourceData: '{\"password\":\"raw-secret\"}' }, 'company_1').extensions, undefined);
assert.equal(Contract.validateEntity('Order', order).valid, true);

const driver = Operations.canonicalDriver({
  id: 'driver_1', companyId: 'company_1', createdAt, updatedAt: createdAt, version: 1,
  name: 'Bia', phone: '555', status: 'AVAILABLE', latitude: -23.5, coords: [-23.5, -46.6],
  capacity: { unit:'deliveries',limit:3 }, presence: { inside: true }, location: 'private GPS',
}, 'company_fallback');
assert.equal(driver.latitude, undefined);
assert.equal(driver.coords, undefined);
assert.equal(driver.presence, undefined);
assert.deepEqual(driver.capacity,{unit:'deliveries',limit:3});
const driverContactCleared = Operations.canonicalDriver({ id:'driver-contact-clear',createdAt,updatedAt:createdAt,
  name:'Bia',phone:'  ',email:' ',status:'ACTIVE' },'company_1');
assert.equal(driverContactCleared.phone,'');
assert.equal(driverContactCleared.email,'','clearing an optional Driver contact is represented in the canonical sync packet');
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
assert.equal(Operations.shouldIncludeDeliveryForSync({ orderChangedHere: true, deliveryChangedHere: false, hasLocalDelivery: false, status: 'CREATED' }), true,
  'new locally created Orders still publish their initial Delivery');
assert.equal(Operations.shouldIncludeDeliveryForSync({ orderChangedHere: true, deliveryChangedHere: true, hasLocalDelivery: true, status: 'ASSIGNED' }), true,
  'a locally changed assignment is published');
assert.equal(Operations.shouldIncludeDeliveryForSync({ orderChangedHere: true, deliveryChangedHere: false, hasLocalDelivery: true, status: 'ASSIGNED' }), false,
  'an Order-only edit must not resend an unchanged canonical assignment');
assert.equal(Operations.shouldIncludeDeliveryForSync({ orderChangedHere: true, deliveryChangedHere: false, hasLocalDelivery: true, status: 'DELIVERED' }), false,
  'a stale Order projection must not resend terminal Delivery state');

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
assert.equal(Operations.validateRouteMembership(null, ['d_local'], [{ ...base, companyId: 'company_local', sync: { canonicalId: 'd_server' } }], [], 'company_1'), true,
  'a canonical server identity binds a legacy local-company projection to the authenticated tenant context');
assert.throws(() => Operations.validateRouteMembership(null, ['d_local'], [{ ...base, companyId: 'company_local' }], [], 'company_1'), /outra empresa/,
  'an unbound local delivery is not silently adopted into an authenticated tenant');
assert.throws(() => Operations.validateRouteMembership(null, ['d_local'], [{ ...base, status: 'DELIVERED' }], [], 'company_1'), /finalizadas/);
const returnDelivery = { ...base, id: 'return_local', status: 'ASSIGNED', extensions: { x_rotamoto_delivery_type: 'RETURN',
  x_rotamoto_custody_state: 'WITH_DRIVER', x_rotamoto_return_destination: { companyId: 'company_1' } } };
const linkedReturnOrder = { id: 'order_local', num: 'RETURN-42', sync: { canonicalId: 'order_canonical' } };
assert.equal(Operations.findOrderForDeliveryId('return_local', [linkedReturnOrder], [
  { ...returnDelivery, orderId: 'order_canonical', sync: { canonicalId: 'return_canonical' } },
]), linkedReturnOrder, 'RETURN projections resolve their commercial Order through canonical order identity');
const crossIdOrder={id:'order-local-1',deliveryId:'delivery-local-1',sync:{canonicalId:'order-canonical-1'},deliverySync:{canonicalId:'delivery-canonical-1'}};
const canonicalLinkedDelivery={id:'delivery-canonical-1',companyId:'company_1',orderId:'order-canonical-1',sync:{canonicalId:'delivery-canonical-1'}};
assert.equal(Operations.findDeliveryForOrder(crossIdOrder,[canonicalLinkedDelivery]),canonicalLinkedDelivery,
  'printing and QR resolve a Delivery linked by canonical Order/Delivery identity after local IDs differ');
const canonicalOrderLinkedDelivery={id:'delivery-canonical-2',orderId:'order-canonical-2'};
assert.equal(Operations.findDeliveryForOrder({id:'order-local-2',sync:{canonicalId:'order-canonical-2'}},[canonicalOrderLinkedDelivery]),canonicalOrderLinkedDelivery,
  'canonical Order identity resolves a delivery even when no local deliveryId remains');
assert.equal(Operations.validateRouteMembership(null, ['return_local'], [returnDelivery], [], 'company_1'), true,
  'an unreceived return remains eligible for manual route positioning');
assert.throws(() => Operations.validateRouteMembership(null, ['return_local'], [{ ...returnDelivery, status: 'RETURNED',
  extensions: { ...returnDelivery.extensions, x_rotamoto_custody_state: 'RECEIVED' } }], [], 'company_1'), /finalizadas/);
assert.equal(Operations.validateRouteMembership({ id: 'route_current', deliveryIds: ['d_local'] }, ['d_local'], [{ ...base, status: 'DELIVERED' }], [], 'company_1'), true);
assert.throws(() => Operations.validateRouteMembership(null, ['d_local'], deliveries, [{ id: 'route_old', deliveryIds: ['d_canonical'] }], 'company_1'), /outra rota ativa/);
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert.match(appSource,/function deliveryForOrder\(order\)\{return RotaMotoRestaurantOperations\.findDeliveryForOrder\(order,state\.deliveries\)\}/u,
  'Order detail, print and QR share canonical local/remote Delivery matching');
assert.match(appSource,/async function printQrForOrder\(order\)\{const delivery=canonicalDeliveryProjection\(deliveryForOrder\(order\)\)/u,
  'print QR resolves canonical Delivery IDs rather than only the visible/local Order ID');
assert.match(appSource,/async function openQrPreview\(id\)[\s\S]*?QR disponível após atribuição e sincronização/u,
  'QR UI explains the contract status prerequisite instead of reporting a generic unavailable error');
assert.match(appSource,/async function openPrintPreview\(orderId\)[\s\S]*?currentCompany=activeRestaurantCompanyId\(\),orderCompany=canonicalOrderCompany\(order\)/u,
  'print authorization compares canonical Order tenant to the authenticated session tenant');
assert.match(appSource,/const reason=await requestRequiredReason\(\{title:`Cancelar entrega/u,
  'delivery cancellation collects a required reason in an accessible app modal');
assert.doesNotMatch(appSource.slice(appSource.indexOf('async function cancelRestaurantDelivery'),appSource.indexOf('function decideRestaurantCustody')),/window\.prompt/u,
  'delivery cancellation no longer relies on native prompt');
assert.match(appSource,/function canonicalOrderSaveConfirmed\(order\)[\s\S]*?hasCurrentCanonicalAck[\s\S]*?payload\.companyId!==activeRestaurantCompanyId\(\)[\s\S]*?\['customer','phone','address'\]/u,
  'order edits show server confirmation only after current ACK, tenant match, and matching canonical readback');
assert.match(appSource,/Cliente e contato[\s\S]*?Endereço e localização[\s\S]*?Dados comerciais[\s\S]*?Entrega e responsável[\s\S]*?Observações[\s\S]*?Histórico resumido[\s\S]*?Gestão avançada/u,
  'order editor separates normal operating fields from the advanced management section');
assert.match(appSource,/data-detail-print[\s\S]*?addEventListener\('click',\(\)=>openPrintPreview\(o\.id\)\)/u,
  'the print action in the open order dialog is bound to its canonical print flow');
assert.match(appSource,/companyId:activeRestaurantCompanyId\(\)\|\|state\.settings\.global\.companyId/u,
  'new manual orders prefer the authenticated company over stale local company settings');
assert.match(appSource,/async function ensureSyncDeviceId\(\)[\s\S]*?store\.get\('syncDeviceId'\)[\s\S]*?store\.put\(\{key:'syncDeviceId',value:candidate\}\)/u,
  'sync installation identity is stored atomically in IndexedDB and reused across reloads');
assert.match(appSource,/async function buildRestaurantSyncPacket\(\)[\s\S]*?const deviceId=await ensureSyncDeviceId\(\)/u,
  'sync packets use the durable installation identity');
assert.match(appSource,/Endereço textual; não há coordenadas confirmadas/u,
  'the order detail does not manufacture coordinates from a textual address');
const routeEditor = appSource.slice(appSource.indexOf('function openRouteEditor'), appSource.indexOf('function revenueChart'));
assert.match(routeEditor, /addEventListener\('submit',async submitEvent=>/);
assert.match(routeEditor, /event\('success',current\?/);
assert.equal(Operations.minorUnitsFromDecimal(12.345), 1235);
assert.equal(Operations.minorUnitsFromDecimal(Number.MAX_VALUE), null);
assert.equal(Operations.minorUnitsFromDecimal('invalid'), null);
console.log('Restaurant canonical operations projections and route planning validation: OK');
