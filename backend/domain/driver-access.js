'use strict';

const AUTHORIZED_DRIVER_STATUSES = new Set(['ACTIVE', 'AVAILABLE', 'DISPONIVEL', 'EM ROTA', 'CHEGOU', 'IN ROUTE', 'ARRIVED',
  'OFFLINE', 'UNAVAILABLE', 'INDISPONIVEL', 'BUSY', 'OCUPADO', 'PAUSED', 'PAUSADO']);

function normalizedDriverStatus(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').trim().toUpperCase();
}

function denied(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function requireActiveDriver(client, principal) {
  const driverId = principal?.driver_id;
  if (typeof driverId !== 'string') {
    throw denied('DRIVER_LINK_REQUIRED', 'Esta conta não está vinculada a um cadastro de motoboy ativo nesta empresa.');
  }
  const result = await client.query(`SELECT d.payload->>'status' AS status
    FROM rotamoto.domain_records d
    JOIN rotamoto.memberships m ON m.company_id=d.company_id AND m.driver_id=d.record_id
    WHERE d.company_id=$1 AND d.record_id=$2::uuid AND d.entity_type='Driver' AND d.deleted_at IS NULL
      AND m.user_id=$3 AND m.status='active'
    FOR SHARE OF d,m`, [principal.company_id, driverId, principal.user_id]);
  if (!result.rowCount || !AUTHORIZED_DRIVER_STATUSES.has(normalizedDriverStatus(result.rows[0].status))) {
    throw denied('DRIVER_INACTIVE', 'O vínculo de motoboy não está ativo ou autorizado nesta empresa.');
  }
  return driverId;
}

module.exports = { AUTHORIZED_DRIVER_STATUSES, normalizedDriverStatus, requireActiveDriver };
