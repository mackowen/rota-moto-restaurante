'use strict';

// Test fixture composition only. It reuses the runtime role and the real
// application/domain/outbox/inbox/worker paths; the claim implementation is a
// tenant+provider-scoped test equivalent of the production SECURITY DEFINER
// function because rotamoto_app is deliberately denied EXECUTE on that RPC.
if (process.env.NODE_ENV !== 'test') throw new Error('Provider browser E2E runtime is available only in NODE_ENV=test.');

const { createLogisticsService } = require('../../backend/logistics/service');
const { createProviderIntegrationService } = require('../../backend/logistics/provider-integration');
const { createProviderWorker } = require('../../backend/logistics/provider-worker');
const { createFakeLogisticsProvider } = require('../helpers/fake-logistics-provider');

function createProviderBrowserRuntime({ pool, outcomes = ['pending', 'timeout', 'pending'] } = {}) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Provider browser E2E runtime is available only in NODE_ENV=test.');
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('E2E runtime pool required.');
  let configuration = null;
  const testProvider = (companyId, providerId) => configuration?.companyId === companyId && configuration?.providerId === providerId
    ? { ...configuration, adapter: 'fake', providerCode: 'ifood', capabilities: ['quote','dispatch','cancel','tracking'] } : null;
  const providerIntegration = createProviderIntegrationService({ testProvider });
  const logisticsService = createLogisticsService({ providerIntegration, testProvider });
  const fake = createFakeLogisticsProvider({ outcomes });
  const fakeAdapter = Object.freeze({
    async quote(context) { return { quote: await fake.quote(context) }; },
    dispatch: context => fake.dispatch(context), cancel: context => fake.cancel(context),
    tracking: context => fake.tracking(context), reconcile: context => fake.reconcile(context)
  });
  const registry = Object.freeze({ get(code) { return code === 'ifood' && configuration ? fakeAdapter : null; }, codes() { return configuration ? ['ifood'] : []; } });
  const workerPool = {
    async connect() { return pool.connect(); },
    async query(sql, values) {
      if (!/SELECT\s+\*\s+FROM\s+rotamoto\.claim_provider_command\(/iu.test(sql)) throw new Error('E2E provider worker rejected unexpected global query.');
      const [companyId, leaseToken, leaseSeconds] = values;
      if (!configuration || companyId !== configuration.companyId) throw new Error('E2E provider worker rejected cross-tenant claim.');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
        const candidate = await client.query(`SELECT command_id FROM rotamoto.provider_command_outbox
          WHERE company_id=$1 AND provider_id=$2 AND status='queued' AND next_attempt_at<=now() AND attempts<8
          ORDER BY next_attempt_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [companyId,configuration.providerId]);
        if (!candidate.rowCount) { await client.query('COMMIT'); return { rows: [], rowCount: 0 }; }
        const claimed = await client.query(`UPDATE rotamoto.provider_command_outbox SET status='leased',lease_token=$3,
          lease_until=now()+make_interval(secs=>least(greatest($4,10),120)),attempts=attempts+1,updated_at=now()
          WHERE company_id=$1 AND provider_id=$2 AND command_id=$5 AND status='queued'
          RETURNING company_id,command_id,provider_id,delivery_id,fulfillment_id,operation,idempotency_key,payload,attempts,correlation_id`,
        [companyId,configuration.providerId,leaseToken,leaseSeconds,candidate.rows[0].command_id]);
        await client.query('COMMIT'); return claimed;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    }
  };
  const worker = createProviderWorker({ pool: workerPool, adapterRegistry: registry, providerIntegration, testProvider,
    credentialResolver: async (companyId, providerId) => {
      if (!configuration || companyId !== configuration.companyId || providerId !== configuration.providerId) throw new Error('E2E fake credential scope mismatch.');
      return Object.freeze({ clientId: 'test-only', clientSecret: 'test-only' });
    }, tenantResolver: async () => configuration ? [configuration.companyId] : [], logger: () => {} });
  return Object.freeze({ logisticsService, providerIntegration, worker, fake,
    configure({ companyId, providerId }) {
      if (process.env.NODE_ENV !== 'test' || typeof companyId !== 'string' || typeof providerId !== 'string') throw new Error('Invalid E2E provider scope.');
      configuration = Object.freeze({ companyId, providerId });
    },
    async ingestEvent(client, input) {
      if (!configuration || input.companyId !== configuration.companyId || input.providerId !== configuration.providerId) throw new Error('E2E event scope mismatch.');
      return providerIntegration.ingestEvent(client, input);
    },
    async commandRows(client, companyId, deliveryId) {
      if (!configuration || companyId !== configuration.companyId) throw new Error('E2E command query scope mismatch.');
      return (await client.query(`SELECT command_id,operation,status,attempts,last_error_class,updated_at FROM rotamoto.provider_command_outbox
        WHERE company_id=$1 AND provider_id=$2 AND delivery_id=$3 ORDER BY created_at`, [companyId,configuration.providerId,deliveryId])).rows;
    }
  });
}

module.exports = { createProviderBrowserRuntime };
