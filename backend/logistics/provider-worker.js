'use strict';

const crypto = require('node:crypto');
const { retryDelayMs } = require('./provider-integration');

function createProviderCredentialResolver({ privilegedPool, secretProvider }) {
  if (!privilegedPool || !secretProvider) throw new TypeError('Keystore e conexão privilegiada são obrigatórios.');
  return async function resolve(companyId, providerId, providerCode) {
    const client = await privilegedPool.connect();
    try {
      const result = await client.query(`SELECT secret_ref FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_id=$2 AND code=$3 AND api_enabled`, [companyId,providerId,providerCode]);
      if (!result.rowCount || !result.rows[0].secret_ref) throw Object.assign(new Error('Credencial do provider não configurada.'), { classification: 'AUTH', code: 'NOT_CONFIGURED' });
      const serialized = await secretProvider.get(result.rows[0].secret_ref, { name: `logistics/${providerCode}`, scope: 'tenant', tenantId: companyId });
      let credentials; try { credentials = JSON.parse(serialized); } catch (_) { throw Object.assign(new Error('Credencial inválida.'), { classification: 'AUTH', code: 'CREDENTIAL_INVALID' }); }
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string' || Object.keys(credentials).some(key => !['clientId','clientSecret'].includes(key))) throw Object.assign(new Error('Credencial inválida.'), { classification: 'AUTH', code: 'CREDENTIAL_INVALID' });
      return Object.freeze({ clientId: credentials.clientId, clientSecret: credentials.clientSecret });
    } finally { client.release(); }
  };
}

function createProviderWorker({ pool, adapterRegistry, credentialResolver, tenantResolver, logger = () => {}, clock = () => Date.now(), randomUUID = crypto.randomUUID, leaseSeconds = 45 } = {}) {
  if (!pool || !adapterRegistry || typeof credentialResolver !== 'function' || typeof tenantResolver !== 'function') throw new TypeError('Worker provider requer pool, adapters, tenant resolver e credential resolver.');
  let stopping = false;
  async function withTenant(companyId, operation) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function claim(leaseToken) {
    const tenants = await tenantResolver();
    if (!Array.isArray(tenants)) throw new TypeError('Tenant resolver deve retornar uma lista bounded de IDs.');
    for (const companyId of tenants) {
      const result = await pool.query('SELECT * FROM rotamoto.claim_provider_command($1,$2,$3)', [companyId,leaseToken,leaseSeconds]);
      if (result.rows[0]) return result.rows[0];
    }
    return null;
  }
  async function finish(command, leaseToken, { status, errorClass = null, delayMs = null } = {}) {
    return withTenant(command.company_id, async client => {
      const nextAttempt = delayMs == null ? null : new Date(clock() + delayMs);
      const terminal = ['succeeded','rejected','unknown_outcome','needs_review'].includes(status);
      const result = await client.query(`UPDATE rotamoto.provider_command_outbox SET status=$4,lease_token=NULL,lease_until=NULL,
        next_attempt_at=COALESCE($5,next_attempt_at),last_error_class=$6,completed_at=CASE WHEN $7 THEN now() ELSE NULL END,updated_at=now()
        WHERE company_id=$1 AND command_id=$2 AND status='leased' AND lease_token=$3 RETURNING command_id`,
      [command.company_id,command.command_id,leaseToken,status,nextAttempt,errorClass,terminal]);
      if (!result.rowCount) throw Object.assign(new Error('Lease do comando expirou.'), { code: 'LEASE_LOST' });
    });
  }
  async function runOnce() {
    const leaseToken = randomUUID();
    const command = await claim(leaseToken);
    if (!command) return false;
    const context = { companyId: command.company_id, providerId: command.provider_id, deliveryId: command.delivery_id,
      fulfillmentId: command.fulfillment_id, commandId: command.command_id, correlationId: command.correlation_id,
      idempotencyKey: command.idempotency_key };
    try {
      const provider = await withTenant(command.company_id, async client => {
        const result = await client.query(`SELECT code,capabilities,enabled,api_enabled FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_id=$2`, [command.company_id,command.provider_id]);
        return result.rows[0] || null;
      });
      if (!provider || !provider.enabled || !provider.api_enabled) {
        await finish({ ...command }, leaseToken, { status: 'needs_review', errorClass: 'AUTH' });
        return true;
      }
      const adapter = adapterRegistry.get(provider.code);
      if (!adapter || typeof adapter[command.operation] !== 'function') {
        await finish(command, leaseToken, { status: 'rejected', errorClass: 'PERMANENT' });
        return true;
      }
      const credentials = await credentialResolver(command.company_id, command.provider_id, provider.code);
      const result = await adapter[command.operation]({ ...context, payload: command.payload, credentials });
      await withTenant(command.company_id, async client => {
        if (command.operation === 'QUOTE_REQUEST' && result?.quote) await adapterRegistry.persistQuote(client, command, result.quote);
        if (command.operation === 'DISPATCH_REQUEST' && result?.status === 'confirmed') {
          await client.query(`UPDATE rotamoto.dispatch_attempts SET status='accepted',responded_at=now(),external_reference=$3 WHERE company_id=$1 AND attempt_id=$2 AND status='requested'`, [command.company_id,command.payload.dispatchAttemptId,result.externalReference || null]);
        }
      });
      const status = result?.status === 'pending' ? 'succeeded' : result?.status === 'confirmed' || result?.quote ? 'succeeded' : 'needs_review';
      await finish(command, leaseToken, { status });
      logger({ event: 'provider.command.completed', ...context, operation: command.operation, outcome: result?.status || (result?.quote ? 'quote_received' : 'unknown') });
    } catch (error) {
      const classification = ['TRANSIENT','RATE_LIMIT','AUTH','PERMANENT','CONFLICT','UNKNOWN_OUTCOME'].includes(error?.classification) ? error.classification : 'UNKNOWN_OUTCOME';
      const ambiguousOperation = ['DISPATCH_REQUEST','CANCEL_REQUEST'].includes(command.operation);
      const delay = retryDelayMs({ attempts: Number(command.attempts), classification, retryAfterSeconds: error?.retryAfterSeconds, seed: command.command_id });
      const outcome = ambiguousOperation && classification === 'UNKNOWN_OUTCOME' ? 'unknown_outcome'
        : classification === 'AUTH' || classification === 'PERMANENT' || classification === 'CONFLICT' ? 'rejected'
          : delay == null ? 'needs_review' : 'queued';
      await finish(command, leaseToken, { status: outcome, errorClass: classification, delayMs: outcome === 'queued' ? delay : null });
      logger({ event: 'provider.command.failed', ...context, operation: command.operation, errorClass: classification, outcome });
    }
    return true;
  }
  async function run({ pollIntervalMs = 1000 } = {}) {
    while (!stopping) {
      const hadWork = await runOnce();
      if (!hadWork) await new Promise(resolve => { const timer = setTimeout(resolve, pollIntervalMs); timer.unref?.(); });
    }
  }
  return Object.freeze({ runOnce, run, stop() { stopping = true; } });
}

module.exports = { createProviderCredentialResolver, createProviderWorker };
