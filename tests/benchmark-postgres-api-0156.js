'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { createE2eClients, assertConnectedIdentity } = require('./e2e-support/guards');
const { runFixtureLifecycle } = require('./e2e-support/fixture-lifecycle');

const ROWS_PER_TENANT = Number(process.env.CAMPAIGN_0156_ROWS_PER_TENANT || 125);
const TOTAL_ROWS = ROWS_PER_TENANT * 2;
const WAVES = 3;
const POOL_MAX = Number(process.env.CAMPAIGN_0156_POOL_MAX || 5);
let currentProfilePhase = 'setup';
const requestProfiles = [];
if (process.env.NODE_ENV !== 'test' || process.env.ROTAMOTO_E2E_CAMPAIGN !== '0156')
  throw new Error('API benchmark requires the explicit 0156 test campaign.');
if (!Number.isSafeInteger(POOL_MAX) || POOL_MAX < 1 || POOL_MAX > 20)
  throw new Error('CAMPAIGN_0156_POOL_MAX must be between 1 and 20.');
if (!Number.isSafeInteger(ROWS_PER_TENANT) || ROWS_PER_TENANT < 1 || ROWS_PER_TENANT > 500)
  throw new Error('CAMPAIGN_0156_ROWS_PER_TENANT must be between 1 and 500.');

