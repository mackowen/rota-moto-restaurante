'use strict';

const assert = require('node:assert/strict');
const { createFilesystemObjectStore } = require('../backend/domain/filesystem-object-store');
const { runFixtureLifecycle } = require('./e2e-support/fixture-lifecycle');

const PNG = Buffer.from([137,80,78,71,13,10,26,10,0]);

runFixtureLifecycle({ exercise: async fixture => {
  assert(fixture.proof?.canonicalProofId && fixture.proof?.storageRef,
    'fixture created a canonical DeliveryProof backed by filesystem-v1');
  const tenantB = await fixture.provisionAdditionalTenant({
    companyName: 'E2E media isolation tenant', email: `e2e-media-${require('node:crypto').randomUUID()}@example.invalid`
  });
  const path = `/api/domain/deliveries/${fixture.deliveryId}/proofs/${fixture.proof.canonicalProofId}/media`;
  const denied = await fetch(`${fixture.apiOrigin}${path}`, {
    headers: { Origin: fixture.apiOrigin, Cookie: tenantB.cookie }
  });
  const deniedBody = await denied.json();
  assert.equal(denied.status, 404, 'another tenant cannot resolve the proof or receive media bytes');
  assert.equal(deniedBody.error.code, 'NOT_FOUND');
  assert.match(denied.headers.get('content-type') || '', /application\/json/u);

  const store = await createFilesystemObjectStore({ directory: fixture.mediaDirectory });
  const afterDeniedRead = await store.get(fixture.proof.storageRef, {
    contentType: fixture.proof.mimeType, sizeBytes: fixture.proof.sizeBytes, sha256: fixture.proof.sha256
  });
  assert.deepEqual(afterDeniedRead.data, PNG, 'denied cross-tenant read did not change the stored object');
  assert.equal(afterDeniedRead.sha256, fixture.proof.sha256);

  const unlinked = await fixture.authenticatedCall(`/api/admin/memberships/${fixture.membershipId}/driver`, { method: 'DELETE' });
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.body));
  const ownerMotoboyRead = await fetch(`${fixture.apiOrigin}/api/motoboy/domain/deliveries/${fixture.deliveryId}/proofs/${fixture.proof.canonicalProofId}/media`, {
    headers: { Origin: fixture.apiOrigin, Cookie: fixture.browserSessionCookie }
  });
  const ownerMotoboyBody = await ownerMotoboyRead.json();
  assert.equal(ownerMotoboyRead.status, 403, 'restaurant owner without a Driver binding cannot read proof bytes via Motoboy API');
  assert.equal(ownerMotoboyBody.error.code, 'DRIVER_LINK_REQUIRED');
  const rebound = await fixture.authenticatedCall(`/api/admin/memberships/${fixture.membershipId}/driver`, {
    method: 'PUT', body: { driverId: fixture.driverId }
  });
  assert.equal(rebound.status, 200, JSON.stringify(rebound.body));

  const ownerRead = await fetch(`${fixture.apiOrigin}${path}`, {
    headers: { Origin: fixture.apiOrigin, Cookie: fixture.browserSessionCookie }
  });
  assert.equal(ownerRead.status, 200, 'owning tenant retains authorized access');
  assert.deepEqual(Buffer.from(await ownerRead.arrayBuffer()), PNG);
  console.log('filesystem-v1 authenticated HTTP tenant isolation, deny-without-bytes and object integrity: PASS');
} }).catch(error => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
