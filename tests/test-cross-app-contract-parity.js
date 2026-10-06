'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.resolve(__dirname, '..');
const siblingRoot = path.resolve(appRoot, '..', 'rota-moto');

function loadContract(root) {
  const source = fs.readFileSync(path.join(root, 'contract.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: path.join(root, 'contract.js') });
  assert.ok(context.RotaMotoContract, `contract.js não exportou RotaMotoContract: ${root}`);
  return context.RotaMotoContract;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function validateV1RevisionMetadata(contract) {
  const timestamp = '2026-01-02T03:04:05.000Z';
  const samples = {
    Order: { id: 'order-1', companyId: 'company-1', createdAt: timestamp, updatedAt: timestamp, version: 2 },
    Driver: { id: 'driver-1', companyId: 'company-1', createdAt: timestamp, updatedAt: timestamp, version: 2 },
    Route: { id: 'route-1', companyId: 'company-1', createdAt: timestamp, updatedAt: timestamp, version: 2, deliveryIds: [] },
    Delivery: { id: 'delivery-1', companyId: 'company-1', status: 'ASSIGNED', createdAt: timestamp, updatedAt: timestamp, version: 2 },
    Earning: { id: 'earning-1', companyId: 'company-1', amountMinor: 100, currency: 'BRL', createdAt: timestamp, updatedAt: timestamp, version: 2 }
  };

  for (const [entity, sample] of Object.entries(samples)) {
    const update = { ...sample, baseVersion: 1 };
    assert.equal(contract.validateEntity(entity, update).valid, true, `${entity} deve aceitar baseVersion de update v1`);
    assert.equal(contract.validateEntity(entity, { ...update, baseVersion: 0 }).valid, false, `${entity} deve rejeitar baseVersion inválido`);
  }
  assert.equal(contract.ENTITY_SCHEMAS.Delivery.fields.baseVersion, 'revision');
  assert.equal(contract.ENTITY_SCHEMAS.DeliveryEvent.fields.baseVersion, undefined, 'baseVersion não é campo de DeliveryEvent');
}

function validateV1PacketAndEvent(contract) {
  const timestamp = '2026-01-02T03:04:05.000Z';
  const delivery = { id: 'delivery-1', companyId: 'company-1', status: 'ASSIGNED', createdAt: timestamp, updatedAt: timestamp, version: 2, baseVersion: 1 };
  const event = contract.event('DELIVERY_ACCEPTED', 'Delivery', 'delivery-1', { occurredAt: timestamp }, { type: 'driver', id: 'driver-1' });
  const packet = contract.packet({ companyId: 'company-1', deviceId: 'device-1', app: 'RotaMoto', deliveries: [delivery], deliveryEvents: [event] });

  assert.deepEqual(sortedKeys(packet), ['ackFor', 'companyId', 'createdAt', 'data', 'deviceId', 'events', 'packetId', 'protocol', 'protocolVersion', 'schemaVersion', 'source'].sort());
  assert.equal(packet.protocol, 'rotamoto-sync');
  assert.equal(packet.protocolVersion, 1);
  assert.equal(packet.schemaVersion, 1);
  assert.equal(packet.companyId, 'company-1');
  assert.equal(packet.source.app, 'RotaMoto');
  assert.deepEqual(sortedKeys(packet.data), ['deliveries', 'deliveryEvents', 'drivers', 'earnings', 'locationUpdates', 'orders', 'proofs', 'routes', 'tombstones'].sort());
  assert.ok(typeof packet.packetId === 'string' && packet.packetId.length > 0);
  assert.ok(typeof event.eventId === 'string' && event.eventId.length > 0);
  assert.equal(event.protocolVersion, 1);
  assert.equal(contract.validateEntity('DeliveryEvent', event).valid, true, 'fato v1 deve validar pelo schema compartilhado');
  const imported = JSON.parse(JSON.stringify(packet));
  assert.equal(imported.protocolVersion, 1, 'round-trip do pacote persistido/importado deve manter sync v1');
  assert.equal(imported.packetId, packet.packetId, 'round-trip deve preservar packetId');
  assert.equal(imported.data.deliveryEvents[0].eventId, event.eventId, 'round-trip deve preservar eventId');
  assert.equal(contract.validateEntity('Delivery', imported.data.deliveries[0]).valid, true);
  assert.equal(contract.SYNC_ACK.ACCEPTED, 'accepted');
  assert.equal(contract.SYNC_ACK.DUPLICATE, 'duplicate');
  assert.equal(contract.SYNC_ACK.REJECTED, 'rejected');
  assert.equal(contract.SYNC_ACK.CONFLICT, 'conflict');
}

assert.ok(fs.existsSync(path.join(siblingRoot, 'contract.js')), `checkout irmão não encontrado: ${siblingRoot}`);
const current = loadContract(appRoot);
const sibling = loadContract(siblingRoot);
const currentDocs = fs.readFileSync(path.join(appRoot, 'CONTRACT.md'), 'utf8');
const siblingDocs = fs.readFileSync(path.join(siblingRoot, 'CONTRACT.md'), 'utf8');

assert.equal(currentDocs, siblingDocs, 'CONTRACT.md deve permanecer sincronizado entre os apps');
for (const requiredClause of ['protocol=\'rotamoto-sync\'', 'protocolVersion=1', 'schemaVersion=1', 'packetId', 'eventId', 'baseVersion', 'canonicalVersion', 'operationResults', 'outbox', 'inbox', 'tombstones']) {
  assert.ok(currentDocs.includes(requiredClause), `CONTRACT.md não documenta ${requiredClause}`);
}

assert.equal(current.PROTOCOL_VERSION, 1);
assert.equal(current.SCHEMA_VERSION, 1);
assert.equal(sibling.PROTOCOL_VERSION, 1);
assert.equal(sibling.SCHEMA_VERSION, 1);
assert.deepEqual(plain(current.STATUS), plain(sibling.STATUS), 'enums Delivery devem coincidir');
assert.deepEqual(plain(current.TRANSITIONS), plain(sibling.TRANSITIONS), 'transições Delivery devem coincidir');
assert.deepEqual(plain(current.EXECUTION_EVENT_STATUS), plain(sibling.EXECUTION_EVENT_STATUS), 'eventos de execução devem coincidir');
assert.deepEqual(plain(current.WRITE_AUTHORITY), plain(sibling.WRITE_AUTHORITY), 'ownership/authorities devem coincidir');
assert.deepEqual(plain(current.SYNC_ACK), plain(sibling.SYNC_ACK), 'vocabulário de ACK deve coincidir');
assert.deepEqual(plain(current.ENTITY_SCHEMAS), plain(sibling.ENTITY_SCHEMAS), 'required fields e tipos compartilhados devem coincidir');
assert.deepEqual(sortedKeys(current.ENTITY_SCHEMAS), ['Company', 'Delivery', 'DeliveryEvent', 'DeliveryProof', 'Driver', 'Earning', 'LocationPoint', 'Order', 'Route'].sort());
assert.deepEqual(sortedKeys(current.STATUS), ['ACCEPTED', 'ARRIVED', 'ASSIGNED', 'CANCELLED', 'CREATED', 'DELIVERED', 'FAILED', 'OUT_FOR_DELIVERY', 'PICKED_UP', 'REDELIVERY', 'RETURNED'].sort());
assert.equal(current.WRITE_AUTHORITY.Company, 'server', 'Company é server-owned e não é schema gravável pelo cliente');
assert.equal(current.ENTITY_SCHEMAS.Company.fields.timeZone, 'nullable-iana-time-zone');
for (const entity of sortedKeys(current.ENTITY_SCHEMAS)) {
  assert.deepEqual(plain(current.ENTITY_SCHEMAS[entity].required), plain(sibling.ENTITY_SCHEMAS[entity].required), `${entity} required fields devem coincidir`);
  assert.ok(current.ENTITY_SCHEMAS[entity].required.includes('id') || entity === 'DeliveryEvent', `${entity} deve ter identificador obrigatório conforme seu tipo`);
}
assert.equal(current.ENTITY_SCHEMAS.DeliveryEvent.required.includes('eventId'), true);
assert.equal(current.ENTITY_SCHEMAS.Delivery.required.includes('companyId'), true);
assert.equal(current.ENTITY_SCHEMAS.Delivery.required.includes('status'), true);
assert.equal(current.ENTITY_SCHEMAS.Driver.fields.capacity,'delivery-capacity');
for (const contract of [current, sibling]) {
  const companyTime = '2026-01-02T03:04:05.000Z';
  const company = { id: 'company-1', name: 'QA', createdAt: companyTime, updatedAt: companyTime, timeZone: 'America/Sao_Paulo' };
  const capacityDriver={id:'driver-1',companyId:'company-1',createdAt:companyTime,updatedAt:companyTime,version:1,capacity:{unit:'deliveries',limit:4}};
  assert.equal(contract.validateEntity('Driver',capacityDriver).valid,true,'both apps accept canonical delivery capacity');
  assert.equal(contract.validateEntity('Driver',{...capacityDriver,capacity:{unit:'weight',limit:4}}).valid,false);
  assert.equal(contract.validateEntity('Company', company).valid, true, 'Company aceita timezone IANA canônico');
  assert.equal(contract.validateEntity('Company', { ...company, timeZone: null }).valid, true, 'Company representa explicitamente timezone ainda não configurado');
  assert.equal(contract.validateEntity('Company', { ...company, timeZone: '+03:00' }).valid, false, 'offset fixo não é timezone canônico');
  assert.equal(contract.validateEntity('Company', { ...company, timeZone: 'Etc/GMT+3' }).valid, false, 'zona de offset fixo não é operacional');
  const money = { currency: 'BRL', completeness: 'partial', provenance: { kind: 'manual' }, components: { deliveryFeeMinor: 1234 } };
  const order = { id: 'order-money', companyId: 'company-1', createdAt: companyTime, updatedAt: companyTime, version: 1, money };
  assert.equal(contract.validateEntity('Order', order).valid, true, 'Order.money v1 aditivo deve validar');
  assert.equal(contract.validateEntity('Order', { ...order, money: { ...money, components: { deliveryFeeMinor: 12.5 } } }).valid, false, 'componentes monetários não aceitam float');
  assert.equal(contract.validateEntity('Order', { ...order, money: { ...money, currency: 'ZZZ' } }).valid, false, 'moeda deve ser ISO suportada');
  assert.equal(contract.validateEntity('Order', { ...order, money: { currency: 'BRL', completeness: 'complete', provenance: { kind: 'import' }, components: { itemsSubtotalMinor: 1000, discountMinor: 0, deliveryFeeMinor: 200, serviceFeeMinor: 0, otherFeeMinor: 0, totalMinor: 1199 } } }).valid, false, 'total inconsistente deve falhar');
}

for (const contract of [current, sibling]) {
  validateV1RevisionMetadata(contract);
  validateV1PacketAndEvent(contract);
  assert.equal(contract.canTransition('ASSIGNED', 'ACCEPTED'), true);
  assert.equal(contract.canTransition('DELIVERED', 'ASSIGNED'), false);
  assert.equal(contract.normalizeDeliveryStatus('ATRIBUIDA', 'restaurante'), 'ASSIGNED');
  assert.equal(contract.normalizeDeliveryStatus('route', 'motoboy'), 'OUT_FOR_DELIVERY');
}

console.log('Cross-app contract parity, v1 packet semantics and revision metadata passed.');
