'use strict';

function createMediaStorage({ provider = null } = {}) {
  function configured() {
    return !!provider && typeof provider.validateReference === 'function';
  }
  async function validateReference(reference, metadata) {
    if (!configured()) return { valid: false, code: 'MEDIA_STORAGE_UNAVAILABLE' };
    try {
      const valid = await provider.validateReference(reference, metadata);
      return valid === true ? { valid: true } : { valid: false, code: 'MEDIA_REFERENCE_INVALID' };
    } catch (_) {
      return { valid: false, code: 'MEDIA_REFERENCE_INVALID' };
    }
  }
  return Object.freeze({ configured, validateReference });
}

module.exports = { createMediaStorage };
