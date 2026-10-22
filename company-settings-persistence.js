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

  function reconcileAddressDraft(savedMap, canonicalLocation) {
    const map = savedMap && typeof savedMap === 'object' ? savedMap : {};
    const location = canonicalLocation && typeof canonicalLocation === 'object' ? canonicalLocation : {};
    const canonicalAddress = String(location.address || '').trim();
    const savedAddress = String(map.restaurantAddress || '').trim();
    const hasCoordinates = location.latitude != null && location.longitude != null &&
      Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude));
    const pending = map.restaurantPublishStatus === 'pending';

    if (pending && savedAddress !== canonicalAddress) {
      return Object.freeze({
        preserveDraft: true,
        reconciled: false,
        map: { ...map, restaurantAddress: savedAddress, restaurantPublishStatus: 'pending' }
      });
    }

    return Object.freeze({
      preserveDraft: false,
      reconciled: pending,
      map: { ...map, restaurantAddress: canonicalAddress, restaurantConfirmedAddress: canonicalAddress,
        restaurantCoords: hasCoordinates ? [Number(location.latitude), Number(location.longitude)] : null,
        restaurantPendingCoords: null, restaurantLocationStale: false,
        restaurantPublishStatus: hasCoordinates ? 'published' : 'not-sent' }
    });
  }

  return Object.freeze({ updateAndReadback, reconcileAddressDraft });
});
