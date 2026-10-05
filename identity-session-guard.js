'use strict';

function createSessionReadGuard() {
  let version = 0;
  return Object.freeze({
    capture: () => version,
    invalidate: () => ++version,
    isCurrent: captured => captured === version
  });
}

function sessionRestoreErrorMessage(error, hadAuthenticatedSession, message) {
  if (error?.status === 401 && !hadAuthenticatedSession) return '';
  return message(error);
}

let csrfToken = null;
let csrfGeneration = 0;
let sessionRead = null;
function beginCsrfRefresh() { return ++csrfGeneration; }
function withSessionRead(read) {
  if (sessionRead) return sessionRead;
  sessionRead = Promise.resolve().then(read).then(async response => {
    if (!response || typeof response.json !== 'function') return response;
    let body = {}; try { body = await response.json(); } catch (_) {}
    if (!response.ok) throw Object.assign(new Error(body.error?.message || 'Sessão indisponível.'), { status: response.status, code: body.error?.code || 'SESSION_REQUIRED' });
    return body;
  }).finally(() => { sessionRead = null; });
  return sessionRead;
}
function setCsrfToken(value, generation = null) {
  if (generation !== null && generation !== csrfGeneration) return false;
  if (generation === null) csrfGeneration += 1;
  csrfToken = typeof value === 'string' && value ? value : null;
  return true;
}
function getCsrfToken() { return csrfToken; }
function clearCsrfToken() { csrfGeneration += 1; csrfToken = null; }

if (typeof module !== 'undefined' && module.exports) module.exports = { createSessionReadGuard, sessionRestoreErrorMessage, beginCsrfRefresh, withSessionRead, setCsrfToken, getCsrfToken, clearCsrfToken };
else globalThis.RotaMotoSessionGuard = Object.freeze({ createSessionReadGuard, sessionRestoreErrorMessage, beginCsrfRefresh, withSessionRead, setCsrfToken, getCsrfToken, clearCsrfToken });
