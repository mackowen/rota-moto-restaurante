'use strict';

const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, validatePassword, parsePhc } = require('../backend/identity/passwords');
const { tokenDigest, normalizeEmail, IdentityError, uuidV7 } = require('../backend/identity/service');

async function main() {
  const password = 'synthetic-identity-password-42';
  const hash = await hashPassword(password);
  assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=3,p=2\$/u);
  assert.equal(await verifyPassword(hash, password), true);
  assert.equal(await verifyPassword(hash, 'different synthetic password'), false);
  assert.equal(await verifyPassword('$argon2id$v=19$m=999999,t=3,p=2$AAAA$AAAA', password), false);
  assert.equal(parsePhc(hash).memory, 65536);
  assert.throws(() => validatePassword('short'), /12 e 1024/);
  assert.throws(() => validatePassword(`nul\0${'x'.repeat(12)}`), /12 e 1024/);
  assert.throws(() => validatePassword('x'.repeat(1025)), /12 e 1024/);
  assert.equal(normalizeEmail('  USER@Example.COM '), 'user@example.com');
  assert.throws(() => normalizeEmail('invalid'), error => error instanceof IdentityError && error.code === 'INVALID_INPUT');
  assert.throws(() => tokenDigest('not-a-random-token'), error => error.code === 'INVALID_TOKEN');
  assert.match(uuidV7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    'canonical IDs follow UUIDv7');
  console.log('identity Argon2id and validation tests: OK');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
