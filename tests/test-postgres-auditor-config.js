'use strict';

const assert = require('node:assert/strict');
const { validateTarget } = require('./test-postgres-e2e-security-parity');

const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'test';
try {
  const official = 'postgresql://rotamoto_auditor@127.0.0.1:5432/rotamoto';
  const e2e = 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto_e2e';
  assert.equal(validateTarget(official, 'rotamoto'), official);
  assert.equal(validateTarget(e2e, 'rotamoto_e2e'), e2e);
  for (const invalid of [
    'postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto',
    'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto',
    'postgresql://rotamoto_auditor:secret@127.0.0.1:5432/rotamoto',
    'postgresql://rotamoto_auditor@db.example:5432/rotamoto',
    'postgresql://rotamoto_auditor@127.0.0.1:5432/rotamoto_e2e'
  ]) assert.throws(() => validateTarget(invalid, 'rotamoto'), /rejeitado/u);
  assert.throws(() => validateTarget('postgresql://rotamoto_auditor@127.0.0.1:5432/rotamoto', 'rotamoto_e2e'), /rejeitado/u);
  assert.throws(() => validateTarget('postgresql://rotamoto_migrator@127.0.0.1:5432/rotamoto_e2e', 'rotamoto_e2e'), /rejeitado/u);
  process.stdout.write('PostgreSQL auditor target guard: PASS (no credentials or network connection used)\n');
} finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
}
