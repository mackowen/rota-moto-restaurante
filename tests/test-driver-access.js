'use strict';

const assert = require('node:assert/strict');
const { requireActiveDriver } = require('../backend/domain/driver-access');

async function run(status, principal = { company_id: 'company-a', user_id: 'user-a', driver_id: 'driver-a' }) {
  const statements = [];
  const client = { async query(sql, params) {
    statements.push({ sql, params });
    if (sql.includes('FROM rotamoto.domain_records d')) return status === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ status }] };
    throw new Error('unexpected SQL');
  } };
  return { result: await requireActiveDriver(client, principal), statements };
}

(async () => {
  const active = await run('ACTIVE');
  assert.equal(active.result, 'driver-a');
  assert.match(active.statements[0].sql, /m\.user_id=\$3 AND m\.status='active'/u);
  assert(active.statements[0].sql.includes('FOR SHARE OF d,m'));
  const offline = await run('OFFLINE');
  assert.equal(offline.result, 'driver-a', 'offline availability does not deactivate a legitimate Driver account');
  await assert.rejects(run('DISABLED'), error => error.code === 'DRIVER_INACTIVE');
  await assert.rejects(run(null), error => error.code === 'DRIVER_INACTIVE');
  await assert.rejects(run('ACTIVE', { company_id: 'company-a', user_id: 'user-a', driver_id: null }),
    error => error.code === 'DRIVER_LINK_REQUIRED');
  console.log('Motoboy explicit Driver link, active state and fail-closed authorization: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
