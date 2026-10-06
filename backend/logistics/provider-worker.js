'use strict';

const crypto = require('node:crypto');
const { retryDelayMs, resolveTestProviderConfiguration } = require('./provider-integration');
const { createProviderIntegrationService } = require('./provider-integration');

function createProviderCredentialResolver({ privilegedPool, secretProvider }) {
  if (!privilegedPool || !secretProvider) throw new TypeError('Keystore e conexão privilegiada são obrigatórios.');
  return async function resolve(companyId, providerId, providerCode) {
    const client = await privilegedPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
      const identity = await client.query('SELECT current_user AS role');
      if (identity.rows[0]?.role !== 'rotamoto_provider_resolver') {
        throw Object.assign(new Error('Credential resolver role is not isolated.'), { classification: 'AUTH', code: 'CREDENTIAL_ROLE_INVALID' });
      }
      const result = await client.query(`SELECT secret_ref FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_id=$2 AND code=$3 AND api_enabled`, [companyId,providerId,providerCode]);
      if (!result.rowCount || !result.rows[0].secret_ref) throw Object.assign(new Error('Credencial do provider não configurada.'), { classification: 'AUTH', code: 'NOT_CONFIGURED' });
      const serialized = await secretProvider.get(result.rows[0].secret_ref, { name: `logistics/${providerCode}`, scope: 'tenant', tenantId: companyId });
      let credentials; try { credentials = JSON.parse(serialized); } catch (_) { throw Object.assign(new Error('Credencial inválida.'), { classification: 'AUTH', code: 'CREDENTIAL_INVALID' }); }
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string' || Object.keys(credentials).some(key => !['clientId','clientSecret'].includes(key))) throw Object.assign(new Error('Credencial inválida.'), { classification: 'AUTH', code: 'CREDENTIAL_INVALID' });
      await client.query('COMMIT');
      return Object.freeze({ clientId: credentials.clientId, clientSecret: credentials.clientSecret });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  };
}

