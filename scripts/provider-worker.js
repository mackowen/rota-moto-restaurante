'use strict';

const { createPool } = require('../backend/postgres/connection');
const { loadRuntimeConfig } = require('../backend/runtime/config');
const { loadSecretProvider, loadLocalSecretProvider } = require('../backend/runtime/secret-provider');
const { createIfoodAdapter } = require('../backend/logistics/providers/ifood');
const { createLogisticsProviderAdapterRegistry } = require('../backend/logistics/provider-adapters');
const { createProviderCredentialResolver, createProviderWorker } = require('../backend/logistics/provider-worker');

function providerTenantIds(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('ROTAMOTO_PROVIDER_WORKER_TENANTS precisa listar tenants autorizados.');
  const ids = [...new Set(value.split(',').map(item => item.trim()))];
  if (ids.length > 500 || ids.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))) {
    throw new Error('Lista de tenants do worker inválida.');
  }
  return Object.freeze(ids);
}

async function main(env = process.env) {
  if (env.ROTAMOTO_PROVIDER_WORKER_ENABLED !== 'true') throw new Error('Worker provider desativado. Defina ROTAMOTO_PROVIDER_WORKER_ENABLED=true em unidade de serviço autorizada.');
  const config = loadRuntimeConfig(env);
  const tenants = providerTenantIds(env.ROTAMOTO_PROVIDER_WORKER_TENANTS);
  const secretProvider = config.production
    ? (config.secretProviderModule ? loadSecretProvider(config.secretProviderModule)
      : loadLocalSecretProvider({ directory: config.secretStoreDirectory, masterKeyFile: config.secretMasterKeyFile }))
    : null;
  if (!secretProvider) throw new Error('Keystore de produção é obrigatório para o worker provider.');
  const workerUrl = env.ROTAMOTO_PROVIDER_WORKER_DATABASE_URL;
  const workerPasswordRef = env.ROTAMOTO_PROVIDER_WORKER_PASSWORD_REF;
  const resolverUrl = env.ROTAMOTO_PROVIDER_RESOLVER_DATABASE_URL;
  const resolverPasswordRef = env.ROTAMOTO_PROVIDER_RESOLVER_PASSWORD_REF;
  if (!workerUrl || !workerPasswordRef || !resolverUrl || !resolverPasswordRef) throw new Error('Conexões/credenciais dedicadas de worker e credential resolver não configuradas.');
  const workerParsed = new URL(workerUrl);
  if (!['postgres:', 'postgresql:'].includes(workerParsed.protocol) || decodeURIComponent(workerParsed.username) !== 'rotamoto_provider_worker' ||
      workerParsed.password || workerParsed.pathname !== '/rotamoto' || workerParsed.search || workerParsed.hash) {
    throw new Error('Worker PostgreSQL deve usar rotamoto_provider_worker sem senha na URL e database rotamoto.');
  }
  const parsed = new URL(resolverUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || decodeURIComponent(parsed.username) !== 'rotamoto_provider_resolver' ||
      parsed.password || parsed.pathname !== '/rotamoto' || parsed.search || parsed.hash) {
    throw new Error('Resolver PostgreSQL deve usar rotamoto_provider_resolver sem senha na URL e database rotamoto.');
  }
  const workerPassword = async () => (await secretProvider).get(workerPasswordRef, { name: 'database/provider-worker', scope: 'installation' });
  const resolverPassword = async () => (await secretProvider).get(resolverPasswordRef, { name: 'database/provider-resolver', scope: 'installation' });
  const pool = createPool({ connectionString: workerUrl, password: workerPassword,
    ...(config.databaseTlsCaFile ? { ssl: { ca: require('node:fs').readFileSync(config.databaseTlsCaFile, 'utf8'), rejectUnauthorized: true } } : {}),
    max: 4, connectionTimeoutMillis: 3000, application_name: 'rotamoto-provider-worker', idleTimeoutMillis: 10000 });
  const resolverPool = createPool({ connectionString: resolverUrl, password: resolverPassword,
    ...(config.databaseTlsCaFile ? { ssl: { ca: require('node:fs').readFileSync(config.databaseTlsCaFile, 'utf8'), rejectUnauthorized: true } } : {}),
    max: 2, connectionTimeoutMillis: 3000, application_name: 'rotamoto-provider-credential-resolver', idleTimeoutMillis: 10000 });
  const credentialResolver = createProviderCredentialResolver({ privilegedPool: resolverPool, secretProvider: await secretProvider });
  const ifood = createIfoodAdapter({ credentialResolver });
  const worker = createProviderWorker({ pool, adapterRegistry: createLogisticsProviderAdapterRegistry({ ifoodAdapter: ifood }),
    credentialResolver, tenantResolver: async () => tenants,
    logger: event => process.stdout.write(`${JSON.stringify(event)}\n`) });
  let stopping = false;
  const shutdown = () => { if (stopping) return; stopping = true; worker.stop(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try { await worker.run({ pollIntervalMs: 1000 }); }
  finally { process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown); await Promise.all([pool.end(), resolverPool.end()]); }
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ event: 'provider.worker.start_failed', code: /^[A-Z0-9_]{2,48}$/u.test(error.code || '') ? error.code : 'WORKER_CONFIGURATION_INVALID' })}\n`);
  process.exitCode = 1;
});

module.exports = { providerTenantIds, main };
