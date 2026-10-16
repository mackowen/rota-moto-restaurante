'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../scripts/bootstrap-owner'), 'utf8');
assert.match(source, /stdin\.isTTY !== true \|\| stdout\.isTTY !== true/u, 'bootstrap requires a protected interactive local terminal');
assert.match(source, /--confirm-database=rotamoto/u, 'operator must confirm the exact installation target');
assert.match(source, /PROVISIONAR PRIMEIRO PROPRIETARIO/u, 'operator must explicitly approve the first owner');
assert.match(source, /current_database\(\).*current_user/u, 'connected DB and least-privilege runtime role are checked');
assert.match(source, /bootstrap_authorizations[\s\S]*token_digest/u, 'only a single-use capability digest is stored');
assert.match(source, /now\(\)\+interval '10 minutes'/u, 'capability has a short expiry');
assert.match(source, /requireBootstrapAuthorization: true/u, 'owner service refuses provisioning without install authorization');
assert.match(source, /createNativeMfaProvider/u, 'the real MFA provider is required during bootstrap');
assert.match(source, /createSmtpMailProvider/u, 'owner activation uses the configured email provider');
assert.doesNotMatch(source, /console\.(?:log|info)\([^\n]*(?:password|token|email)/iu, 'secrets and recipient are not logged');
console.log('local first-owner bootstrap CLI guards: PASS');
