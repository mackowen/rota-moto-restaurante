'use strict';
const { verifyCode, recoveryDigest } = require('./totp');

function createNativeMfaProvider({ secretProvider, clock = Date.now }) {
  if (!secretProvider || typeof secretProvider.get !== 'function') throw new TypeError('Keystore de MFA obrigatório.');
  return Object.freeze({
    async verify({ client, userId, code, secretRef }) {
      if (!client || typeof client.query !== 'function' || typeof secretRef !== 'string' || typeof code !== 'string') return false;
      if (/^\d{6}$/u.test(code)) {
        const secret = await secretProvider.get(secretRef, { name: `identity/mfa/${userId}`, scope: 'installation' });
        const row = await client.query('SELECT mfa_totp_last_counter FROM rotamoto.credentials WHERE user_id=$1 FOR UPDATE', [userId]);
        if (!row.rowCount) return false;
        const counter = verifyCode(secret, code, { now: clock(), lastCounter: row.rows[0].mfa_totp_last_counter ?? -1 });
        if (counter === null) return false;
        const saved = await client.query(`UPDATE rotamoto.credentials SET mfa_totp_last_counter=$2,
          mfa_failed_attempts=0,mfa_locked_until=NULL,updated_at=now() WHERE user_id=$1
          AND (mfa_totp_last_counter IS NULL OR mfa_totp_last_counter<$2)`, [userId, counter]);
        return saved.rowCount === 1;
      }
      const digest = recoveryDigest(code);
      const consumed = await client.query(`UPDATE rotamoto.recovery_tokens SET consumed_at=now()
        WHERE user_id=$1 AND purpose='mfa_recovery' AND token_digest=$2 AND consumed_at IS NULL AND expires_at>now()
        RETURNING id`, [userId, digest]);
      return consumed.rowCount === 1;
    }
  });
}
module.exports = { createNativeMfaProvider };
