'use strict';

const crypto = require('node:crypto');

const PREFIX = 'rm-delivery.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const KID = /^[A-Za-z0-9_-]{1,32}$/u;
const TTL_SECONDS = 12 * 60 * 60;

function qrError(code) { return Object.assign(new Error('QR de entrega inválido.'), { code }); }

function validateClaims(claims, { nowSeconds = Math.floor(Date.now() / 1000), allowExpired = false } = {}) {
  if (!claims || claims.v !== 1 || !UUID.test(claims.d || '') || !UUID.test(claims.c || '') ||
      !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
      !Number.isSafeInteger(claims.rev) || claims.rev < 1 || !KID.test(claims.kid || '') ||
      claims.exp <= claims.iat || claims.exp - claims.iat > TTL_SECONDS) throw qrError('DELIVERY_QR_INVALID');
  if (claims.iat > nowSeconds + 60 || !allowExpired && claims.exp <= nowSeconds) throw qrError('DELIVERY_QR_EXPIRED');
  return claims;
}

function publicKeyFromPrivate(privateKey) {
  const key = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw qrError('DELIVERY_QR_KEY_INVALID');
  return crypto.createPublicKey(key);
}

function signDeliveryQr({ deliveryId, companyId, revision, kid, privateKey, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = TTL_SECONDS }) {
  const claims = validateClaims({ v: 1, d: deliveryId, c: companyId, iat: nowSeconds, exp: nowSeconds + ttlSeconds, rev: revision, kid }, { nowSeconds });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${PREFIX}.${payload}`;
  const signingKey = privateKey?.type === 'private' ? privateKey : crypto.createPrivateKey(privateKey);
  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), signingKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function verifyDeliveryQr(token, { publicKey, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof token !== 'string' || token.length > 1024) throw qrError('DELIVERY_QR_INVALID');
  const parts = token.split('.');
  if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX || !/^[A-Za-z0-9_-]+$/u.test(parts[2]) ||
      !/^[A-Za-z0-9_-]{80,100}$/u.test(parts[3])) throw qrError('DELIVERY_QR_INVALID');
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[2], 'base64url').toString('utf8')); } catch (_) { throw qrError('DELIVERY_QR_INVALID'); }
  validateClaims(claims, { nowSeconds });
  if (!publicKey || claims.kid !== publicKey.kid) throw qrError('DELIVERY_QR_KEY_UNKNOWN');
  let key;
  try { key = crypto.createPublicKey({ key: Buffer.from(publicKey.spki, 'base64url'), type: 'spki', format: 'der' }); }
  catch (_) { throw qrError('DELIVERY_QR_KEY_INVALID'); }
  if (key.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, Buffer.from(`${PREFIX}.${parts[2]}`, 'utf8'), key, Buffer.from(parts[3], 'base64url')))
    throw qrError('DELIVERY_QR_SIGNATURE_INVALID');
  return Object.freeze({ ...claims });
}

function createDeliveryQrService({ secretProvider, keyRef, kid, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  if (!secretProvider || typeof secretProvider.get !== 'function' || typeof keyRef !== 'string' || !keyRef || !KID.test(kid || ''))
    throw Object.assign(new Error('Assinatura de QR não configurada.'), { code: 'DELIVERY_QR_UNAVAILABLE' });
  let keyPromise;
  async function getPrivateKey() {
    if (!keyPromise) keyPromise = Promise.resolve().then(async () => {
      const pem = await secretProvider.get(keyRef, { name: `delivery/qr-signing-key/${kid}`, scope: 'installation' });
      const key = crypto.createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') throw qrError('DELIVERY_QR_KEY_INVALID');
      return key;
    }).catch(error => { keyPromise = null; throw error; });
    return keyPromise;
  }
  async function publicKey() {
    const key = crypto.createPublicKey(await getPrivateKey());
    return Object.freeze({ kid, algorithm: 'Ed25519', spki: key.export({ type: 'spki', format: 'der' }).toString('base64url') });
  }
  async function issue({ deliveryId, companyId, revision }) {
    const key = await getPrivateKey();
    return signDeliveryQr({ deliveryId, companyId, revision, kid, privateKey: key, nowSeconds: clock() });
  }
  return Object.freeze({ publicKey, issue });
}

module.exports = { PREFIX, TTL_SECONDS, validateClaims, signDeliveryQr, verifyDeliveryQr, publicKeyFromPrivate, createDeliveryQrService };
