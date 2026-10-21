((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RotaMotoCompanySettingsPersistence = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, () => {
  async function updateAndReadback({ read, write, expectedRevision, revisionOf, matches }) {
    if (typeof read !== 'function' || typeof write !== 'function' ||
        typeof revisionOf !== 'function' || typeof matches !== 'function') {
      throw new TypeError('COMPANY_UPDATE_CONFIGURATION_INVALID');
    }
    const current = await read();
    const currentRevision = revisionOf(current);
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
      throw new Error('COMPANY_REVISION_INVALID');
    }
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
      throw new Error('REVISION_CONFLICT');
    }

    const acknowledgement = await write(current, currentRevision);
    const acknowledgedRevision = revisionOf(acknowledgement);
    if (!Number.isSafeInteger(acknowledgedRevision) || acknowledgedRevision <= currentRevision ||
        !matches(acknowledgement)) {
      throw new Error('COMPANY_WRITE_UNCONFIRMED');
    }

    const canonical = await read();
    if (revisionOf(canonical) !== acknowledgedRevision || !matches(canonical)) {
      throw new Error('COMPANY_READBACK_MISMATCH');
    }
    return canonical;
  }

  return Object.freeze({ updateAndReadback });
});
