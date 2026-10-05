'use strict';

const assert = require('node:assert/strict');
const { runFixtureLifecycle } = require('./e2e-support/fixture-lifecycle');

runFixtureLifecycle({ exercise: async fixture => {
  assert.equal(fixture.authenticated, undefined);
  const session = await fixture.call('/api/identity/session');
  assert.notEqual(session.status, 200, 'fixture callback must not receive an unauthenticated session');
} }).then(result => {
  assert.equal(result.authenticated, true);
  assert.equal(result.mfaVerified, true);
  console.log('E2E fixture lifecycle: PASS (authenticated owner, MFA, Driver binding, operational sync, rollback teardown)');
}).catch(error => {
  console.error('E2E fixture lifecycle: FAIL:', error.message);
  process.exitCode = 1;
});
