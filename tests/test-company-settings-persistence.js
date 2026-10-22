'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { updateAndReadback, reconcileAddressDraft } = require('../company-settings-persistence');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const profileFlow = app.slice(app.indexOf('async function publishCompanyProfile(){'), app.indexOf('async function publishCompanyRouteGroupingPolicy('));
const addressFlow = app.slice(app.indexOf('async function publishCompanyAddress('), app.indexOf('async function publishOperationalLocation('));
assert.match(profileFlow, /RotaMotoCompanySettingsPersistence\.updateAndReadback/u,
  'profile form uses the verified write/readback gate');
assert.match(profileFlow, /companyProfileDraftDirty=false/u,
  'profile draft is cleared only after the awaited canonical write/readback');
assert.match(addressFlow, /RotaMotoCompanySettingsPersistence\.updateAndReadback/u,
  'address form uses the verified write/readback gate');
assert.match(app, /restaurantPublishStatus:syncSession\?\.permissions\?\.includes\('company\.manage'\)\?'pending':'not-sent'[\s\S]*?await saveSettings/u,
  'an address awaiting its canonical write is marked before the durable local save');
assert.match(app, /reconcileAddressDraft\(state\.settings\.map,location\)/u,
  'canonical reload reconciles the durable address draft instead of blindly replacing it');
assert.match(app, /restaurantCoords:hasCoordinates\?\[Number\(location\.latitude\),Number\(location\.longitude\)\]:null/u,
  'the UI derives displayed Company coordinates from the canonical readback and keeps unknown coordinates null');

async function run() {
  let reads = 0;
  const canonical = { settingsVersion: 8, name: 'Casa Nova', supportPhone: null };
  const result = await updateAndReadback({
    read: async () => (++reads === 1 ? { settingsVersion: 7 } : canonical),
    write: async (_current, expectedVersion) => {
      assert.equal(expectedVersion, 7);
      return canonical;
    },
    expectedRevision: 7,
    revisionOf: value => value.settingsVersion,
    matches: value => value.name === 'Casa Nova' && value.supportPhone === null
  });
  assert.equal(reads, 2, 'success requires a canonical read after the write acknowledgement');
  assert.equal(result, canonical);

  const pendingDraft = { restaurantAddress: 'Rua digitada', restaurantConfirmedAddress: 'Rua canônica',
    restaurantCoords: [-23.5, -46.6], restaurantLocationStale: true, restaurantPublishStatus: 'pending' };
  const preserved = reconcileAddressDraft(pendingDraft, { address: 'Rua canônica', latitude: null, longitude: null });
  assert.equal(preserved.preserveDraft, true, 'a pending local address survives a reload while the server still has the old value');
  assert.equal(preserved.map.restaurantAddress, 'Rua digitada');
  assert.equal(preserved.map.restaurantLocationStale, true, 'coordinates for the old address remain marked stale');
  assert.deepEqual(preserved.map.restaurantCoords, [-23.5, -46.6]);

  const reconciled = reconcileAddressDraft(pendingDraft, { address: 'Rua digitada', latitude: null, longitude: null });
  assert.equal(reconciled.preserveDraft, false, 'a server readback matching the pending address resolves the uncertain save');
  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.map.restaurantPublishStatus, 'not-sent', 'unknown coordinates remain unknown after reconciliation');
  assert.equal(reconciled.map.restaurantLocationStale, false);
  assert.equal(reconciled.map.restaurantCoords, null);

  const ordinary = reconcileAddressDraft({ restaurantAddress: 'local-only', restaurantPublishStatus: 'not-sent' },
    { address: 'canonical', latitude: null, longitude: null });
  assert.equal(ordinary.map.restaurantAddress, 'canonical', 'ordinary local settings still load canonical Company values');

  let wrote = false;
  await assert.rejects(updateAndReadback({
    read: async () => ({ settingsVersion: 9 }),
    write: async () => { wrote = true; return {}; },
    expectedRevision: 8,
    revisionOf: value => value.settingsVersion,
    matches: () => true
  }), /REVISION_CONFLICT/u);
  assert.equal(wrote, false, 'stale form is rejected before writing');

  reads = 0;
  await assert.rejects(updateAndReadback({
    read: async () => (++reads === 1
      ? { operationalLocationVersion: 3 }
      : { operationalLocationVersion: 4, operationalLocation: { address: 'Rua B', latitude: null, longitude: null, provenance: null } }),
    write: async () => ({ operationalLocationVersion: 4,
      operationalLocation: { address: 'Rua A', latitude: null, longitude: null, provenance: null } }),
    expectedRevision: 3,
    revisionOf: value => value.operationalLocationVersion,
    matches: value => value.operationalLocation?.address === 'Rua A'
  }), /COMPANY_READBACK_MISMATCH/u);

  reads = 0;
  await assert.rejects(updateAndReadback({
    read: async () => (++reads === 1 ? { settingsVersion: 1 } : Promise.reject(new Error('READBACK_UNAVAILABLE'))),
    write: async () => ({ settingsVersion: 2, name: 'X' }),
    expectedRevision: 1,
    revisionOf: value => value.settingsVersion,
    matches: value => value.name === 'X'
  }), /READBACK_UNAVAILABLE/u, 'a failed canonical read must not be reported as success');

  await assert.rejects(updateAndReadback({
    read: async () => ({ settingsVersion: 1 }),
    write: async () => ({ settingsVersion: 1, name: 'X' }),
    expectedRevision: 1,
    revisionOf: value => value.settingsVersion,
    matches: value => value.name === 'X'
  }), /COMPANY_WRITE_UNCONFIRMED/u, 'an acknowledgement without an advanced revision is rejected');

  console.log('company settings persistence: canonical readback and failure gates passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
