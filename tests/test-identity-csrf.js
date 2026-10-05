'use strict';

const assert = require('node:assert/strict');
const { deriveCsrfToken } = require('../backend/identity/csrf');

const session = 'high-entropy-http-only-session-cookie';
const first = deriveCsrfToken(session);
assert.match(first, /^[A-Za-z0-9_-]{43}$/u);
assert.equal(deriveCsrfToken(session), first, 'parallel and repeated session reads derive the same CSRF token');
assert.notEqual(deriveCsrfToken(`${session}-other`), first, 'each authenticated session has a distinct CSRF token');
assert.throws(() => deriveCsrfToken(''), /Token de sessão obrigatório/u);
console.log('identity CSRF stability tests: OK');
