'use strict';

function createSessionReadGuard() {
  let version = 0;
  return Object.freeze({
    capture: () => version,
    invalidate: () => ++version,
    isCurrent: captured => captured === version
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createSessionReadGuard };
else globalThis.RotaMotoSessionGuard = Object.freeze({ createSessionReadGuard });
