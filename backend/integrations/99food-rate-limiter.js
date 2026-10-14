'use strict';

const crypto = require('node:crypto');

function hash(value) { return crypto.createHash('sha256').update(value, 'utf8').digest(); }

function create99FoodRateLimiter({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('99Food rate limiter requires a PostgreSQL pool.');
  return async function consume({ companyId, accountId = null, appId, appShopId, operation }) {
    if (typeof companyId !== 'string' || typeof appId !== 'string' || typeof appShopId !== 'string') {
      throw Object.assign(new Error('99Food rate limit context unavailable.'), { code: 'RATE_LIMIT_CONTEXT_UNAVAILABLE', status: 503 });
    }
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
      result = await client.query('SELECT * FROM rotamoto.consume_99food_rate_limit($1,$2,$3,$4,$5)',
        [companyId, accountId, hash(`99food:app:${appId}`), hash(`99food:store:${appId}:${appShopId}`), operation]);
      await client.query('COMMIT');
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      throw error;
    } finally { client.release(); }
    const row = result.rows[0];
    if (!row?.allowed) throw Object.assign(new Error('99Food request rate limited locally.'), {
      code: 'PROVIDER_RATE_LIMIT', status: 429, retryAfterSeconds: Math.max(1, Math.ceil(Number(row?.retry_after_ms || 1000) / 1000)), classification: 'rate_limit'
    });
  };
}

module.exports = { create99FoodRateLimiter };
