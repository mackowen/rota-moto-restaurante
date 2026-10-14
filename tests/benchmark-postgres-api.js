'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { runFixtureLifecycle } = require('./e2e-support/fixture-lifecycle');
const { readFixtureManifest, updateFixtureManifest } = require('./e2e-support/fixture-manifest');

const ROWS = Number(process.env.API_BENCH_ROWS || 250);
const WAVES = 3;
if (process.env.NODE_ENV !== 'test' || process.env.ROTAMOTO_E2E_CAMPAIGN !== '0155' ||
    !Number.isSafeInteger(ROWS) || ROWS < 50 || ROWS > 1000) {
  throw new Error('API performance benchmark requires campaign 0155 and 50–1000 synthetic rows in rotamoto_e2e.');
}

function percentile(values, fraction) { return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]; }
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: +percentile(sorted, 0.50).toFixed(2), p95Ms: +percentile(sorted, 0.95).toFixed(2),
    p99Ms: +percentile(sorted, 0.99).toFixed(2), requests: sorted.length };
}

runFixtureLifecycle({ businessFixture: false, independentRequestTransactions: true, retainIndependentFixture: true,
  exercise: async fixture => {
    const installation = await fixture.runtime.query(`SELECT id::text FROM rotamoto.sync_installations
      WHERE company_id=$1 AND app_key='restaurante' AND local_device_id=$2`, [fixture.companyId, fixture.restaurantDevice]);
    assert.equal(installation.rowCount, 1, 'benchmark uses its own authenticated E2E installation');
    const ids = Array.from({ length: ROWS }, () => crypto.randomUUID());
    const now = new Date().toISOString();
    const payloads = ids.map((id, index) => JSON.stringify({ id, companyId: fixture.companyId, version: 1,
      number: `PERF-0155-${String(index + 1).padStart(4, '0')}`, source: 'manual', status: 'CREATED',
      createdAt: now, updatedAt: now, items: [{ name: 'Synthetic benchmark item', quantity: 1 }] }));
    const manifest = await readFixtureManifest(fixture.fixtureManifest.file);
    const priorOrders = manifest.records.orders || [];
    await updateFixtureManifest({ runId: fixture.fixtureManifest.runId,
      records: { ...manifest.records, orders: [...priorOrders, ...ids] },
      evidence: [...(manifest.evidence || []), { kind: 'api-performance-fixture', table: 'domain_records', rows: ROWS,
        note: 'Synthetic Orders are committed only in rotamoto_e2e and explicitly retained with append-only audit dependencies.' }] });
    await fixture.runtime.query(`INSERT INTO rotamoto.domain_records
      (company_id,record_id,entity_type,source_app,source_installation_id,related_entity_type,related_record_id,
       payload,version,created_at,updated_at)
      SELECT $1,input.id,'Order','restaurante',$2,NULL,NULL,input.payload::jsonb,1,now(),now()
      FROM unnest($3::uuid[],$4::text[]) AS input(id,payload)`,
    [fixture.companyId, installation.rows[0].id, ids, payloads]);
    await fixture.enableIndependentRequestTransactions();

    const planResult = await fixture.runtime.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT record_id::text,payload,version,created_at,updated_at,deleted_at
      FROM rotamoto.domain_records WHERE company_id=$1 AND entity_type='Order' AND deleted_at IS NULL
      ORDER BY updated_at DESC,record_id ASC LIMIT 101`, [fixture.companyId]);
    const plan = planResult.rows[0]['QUERY PLAN'][0];
    const rows = [];
    for (const users of [1, 5, 10]) {
      const latencies = []; let elapsedTotalMs = 0; let errors = 0; let responseRows = null;
      for (let wave = 0; wave < WAVES; wave++) {
        const startedWave = performance.now();
        const results = await Promise.all(Array.from({ length: users }, async () => {
          const started = performance.now();
          const response = await fixture.authenticatedCall('/api/domain/orders?limit=100');
          const duration = performance.now() - started;
          if (response.status !== 200 || !Array.isArray(response.body?.records)) { errors++; return duration; }
          responseRows = response.body.records.length;
          if (response.body.hasMore !== true) errors++;
          latencies.push(duration);
          return duration;
        }));
        elapsedTotalMs += performance.now() - startedWave;
        if (results.some(value => !Number.isFinite(value))) errors++;
      }
      assert.equal(errors, 0, `API benchmark had ${errors} failed or malformed list responses at ${users} concurrent clients`);
      assert.equal(responseRows, 100, 'query remains paginated to 100 rows');
      rows.push({ virtualClients: users, waves: WAVES, concurrentRequests: users * WAVES, responseRows,
        latency: summarize(latencies), throughputRequestsPerSecond: +(latencies.length / (elapsedTotalMs / 1000)).toFixed(2) });
    }
    process.stdout.write(`${JSON.stringify({ target: 'rotamoto_e2e', role: 'rotamoto_app', fixtureRunId: fixture.fixtureManifest.runId,
      retainedSyntheticOrders: ROWS, concurrentPrincipal: 'one authenticated synthetic tenant session; independent HTTP/DB requests',
      queryPlan: plan, api: rows }, null, 2)}\n`);
  }}).catch(error => { console.error(error); process.exitCode = 1; });
