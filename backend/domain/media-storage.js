'use strict';

const { MAX_PROOF_BYTES } = require('./filesystem-object-store');

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg']);
function createMediaStorage({ objectStore = null, provider = null } = {}) {
  const configured = () => Boolean(objectStore && typeof objectStore.putProof === 'function' && typeof objectStore.get === 'function');
  async function storeProof(input) {
    if (!configured()) { const error = new Error('Armazenamento de mídia não configurado.'); error.code = 'MEDIA_STORAGE_UNAVAILABLE'; throw error; }
    if (!input || !ALLOWED_TYPES.has(input.contentType) || !input.source || typeof input.source.pipe !== 'function') {
      const error = new Error('Mídia inválida.'); error.code = 'MEDIA_INPUT_INVALID'; throw error;
    }
    const stored = await objectStore.putProof({ ...input, maxBytes: MAX_PROOF_BYTES });
    return Object.freeze({ storageRef: stored.reference, provider: objectStore.provider,
      mimeType: stored.contentType, sizeBytes: stored.sizeBytes, sha256: stored.sha256 });
  }
  async function validateReference(reference, metadata) {
    // Preserve the pre-existing server-side adapter contract used by configured storage providers.
    if (!objectStore && provider && typeof provider.validateReference === 'function') {
      const valid = await provider.validateReference(reference, metadata);
      return { valid: valid === true, ...(valid === true ? {} : { code: 'MEDIA_REFERENCE_INVALID' }) };
    }
    if (!configured()) return { valid: false, code: 'MEDIA_STORAGE_UNAVAILABLE' };
    if (!reference || reference.provider !== objectStore.provider || !metadata || !ALLOWED_TYPES.has(metadata.mimeType) ||
        !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 1 || metadata.sizeBytes > MAX_PROOF_BYTES ||
        typeof metadata.sha256 !== 'string' || !/^[a-f0-9]{64}$/iu.test(metadata.sha256)) return { valid: false, code: 'MEDIA_REFERENCE_INVALID' };
    try {
      const stored = await objectStore.get(reference, { contentType: metadata.mimeType, sizeBytes: metadata.sizeBytes, sha256: metadata.sha256 });
      return { valid: stored.sha256 === metadata.sha256 ? true : false };
    } catch (_) { return { valid: false, code: 'MEDIA_REFERENCE_INVALID' }; }
  }
  async function read(reference, metadata) {
    if (!configured()) { const error = new Error('Armazenamento de mídia não configurado.'); error.code = 'MEDIA_STORAGE_UNAVAILABLE'; throw error; }
    const result = await objectStore.get(reference, { contentType: metadata?.mimeType, sizeBytes: metadata?.sizeBytes, sha256: metadata?.sha256 });
    return result;
  }
  return Object.freeze({ configured, status: () => configured() ? objectStore.status() : { configured: false, provider: null }, storeProof, validateReference, read });
}

module.exports = { createMediaStorage, ALLOWED_TYPES };
