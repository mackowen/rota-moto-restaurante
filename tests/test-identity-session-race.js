'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionReadGuard, sessionRestoreErrorMessage } = require('../identity-session-guard');

async function run() {
  const guard = createSessionReadGuard();
  let gated = true;
  let offlineMode = false;
  let currentSession = null;
  let releaseSessionRead;
  const pendingResponse = new Promise(resolve => { releaseSessionRead = resolve; });
  const capturedVersion = guard.capture();
  const restore = pendingResponse.then(response => {
    if (!guard.isCurrent(capturedVersion)) return currentSession;
    if (response.status === 401) { currentSession = null; gated = !offlineMode; }
    return currentSession;
  });

  guard.invalidate();
  offlineMode = true;
  gated = false;
  releaseSessionRead({ status: 401 });
  await restore;
  assert.equal(offlineMode, true, 'the explicit local-only choice remains selected');
  assert.equal(gated, false, 'a delayed anonymous 401 cannot gate the local application');

  const nextVersion = guard.capture();
  currentSession = { activeCompanyId: 'authorized-session' };
  assert.equal(guard.isCurrent(nextVersion), true, 'a later explicit authentication read remains current');
  assert.equal(currentSession.activeCompanyId, 'authorized-session');
  const message = error => error.status === 401 ? 'Sua sessão expirou. Entre novamente.' : 'Não foi possível concluir.';
  assert.equal(sessionRestoreErrorMessage({ status: 401 }, false, message), '', 'first anonymous access does not claim that a session expired');
  assert.equal(sessionRestoreErrorMessage({ status: 401 }, true, message), 'Sua sessão expirou. Entre novamente.', 'a lost authenticated session remains distinguishable');

  const source = fs.readFileSync(path.join(__dirname, '..', 'identity-ui.js'), 'utf8');
  assert.match(source, /const readVersion = sessionReadGuard\.capture\(\)/u);
  assert.match(source, /sessionReadGuard\.invalidate\(\); offlineMode = true/u);
  assert.match(source, /const hadAuthenticatedSession = Boolean\(current\)/u);
  assert.match(source, /sessionRestoreErrorMessage\(error, hadAuthenticatedSession, message\)/u);
  console.log('identity local-choice/session race regression: OK');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
