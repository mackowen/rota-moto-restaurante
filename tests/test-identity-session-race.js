'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSessionReadGuard, sessionRestoreErrorMessage, beginCsrfRefresh, invalidateSessionRead, withSessionRead, setCsrfToken, getCsrfToken, clearCsrfToken } = require('../identity-session-guard');

async function run() {
  setCsrfToken('fresh-session-proof');
  assert.equal(getCsrfToken(), 'fresh-session-proof', 'identity and sync clients share the latest in-memory CSRF proof');
  const olderRefresh = beginCsrfRefresh();
  const newerRefresh = beginCsrfRefresh();
  assert.equal(setCsrfToken('newer-proof', newerRefresh), true);
  assert.equal(setCsrfToken('stale-proof', olderRefresh), false, 'late session responses cannot restore an obsolete CSRF proof');
  assert.equal(getCsrfToken(), 'newer-proof');
  clearCsrfToken();
  assert.equal(getCsrfToken(), null, 'session expiry clears the shared CSRF proof');
  let sessionReadCount = 0;
  let releaseSharedSessionRead;
  const pendingSharedRead = new Promise(resolve => { releaseSharedSessionRead = resolve; });
  const readSession = () => withSessionRead(async () => { sessionReadCount += 1; return pendingSharedRead; });
  const sessionReaders = [readSession(), readSession()];
  releaseSharedSessionRead({ userId: 'e2e-user', csrfToken: 'one-shared-read' });
  assert.deepEqual(await Promise.all(sessionReaders), [{ userId: 'e2e-user', csrfToken: 'one-shared-read' }, { userId: 'e2e-user', csrfToken: 'one-shared-read' }]);
  assert.equal(sessionReadCount, 1, 'simultaneous identity and sync boot share one CSRF-rotating session read');
  let releaseAnonymousRead;
  let anonymousReadCount = 0;
  const anonymousRead = withSessionRead(() => {
    anonymousReadCount += 1;
    return new Promise(resolve => { releaseAnonymousRead = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(anonymousReadCount, 1);
  invalidateSessionRead();
  let releaseAuthenticatedRead;
  let authenticatedReadCount = 0;
  const authenticatedRead = withSessionRead(() => {
    authenticatedReadCount += 1;
    return new Promise(resolve => { releaseAuthenticatedRead = resolve; });
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(authenticatedReadCount, 1, 'login after an in-flight anonymous read starts a fresh session request');
  releaseAnonymousRead({ ok: false, status: 401, json: async () => ({ error: { code: 'UNAUTHENTICATED' } }) });
  await assert.rejects(anonymousRead, error => error.status === 401);
  const joinedAuthenticatedRead = withSessionRead(() => {
    authenticatedReadCount += 1;
    return Promise.resolve({ userId: 'duplicate-authenticated-read' });
  });
  assert.equal(joinedAuthenticatedRead, authenticatedRead, 'a late stale read cannot detach the current authenticated singleflight');
  assert.equal(authenticatedReadCount, 1, 'the active authenticated request remains shared after stale completion');
  releaseAuthenticatedRead({ userId: 'authenticated-after-login', csrfToken: 'fresh-csrf-proof' });
  assert.deepEqual(await authenticatedRead, { userId: 'authenticated-after-login', csrfToken: 'fresh-csrf-proof' });
  assert.deepEqual(await joinedAuthenticatedRead, { userId: 'authenticated-after-login', csrfToken: 'fresh-csrf-proof' });
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
  releaseSessionRead({ status: 401 });
  await restore;
  assert.equal(offlineMode, false, 'an unauthenticated browser cannot enter an operational local mode');
  assert.equal(gated, true, 'a delayed anonymous 401 cannot release the application gate');

  const nextVersion = guard.capture();
  currentSession = { activeCompanyId: 'authorized-session' };
  assert.equal(guard.isCurrent(nextVersion), true, 'a later explicit authentication read remains current');
  assert.equal(currentSession.activeCompanyId, 'authorized-session');
  const message = error => error.status === 401 ? 'Sua sessão expirou. Entre novamente.' : 'Não foi possível concluir.';
  assert.equal(sessionRestoreErrorMessage({ status: 401 }, false, message), '', 'first anonymous access does not claim that a session expired');
  assert.equal(sessionRestoreErrorMessage({ status: 401 }, true, message), 'Sua sessão expirou. Entre novamente.', 'a lost authenticated session remains distinguishable');

  const source = fs.readFileSync(path.join(__dirname, '..', 'identity-ui.js'), 'utf8');
  assert.match(source, /const readVersion = sessionReadGuard\.capture\(\)/u);
  assert.match(source, /invalidateSessionReads\(\);\s*csrf = null/u);
  assert.match(source, /function invalidateSessionReads\(\)[\s\S]*?invalidateSessionRead\?\.\(\)/u,
    'identity state changes invalidate in-flight shared reads as well as local UI generations');
  assert.match(source, /request\('\/identity\/login'[\s\S]*?\n\s*invalidateSessionReads\(\);\s*csrf = result\.csrfToken/u,
    'a successful login cannot reuse an anonymous session response already in flight');
  assert.match(source, /window\.dispatchEvent\(new CustomEvent\(session && !mfaLocked \? 'rotamoto:auth-ready' : 'rotamoto:auth-revoked'\)\)/u);
  assert.match(source, /const hadAuthenticatedSession = Boolean\(current\)/u);
  assert.match(source, /sessionRestoreErrorMessage\(error, hadAuthenticatedSession, message\)/u);
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(appSource, /activeEditor=document\.activeElement\?\.closest\?\.\('#main input,#main select,#main textarea,#main \[contenteditable="true"\]'\)/u,
    'restoring focus to a hidden login field after reload must not suppress the authenticated app render');
  assert.match(appSource, /activeEditor\?\.isConnected&&activeEditor\.getClientRects\(\)\.length/u,
    'only a visible, connected editor inside the authenticated main view may preserve an in-progress edit');
  console.log('identity local-choice/session race regression: OK');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
