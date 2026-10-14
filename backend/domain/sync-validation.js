'use strict';

const ENTITY_ARRAYS = Object.freeze([
  ['orders', 'Order'], ['drivers', 'Driver'], ['deliveries', 'Delivery'], ['routes', 'Route'],
  ['deliveryEvents', 'DeliveryEvent'], ['locationUpdates', 'LocationPoint'], ['proofs', 'DeliveryProof'], ['earnings', 'Earning']
]);

class SyncError extends Error {
  constructor(code, message) { super(message); this.name = 'SyncError'; this.code = code; }
}

function invalid(message) { throw new SyncError('INVALID_INPUT', message); }

function boundedText(value, name, max = 255) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${name} inválido.`);
  }
  return value.trim();
}

function packetUuid(value) {
  if (typeof value !== 'string' || !/^pkt_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.test(value)) {
    invalid('packetId incompatível com o contrato rotamoto-sync v1.');
  }
  return value.slice(4).toLowerCase();
}

function validatePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.protocol !== 'rotamoto-sync' ||
      packet.protocolVersion !== 1 || packet.schemaVersion !== 1) invalid('Envelope de sincronização inválido ou incompatível.');
  const id = packetUuid(packet.packetId);
  const deviceId = boundedText(packet.deviceId, 'deviceId', 128);
  if (packet.source?.deviceId && packet.source.deviceId !== deviceId) invalid('deviceId divergente no envelope.');
  const data = packet.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid('data do pacote inválido.');
  // Local projections remain accepted by v1 for compatibility, but never become canonical writes.
  const allowed = new Set([...ENTITY_ARRAYS.map(([key]) => key), 'tombstones', 'settings', 'races']);
  if (Object.keys(data).some(key => !allowed.has(key))) invalid('O pacote contém coleções não previstas no contrato v1.');
  if (data.races !== undefined && !Array.isArray(data.races)) invalid('data.races deve ser uma lista.');
  if (data.settings !== undefined && (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings))) {
    invalid('data.settings deve ser um objeto.');
  }
  const sensitiveKeys = new Set(['password', 'passwordhash', 'token', 'secret', 'secretref', 'authorization',
    'accesstoken', 'refreshtoken', 'apikey', 'privatekey', 'credential', 'credentials']);
  function inspect(value, depth = 0) {
    if (depth > 32) invalid('A estrutura do pacote é profunda demais.');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/gu, '');
      if (sensitiveKeys.has(normalizedKey) || /(?:password|secret|token|credential|authorization|apikey|privatekey)/u.test(normalizedKey)) {
        invalid('O pacote contém campos de credencial não sincronizáveis.');
      }
      inspect(child, depth + 1);
    }
  }
  inspect(packet);
  let total = 0;
  for (const [key] of ENTITY_ARRAYS) {
    if (data[key] !== undefined && !Array.isArray(data[key])) invalid(`data.${key} deve ser uma lista.`);
    total += data[key]?.length || 0;
  }
  if (packet.events !== undefined && !Array.isArray(packet.events)) invalid('events deve ser uma lista.');
  if (data.tombstones !== undefined && !Array.isArray(data.tombstones)) invalid('tombstones deve ser uma lista.');
  total += packet.events?.length || 0;
  total += data.tombstones?.length || 0;
  total += data.races?.length || 0;
  total += data.settings ? 1 : 0;
  if (total > 500) invalid('O pacote excede 500 operações.');
  return { packetId: id, deviceId, data, events: packet.events || [] };
}

module.exports = { SyncError, invalid, boundedText, validatePacket, ENTITY_ARRAYS };
