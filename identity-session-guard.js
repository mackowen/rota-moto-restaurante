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

if (typeof module !== 'undefined' && module.exports) module.exports = { createSessionReadGuard, sessionRestoreErrorMessage };
else globalThis.RotaMotoSessionGuard = Object.freeze({ createSessionReadGuard, sessionRestoreErrorMessage });
