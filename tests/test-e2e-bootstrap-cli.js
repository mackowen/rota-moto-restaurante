'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../scripts/bootstrap-owner-e2e'), 'utf8');
assert.match(source, /--confirm-environment=e2e/u);
assert.match(source, /--confirm-database=rotamoto_e2e/u);
assert.match(source, /validateE2eDatabaseIdentity/u);
assert.match(source, /createIdentityService/u);
assert.match(source, /requireBootstrapAuthorization: true/u);
assert.match(source, /createEmailDeliveryProvider/u);
assert.match(source, /invitationToken = message\.token/u);
assert.match(source, /process\.stdin\.isTTY|stdin\.isTTY/u);
assert.match(source, /setRawMode\(true\)/u, 'activation password input is hidden');
assert.match(source, /consumeOwnerInvitation/u);
assert.doesNotMatch(source, /createSmtpMailProvider|https?:\/\//u, 'the local invite capture has no network transport');
assert.doesNotMatch(source, /console\.(?:log|info|error)\([^\n]*(?:password|token|secret)/iu);
process.stdout.write('E2E first-owner CLI guards: PASS\n');
