'use strict';

const crypto = require('node:crypto');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function encodeBase32(buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buffer) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}
function decodeBase32(value) {
  let bits = 0, buffer = 0; const out = [];
  for (const char of value) { const n = BASE32.indexOf(char); if (n < 0) throw new TypeError('Invalid base32'); buffer = (buffer << 5) | n; bits += 5; if (bits >= 8) { out.push((buffer >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function generateSecret() { return encodeBase32(crypto.randomBytes(20)); }
function otpauthUri(secret, { issuer = 'RotaMoto', account } = {}) {
  if (typeof account !== 'string' || !account || typeof issuer !== 'string' || !issuer) throw new TypeError('TOTP account/issuer required.');
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${encodeURIComponent(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
function codeAt(secret, counter, digits = 6) {
  const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % (10 ** digits)).padStart(digits, '0');
}
function verifyCode(secret, code, { now = Date.now(), lastCounter = -1, window = 1 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/u.test(code)) return null;
  const counter = Math.floor(now / 30000);
  for (let candidate = counter - window; candidate <= counter + window; candidate++) {
    if (candidate <= lastCounter || candidate < 0) continue;
    const expected = Buffer.from(codeAt(secret, candidate));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return candidate;
  }
  return null;
}
function generateRecoveryCodes(count = 10) { return Object.freeze(Array.from({ length: count }, () => crypto.randomBytes(10).toString('hex').toUpperCase())); }
function recoveryDigest(code) { return crypto.createHash('sha256').update(String(code).replace(/-/gu, '').toUpperCase()).digest(); }
module.exports = { encodeBase32, decodeBase32, generateSecret, otpauthUri, codeAt, verifyCode, generateRecoveryCodes, recoveryDigest };