function createProviderWorker({ pool, adapterRegistry, credentialResolver, tenantResolver, testProvider = null, providerIntegration = createProviderIntegrationService({ testProvider }), logger = () => {}, clock = () => Date.now(), randomUUID = crypto.randomUUID, leaseSeconds = 45 } = {}) {
  if (!pool || !adapterRegistry || typeof credentialResolver !== 'function' || typeof tenantResolver !== 'function') throw new TypeError('Worker provider requer pool, adapters, tenant resolver e credential resolver.');
  if (testProvider && (process.env.NODE_ENV !== 'test' || typeof testProvider !== 'function')) throw new Error('Test provider configuration is restricted to NODE_ENV=test.');
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
  async function processOneEvent(companyId, client) {
    const selected = await client.query(`SELECT event_id,provider_id,external_event_id,normalized_event,status FROM rotamoto.provider_event_inbox
      WHERE company_id=$1 AND status='received' ORDER BY received_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1`, [companyId]);
    if (!selected.rowCount) return false;
    const event = selected.rows[0], normalized = event.normalized_event || {};
    const finishEvent = async status => {
      await client.query(`UPDATE rotamoto.provider_event_inbox SET status=$3,processed_at=now() WHERE company_id=$1 AND event_id=$2`,
        [companyId,event.event_id,status]);
      await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
        VALUES($1,$2,NULL,'webhook',$3,'provider_event',$4,$5::jsonb)`, [randomUUID(),companyId,
        `logistics.provider.event_${status}`,event.event_id,JSON.stringify({providerId:event.provider_id,eventId:event.external_event_id,status:normalized.status})]);
    };
    if (!['accepted','in_progress','arrived','completed','cancelled','failed'].includes(normalized.status) ||
        typeof normalized.externalOrderId !== 'string' || !normalized.occurredAt || !Number.isFinite(Date.parse(normalized.occurredAt))) {
      await finishEvent(normalized.status === 'unmapped' ? 'unmapped' : 'rejected');
      return true;
    }
    const matches = await client.query(`SELECT d.record_id AS delivery_id,f.fulfillment_id,f.status AS fulfillment_status,
        f.revision,f.selected_by,s.status AS tracking_status,s.provider_updated_at
      FROM rotamoto.domain_records o JOIN rotamoto.domain_records d ON d.company_id=o.company_id AND d.entity_type='Delivery'
        AND d.payload->>'orderId'=o.record_id::text
      JOIN rotamoto.delivery_fulfillments f ON f.company_id=d.company_id AND f.delivery_id=d.record_id AND f.provider_id=$3 AND f.mode='external'
        AND f.status IN ('selected','dispatch_requested','accepted','in_progress','arrived')
      LEFT JOIN rotamoto.provider_tracking_snapshots s ON s.company_id=f.company_id AND s.fulfillment_id=f.fulfillment_id
      WHERE o.company_id=$1 AND o.entity_type='Order' AND o.payload->>'source'='ifood' AND o.payload->>'externalId'=$2
        AND o.deleted_at IS NULL AND d.deleted_at IS NULL ORDER BY f.revision DESC LIMIT 2`,
    [companyId,normalized.externalOrderId,event.provider_id]);
    if (matches.rowCount !== 1) { await finishEvent('unmapped'); return true; }
    const current = matches.rows[0], occurredAt = new Date(normalized.occurredAt);
    if (current.provider_updated_at && occurredAt < current.provider_updated_at) { await finishEvent('processed'); return true; }
    const rank = { selected:0,dispatch_requested:1,accepted:2,in_progress:3,arrived:4,completed:5,cancelled:5,failed:5 };
    const currentStatus = current.tracking_status || current.fulfillment_status;
    if (['completed','cancelled','failed'].includes(currentStatus) && currentStatus !== normalized.status) {
      await finishEvent('rejected'); return true;
    }
    if ((rank[normalized.status] ?? -1) < (rank[currentStatus] ?? -1)) { await finishEvent('processed'); return true; }
    if (normalized.status !== current.fulfillment_status) await client.query(`UPDATE rotamoto.delivery_fulfillments SET status=$3,revision=revision+1,
      updated_by=selected_by,updated_at=now() WHERE company_id=$1 AND fulfillment_id=$2`, [companyId,current.fulfillment_id,normalized.status]);
    await client.query(`INSERT INTO rotamoto.provider_tracking_snapshots(company_id,fulfillment_id,delivery_id,provider_id,status,provider_updated_at,last_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,fulfillment_id) DO UPDATE SET status=EXCLUDED.status,
      provider_updated_at=EXCLUDED.provider_updated_at,last_event_id=EXCLUDED.last_event_id,updated_at=now()
      WHERE rotamoto.provider_tracking_snapshots.provider_updated_at IS NULL OR rotamoto.provider_tracking_snapshots.provider_updated_at<=EXCLUDED.provider_updated_at`,
    [companyId,current.fulfillment_id,current.delivery_id,event.provider_id,normalized.status,occurredAt,event.event_id]);
    const attemptStatus = ({accepted:'accepted',completed:'completed',cancelled:'cancelled',failed:'failed'})[normalized.status];
    if (attemptStatus) await client.query(`UPDATE rotamoto.dispatch_attempts SET status=$3,responded_at=$4
      WHERE company_id=$1 AND attempt_id=(SELECT attempt_id FROM rotamoto.dispatch_attempts WHERE company_id=$1 AND fulfillment_id=$2
        ORDER BY attempt_number DESC LIMIT 1) AND status IN ('requested','accepted')`, [companyId,current.fulfillment_id,attemptStatus,occurredAt]);
    const decisionStatus=({accepted:'executed',in_progress:'executed',arrived:'executed',completed:'executed',cancelled:'cancelled',failed:'failed'})[normalized.status];
    if(decisionStatus){
      const decisions=await client.query(`UPDATE rotamoto.logistics_decisions d SET status=$4,version=version+1,updated_at=now()
        WHERE d.company_id=$1 AND d.delivery_id=$2 AND d.status IN ('execution_requested','unknown_outcome')
          AND d.execution_result->>'commandId' IN (SELECT c.command_id::text FROM rotamoto.provider_command_outbox c
            WHERE c.company_id=$1 AND c.delivery_id=$2 AND c.fulfillment_id=$3 AND c.provider_id=$5 AND c.operation='DISPATCH_REQUEST')
        RETURNING d.decision_id,d.version`,[companyId,current.delivery_id,current.fulfillment_id,decisionStatus,event.provider_id]);
      for(const decision of decisions.rows)await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
        VALUES($1,$2,NULL,'worker',$3,'logistics_decision',$4,$5::jsonb)`,[randomUUID(),companyId,`logistics.decision.${decisionStatus}`,
        decision.decision_id,JSON.stringify({deliveryId:current.delivery_id,providerId:event.provider_id,eventId:event.external_event_id,version:decision.version})]);
    }
    await finishEvent('processed');
    return true;
  }
  async function processEventOnce() {
    const tenants = await tenantResolver();
    if (!Array.isArray(tenants)) throw new TypeError('Tenant resolver deve retornar uma lista bounded de IDs.');
    for (const companyId of tenants) {
      const consumed = await withTenant(companyId, client => processOneEvent(companyId,client));
      if (consumed) { logger({event:'provider.event.processed',companyId}); return true; }
    }
    return false;
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
      await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
        VALUES($1,$2,NULL,'worker',$3,'provider_command',$4,$5::jsonb)`, [randomUUID(),command.company_id,
        `logistics.provider.command_${status}`,command.command_id,JSON.stringify({ operation:command.operation,providerId:command.provider_id,
          correlationId:command.correlation_id,attempts:command.attempts,errorClass })]);
      const decisionStatus=status==='rejected'?'failed':status==='unknown_outcome'||status==='needs_review'?'unknown_outcome':null;
      if(decisionStatus&&command.operation==='DISPATCH_REQUEST'){
        const decisions=await client.query(`UPDATE rotamoto.logistics_decisions SET status=$4,version=version+1,updated_at=now()
          WHERE company_id=$1 AND delivery_id=$2 AND status='execution_requested' AND execution_result->>'commandId'=$3
          RETURNING decision_id,version`,[command.company_id,command.delivery_id,String(command.command_id),decisionStatus]);
        for(const decision of decisions.rows)await client.query(`INSERT INTO rotamoto.audit_log(id,company_id,actor_user_id,actor_kind,action,resource_type,resource_id,details)
          VALUES($1,$2,NULL,'worker',$3,'logistics_decision',$4,$5::jsonb)`,[randomUUID(),command.company_id,`logistics.decision.${decisionStatus}`,
          decision.decision_id,JSON.stringify({deliveryId:command.delivery_id,providerId:command.provider_id,commandId:command.command_id,
            errorClass,version:decision.version})]);
      }
    });
  }
  async function runOnce() {
    if (await processEventOnce()) return true;
    const leaseToken = randomUUID();
    const command = await claim(leaseToken);
    if (!command) return false;
    const context = { companyId: command.company_id, providerId: command.provider_id, deliveryId: command.delivery_id,
      fulfillmentId: command.fulfillment_id, commandId: command.command_id, correlationId: command.correlation_id,
      idempotencyKey: command.idempotency_key };
    try {
      const resolved = await withTenant(command.company_id, async client => {
        const result = await client.query(`SELECT code,capabilities,enabled,api_enabled FROM rotamoto.logistics_providers WHERE company_id=$1 AND provider_id=$2`, [command.company_id,command.provider_id]);
        return { provider: result.rows[0] || null, test: resolveTestProviderConfiguration(testProvider, command.company_id, command.provider_id) };
      });
      const { provider, test } = resolved;
      if (!provider || !provider.enabled || (!provider.api_enabled && !test)) {
        await finish({ ...command }, leaseToken, { status: 'needs_review', errorClass: 'AUTH' });
        return true;
      }
      const requiredCapability = { QUOTE_REQUEST:'quote', DISPATCH_REQUEST:'dispatch', CANCEL_REQUEST:'cancel', TRACKING_REFRESH:'tracking', RECONCILE:'tracking' }[command.operation];
      if (!(test?.capabilities || provider.capabilities || []).includes(requiredCapability)) {
        await finish(command, leaseToken, { status: 'rejected', errorClass: 'PERMANENT' });
        return true;
      }
      const adapter = adapterRegistry.get(provider.code);
      const operationMethod = { QUOTE_REQUEST: 'quote', DISPATCH_REQUEST: 'dispatch', CANCEL_REQUEST: 'cancel',
        TRACKING_REFRESH: 'tracking', RECONCILE: 'reconcile' }[command.operation];
      if (!adapter || !operationMethod || typeof adapter[operationMethod] !== 'function') {
        await finish(command, leaseToken, { status: 'rejected', errorClass: 'PERMANENT' });
        return true;
      }
      const credentials = await credentialResolver(command.company_id, command.provider_id, provider.code);
      const orderContext = await withTenant(command.company_id, async client => {
        const result = await client.query(`SELECT o.payload->>'externalId' AS external_order_id,o.payload->>'source' AS order_source
          FROM rotamoto.domain_records d JOIN rotamoto.domain_records o
            ON o.company_id=d.company_id AND o.record_id::text=(d.payload->>'orderId') AND o.entity_type='Order'
          WHERE d.company_id=$1 AND d.record_id=$2 AND d.entity_type='Delivery' AND d.deleted_at IS NULL
            AND o.deleted_at IS NULL`, [command.company_id, command.delivery_id]);
        return result.rows[0] || null;
      });
      const quoteContext = command.operation === 'DISPATCH_REQUEST' ? await withTenant(command.company_id, async client => {
        const result = await client.query(`SELECT external_quote_id FROM rotamoto.provider_quotes WHERE company_id=$1 AND quote_id=$2 AND provider_id=$3`,
          [command.company_id, command.payload.quoteId, command.provider_id]);
        return result.rows[0]?.external_quote_id || null;
      }) : null;
      const result = await adapter[operationMethod]({ ...context, payload: { ...command.payload,
        ...(orderContext?.order_source === 'ifood' && orderContext?.external_order_id ? { externalOrderId: orderContext.external_order_id } : {}),
        ...(quoteContext ? { externalQuoteId: quoteContext } : {}) }, credentials });
      await withTenant(command.company_id, async client => {
        if (command.operation === 'QUOTE_REQUEST' && result?.quote) await providerIntegration.saveQuote(client, command.company_id, command.provider_id,
          command.delivery_id, result.quote, { fulfillmentId: command.fulfillment_id });
        if (['TRACKING_REFRESH','RECONCILE'].includes(command.operation) && result?.provider) {
          const tracking = result, eta = tracking.expectedDelivery || tracking.etaAt || null;
          const status = ['accepted','in_progress','arrived','completed','cancelled','failed','unmapped'].includes(tracking.status) ? tracking.status : null;
          await client.query(`INSERT INTO rotamoto.provider_tracking_snapshots(company_id,fulfillment_id,delivery_id,provider_id,status,eta_at,provider_updated_at)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id,fulfillment_id) DO UPDATE SET status=COALESCE(EXCLUDED.status,rotamoto.provider_tracking_snapshots.status),eta_at=EXCLUDED.eta_at,
            provider_updated_at=EXCLUDED.provider_updated_at,updated_at=now() WHERE rotamoto.provider_tracking_snapshots.provider_updated_at IS NULL OR
              rotamoto.provider_tracking_snapshots.provider_updated_at<=EXCLUDED.provider_updated_at`,
          [command.company_id,command.fulfillment_id,command.delivery_id,command.provider_id,status,eta,tracking.trackedAt || new Date(clock())]);
        }
        if (command.operation === 'DISPATCH_REQUEST' && result?.status === 'confirmed') {
          await client.query(`UPDATE rotamoto.dispatch_attempts SET status='accepted',responded_at=now(),external_reference=$3 WHERE company_id=$1 AND attempt_id=$2 AND status='requested'`, [command.company_id,command.payload.dispatchAttemptId,result.externalReference || null]);
        }
      });
      const status = ['pending','requested','confirmed'].includes(result?.status) || result?.quote ? 'succeeded' : 'needs_review';
      await finish(command, leaseToken, { status });
      logger({ event: 'provider.command.completed', ...context, operation: command.operation, outcome: result?.status || (result?.quote ? 'quote_received' : 'unknown') });
    } catch (error) {
      const classes = { transient: 'TRANSIENT', rate_limit: 'RATE_LIMIT', auth: 'AUTH', permanent: 'PERMANENT', conflict: 'CONFLICT', unknown: 'UNKNOWN_OUTCOME' };
      const candidateClass = classes[error?.classification] || error?.classification;
      const classification = ['TRANSIENT','RATE_LIMIT','AUTH','PERMANENT','CONFLICT','UNKNOWN_OUTCOME'].includes(candidateClass) ? candidateClass : 'UNKNOWN_OUTCOME';
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
  return Object.freeze({ runOnce, run, processEventOnce, stop() { stopping = true; } });
}

module.exports = { createProviderCredentialResolver, createProviderWorker };