function percentile(values, fraction) { return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]; }
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: +percentile(sorted, .5).toFixed(2), p95Ms: +percentile(sorted, .95).toFixed(2),
    p99Ms: +percentile(sorted, .99).toFixed(2), requests: sorted.length };
}
function planSummary(plan) {
  const nodes = [];
  function visit(node) { if (!node) return; nodes.push({ type: node['Node Type'], relation: node['Relation Name'] || null,
    index: node['Index Name'] || null, planRows: node['Plan Rows'], actualRows: node['Actual Rows'],
    actualLoops: node['Actual Loops'], sharedHit: node['Shared Hit Blocks'], sharedRead: node['Shared Read Blocks'],
    sortMethod: node['Sort Method'] || null, actualTotalMs: node['Actual Total Time'] });
    for (const child of node.Plans || []) visit(child); }
  visit(plan.Plan);
  return { planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], nodes };
}
function profileSummary(events) {
  return {
    total: summarize(events.map(row => row.totalMs)),
    poolWait: summarize(events.map(row => row.poolWaitMs)),
    sql: summarize(events.map(row => row.queryMs)),
    identityAndDomain: summarize(events.map(row => row.identityAndDomainMs || 0)),
    serialization: summarize(events.map(row => row.serializationMs || 0)),
    queryCount: summarize(events.map(row => row.queryCount)),
    queryClassTotalsMs: Object.fromEntries(['identity', 'authorization', 'domain_records', 'other'].map(key =>
      [key, +events.reduce((sum, row) => sum + (row.queryClasses[key] || 0), 0).toFixed(2)])),
    unaccountedP50Ms: +(percentile(events.map(row => row.totalMs), .5) - percentile(events.map(row => row.poolWaitMs), .5) -
      percentile(events.map(row => row.queryMs), .5)).toFixed(2)
  };
}
function resourceSnapshot() {
  const usage = process.resourceUsage();
  const memory = process.memoryUsage();
  return { userCpuMs: usage.userCPUTime / 1000, systemCpuMs: usage.systemCPUTime / 1000,
    rssMiB: +(memory.rss / 1048576).toFixed(1), heapUsedMiB: +(memory.heapUsed / 1048576).toFixed(1) };
}
async function addOrders(fixture, tenant, localDeviceId, count, label) {
  await fixture.runtime.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.companyId]);
  const installation = await fixture.runtime.query(`SELECT id::text FROM rotamoto.sync_installations
    WHERE company_id=$1 AND app_key='restaurante' AND local_device_id=$2`, [tenant.companyId, localDeviceId]);
  assert.equal(installation.rowCount, 1, `one authenticated E2E installation exists for ${label}`);
  const ids = Array.from({ length: count }, () => crypto.randomUUID());
  const payloads = ids.map((id, index) => JSON.stringify({ id, companyId: tenant.companyId, version: 1,
    number: `PERF-0156-${label}-${String(index + 1).padStart(4, '0')}`, source: 'manual', status: 'CREATED',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), items: [{ name: 'Synthetic item', quantity: 1 }] }));
  await fixture.registerFixtureTenant({ id: tenant.companyId, records: { orders: ids } });
  await fixture.runtime.query(`INSERT INTO rotamoto.domain_records
    (company_id,record_id,entity_type,source_app,source_installation_id,related_entity_type,related_record_id,
     payload,version,created_at,updated_at)
    SELECT $1,input.id,'Order','restaurante',$2,NULL,NULL,input.payload::jsonb,1,now(),now()
    FROM unnest($3::uuid[],$4::text[]) AS input(id,payload)`,
  [tenant.companyId, installation.rows[0].id, ids, payloads]);
  return ids;
}
async function explainFor(fixture, tenantId) {
  await fixture.runtime.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
  const result = await fixture.runtime.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
    SELECT record_id::text,payload,version,created_at,updated_at,deleted_at FROM rotamoto.domain_records
    WHERE company_id=$1 AND entity_type='Order' AND deleted_at IS NULL
    ORDER BY updated_at DESC,record_id ASC LIMIT 101`, [tenantId]);
  return planSummary(result.rows[0]['QUERY PLAN'][0]);
}
async function analyzeSyntheticRelation(fixture, tenantId) {
  const clients = createE2eClients();
  await clients.migrator.connect();
  try {
    const identity = await assertConnectedIdentity(clients.migrator, { role: 'rotamoto_migrator', database: 'rotamoto_e2e' });
    assert.equal(identity.rolbypassrls, false, 'E2E migrator does not bypass RLS');
    await clients.migrator.query('BEGIN');
    await clients.migrator.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await clients.migrator.query('ANALYZE rotamoto.domain_records');
    await clients.migrator.query('COMMIT');
    return { database: 'rotamoto_e2e', role: 'rotamoto_migrator', rlsBypass: false };
  } catch (error) {
    await clients.migrator.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await clients.migrator.end(); }
}

runFixtureLifecycle({ businessFixture: false, independentRequestTransactions: true, retainIndependentFixture: true,
  independentPoolSize: POOL_MAX, onRequestProfile: row => { requestProfiles.push({ ...row, phase: currentProfilePhase }); },
  exercise: async fixture => {
    const secondary = await fixture.provisionAdditionalTenant({ companyName: 'E2E 0156 Tenant B',
      email: `perf-owner-b-${crypto.randomUUID()}@example.invalid` });
    const primaryOwnerSession = await fixture.call('/api/identity/session', { cookie: fixture.browserSessionCookie });
    assert.equal(primaryOwnerSession.status, 200);
    const primarySessions = await fixture.createSyntheticAdminSessions({ ownerCookie: fixture.browserSessionCookie,
      ownerCsrf: primaryOwnerSession.body.csrfToken, labels: ['a02', 'a03', 'a04', 'a05'] });
    const secondarySessions = await fixture.createSyntheticAdminSessions({ ownerCookie: secondary.cookie,
      ownerCsrf: secondary.csrf, labels: ['b02', 'b03', 'b04', 'b05'] });
    const tenants = [{ companyId: fixture.companyId, localDeviceId: fixture.restaurantDevice, label: 'a', rows: ROWS_PER_TENANT },
      { companyId: secondary.companyId, localDeviceId: `tenant-b-${secondary.userId}`, label: 'b', rows: ROWS_PER_TENANT }];
    // Locate tenant B's fixture-owned installation without printing identifiers or secrets.
    await fixture.runtime.query("SELECT set_config('app.tenant_id',$1,true)", [secondary.companyId]);
    const deviceRows = await fixture.runtime.query(`SELECT local_device_id FROM rotamoto.sync_installations
      WHERE company_id=$1 AND app_key='restaurante' ORDER BY created_at DESC LIMIT 1`, [secondary.companyId]);
    assert.equal(deviceRows.rowCount, 1);
    tenants[1].localDeviceId = deviceRows.rows[0].local_device_id;
    const orders = [];
    for (const tenant of tenants) orders.push(await addOrders(fixture, tenant, tenant.localDeviceId, tenant.rows, tenant.label));
    await fixture.enableIndependentRequestTransactions();

    const sessions = [
      { label: 'a01', companyId: fixture.companyId, cookie: fixture.browserSessionCookie, csrf: fixture.csrf },
      ...primarySessions.map(row => ({ ...row })),
      { label: 'b01', companyId: secondary.companyId, cookie: secondary.cookie, csrf: secondary.csrf },
      ...secondarySessions.map(row => ({ ...row }))
    ];
    assert.equal(sessions.length, 10, 'ten independent authenticated session tokens are prepared');
    assert.equal(new Set(sessions.map(row => row.cookie)).size, 10, 'every virtual client has an independent session');
    assert.equal(new Set(sessions.map(row => row.companyId)).size, 2, 'the load is split over two synthetic tenants');
    const sessionCounts = [];
    for (const tenant of tenants) {
      await fixture.runtime.query("SELECT set_config('app.tenant_id',$1,true)", [tenant.companyId]);
      sessionCounts.push(await fixture.runtime.query('SELECT count(DISTINCT id)::int AS count FROM rotamoto.sessions WHERE active_company_id=$1 AND revoked_at IS NULL',
        [tenant.companyId]));
    }
    assert(sessionCounts.reduce((sum, result) => sum + result.rows[0].count, 0) >= 10,
      'ten live synthetic sessions are visible through tenant-scoped E2E reads');
    const plansBeforeAnalyze = {};
    for (const tenant of tenants) plansBeforeAnalyze[tenant.label] = await explainFor(fixture, tenant.companyId);

    const runLoad = async phase => {
      currentProfilePhase = phase;
      const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable(); delay.reset();
      const startMemory = resourceSnapshot(); const startUsage = process.resourceUsage();
      const startElu = performance.eventLoopUtilization(); const phaseStarted = performance.now();
      const rows = [];
      for (const users of [1, 5, 10]) {
        const selected = sessions.slice(0, users);
        // Include tenant B as soon as five clients are active, and keep both tenants at ten.
        if (users >= 5 && !selected.some(row => row.companyId === secondary.companyId)) selected[users - 1] = sessions[5];
        const latencies = []; let elapsedWall = 0; let errors = 0;
        for (let wave = 0; wave < WAVES; wave++) {
          const beforeWave = performance.now();
          const results = await Promise.all(selected.map(async client => {
            const started = performance.now();
            try {
              const response = await fixture.call('/api/domain/orders?limit=100', { cookie: client.cookie, csrf: client.csrf,
                headers: { 'X-Campaign-0156-Client': client.label } });
              const duration = performance.now() - started;
              if (response.status !== 200 || !Array.isArray(response.body?.records) || response.body.records.length !== 100 || response.body.hasMore !== true) {
                errors++; return duration;
              }
              latencies.push(duration); return duration;
            } catch (_) { errors++; return performance.now() - started; }
          }));
          elapsedWall += performance.now() - beforeWave;
          if (results.some(value => !Number.isFinite(value))) errors++;
        }
        assert.equal(errors, 0, `${phase} API had ${errors} errors with ${users} independent sessions`);
        rows.push({ clients: users, requests: latencies.length, latency: summarize(latencies),
          throughputRequestsPerSecond: +(latencies.length / (elapsedWall / 1000)).toFixed(2) });
      }
      const durationMs = performance.now() - phaseStarted;
      const elu = performance.eventLoopUtilization(startElu);
      const endUsage = process.resourceUsage(); const endMemory = resourceSnapshot();
      delay.disable();
      const captured = requestProfiles.filter(row => row.phase === phase);
      currentProfilePhase = 'setup';
      return { rows, requestProfile: captured.length ? profileSummary(captured) : null,
        process: { durationMs: +durationMs.toFixed(2), cpuUserMs: +((endUsage.userCPUTime - startUsage.userCPUTime) / 1000).toFixed(2),
          cpuSystemMs: +((endUsage.systemCPUTime - startUsage.systemCPUTime) / 1000).toFixed(2),
          eventLoopUtilization: +elu.utilization.toFixed(4), eventLoopDelayP95Ms: +(delay.percentile(95) / 1e6).toFixed(2),
          rssStartMiB: startMemory.rssMiB, rssEndMiB: endMemory.rssMiB, heapStartMiB: startMemory.heapUsedMiB, heapEndMiB: endMemory.heapUsedMiB } };
    };

    const baseline = await runLoad('baseline');
    const baselineCaptured = requestProfiles.filter(row => row.phase === 'baseline');
    const beforeSummary = profileSummary(baselineCaptured);
    const analyze = await analyzeSyntheticRelation(fixture, tenants[0].companyId);
    const plansAfterAnalyze = {};
    for (const tenant of tenants) plansAfterAnalyze[tenant.label] = await explainFor(fixture, tenant.companyId);
    const optimized = await runLoad('after_analyze');
    const afterCaptured = requestProfiles.filter(row => row.phase === 'after_analyze');
    const output = { campaign: '0156', target: 'rotamoto_e2e', runtimeRole: 'rotamoto_app', poolMax: POOL_MAX,
      rowsPerTenant: ROWS_PER_TENANT, totalSyntheticOrders: TOTAL_ROWS, manifestRunId: fixture.fixtureManifest.runId,
      tenants: tenants.map(row => ({ label: row.label, rows: row.rows })),
      sessions: { independent: sessions.length, distinctCookies: new Set(sessions.map(row => row.cookie)).size, tenants: 2 },
      method: `3 waves each at 1/5/10 clients; authenticated independent session per client; ${TOTAL_ROWS} synthetic Orders split across two E2E tenants; pool max ${POOL_MAX}`,
      apiBeforeAnalyze: { ...baseline, requestProfile: beforeSummary },
      postgresPlanBeforeAnalyze: plansBeforeAnalyze,
      analyze: { ...analyze, operation: 'ANALYZE rotamoto.domain_records only in rotamoto_e2e under migrator RLS tenant context' },
      postgresPlanAfterAnalyze: plansAfterAnalyze,
      apiAfterAnalyze: { ...optimized, requestProfile: profileSummary(afterCaptured) } };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  }}).catch(error => { console.error(error); process.exitCode = 1; });
