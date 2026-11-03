'use strict';

const assert = require('node:assert/strict');
const { isLocalOnlyBootstrapRequest } = require('../backend/identity/local-only-bootstrap');

const options = { enabled: true, databaseName: 'rotamoto' };
const local = { socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'http://127.0.0.1:8083' } };
assert.equal(isLocalOnlyBootstrapRequest(local, options), true);
assert.equal(isLocalOnlyBootstrapRequest({ ...local, socket: { remoteAddress: '::ffff:127.0.0.1' } }, options), true,
  'IPv4-mapped loopback is normalized from the actual connection socket');
assert.equal(isLocalOnlyBootstrapRequest({ ...local, socket: { remoteAddress: '192.168.1.20' }, headers: { ...local.headers,
  'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } }, options), false,
  'proxy headers cannot turn a LAN socket into loopback');
assert.equal(isLocalOnlyBootstrapRequest({ ...local, headers: { origin: 'https://attacker.invalid', 'x-forwarded-for': '127.0.0.1' } }, options), false);
assert.equal(isLocalOnlyBootstrapRequest(local, { ...options, enabled: false }), false, 'explicit disabled mode fails closed');
assert.equal(isLocalOnlyBootstrapRequest(local, { ...options, databaseName: 'rotamoto_e2e' }), false, 'E2E identity cannot use official local installation mode');
assert.equal(isLocalOnlyBootstrapRequest({ ...local, headers: {} }, options), false, 'missing Origin is rejected');
assert.equal(isLocalOnlyBootstrapRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:8788' } }, options), true,
  'same-machine read-only status may identify loopback by Host when browsers omit Origin on GET');
assert.equal(isLocalOnlyBootstrapRequest({ socket: { remoteAddress: '192.168.1.20' }, headers: { host: '127.0.0.1:8788',
  'x-forwarded-for': '127.0.0.1' } }, options), false, 'Host and proxy headers cannot override a non-loopback socket peer');
console.log('local-only bootstrap backend gate: official database, direct loopback peer and local origin required; forwarded headers ignored: PASS');
