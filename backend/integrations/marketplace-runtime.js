'use strict';

const crypto = require('node:crypto');
const { normalizeWebhook, verifyWebhookAndParse } = require('./keeta-protocol');
const { verifyWebhookSignature, normalizeOrderEvent, normalizeOrder } = require('../logistics/providers/ifood');
const { normalizeKeetaOrder } = require('./keeta-adapter');

const MAX_WEBHOOK_BYTES = 256 * 1024;
const PROVIDERS = new Set(['ifood', 'keeta']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function safeCode(value) { return /^[A-Z][A-Z0-9_]{1,63}$/u.test(value || '') ? value : 'MARKETPLACE_PROCESSING_FAILED'; }
function eventFor(provider, raw) {
  if (provider === 'ifood') return normalizeOrderEvent(raw);
  return normalizeWebhook(raw);
}

function createMarketplaceRuntime({ pool, adapters, accountResolver, clock = () => new Date(), logger = () => {} } = {}) {
  if (!pool || !adapters || !accountResolver || typeof accountResolver.byId !== 'function' || typeof accountResolver.byMerchant !== 'function')
    throw new TypeError('Marketplace runtime requires pool, adapters and privileged account resolver.');
  const now = () => clock().toISOString();

  async function tenantTransaction(companyId, operation) {
    if (!UUID.test(companyId || '')) throw Object.assign(new Error('Invalid tenant.'), { code: 'INVALID_TENANT' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [companyId]);
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  function validateAccount(account, provider) {
    if (!account || account.provider !== provider || !UUID.test(account.companyId || '') || !UUID.test(account.id || '') ||
        !UUID.test(account.integrationId || '') || account.status !== 'active' || account.authorized !== true || !account.merchantId) {
      throw Object.assign(new Error('Marketplace account is not active and authorized.'), { code: 'ACCOUNT_UNAVAILABLE', status: 404 });
    }
    return account;
  }

  async function ingest({ provider, rawBody, signature, headers = {}, accountId = null, deferProcessing = false }) {
    if (!PROVIDERS.has(provider) || !Buffer.isBuffer(rawBody) || rawBody.length < 1 || rawBody.length > MAX_WEBHOOK_BYTES) {
      throw Object.assign(new Error('Invalid webhook.'), { code: 'INVALID_WEBHOOK', status: 400 });
    }
    let event, account;
    if (provider === 'ifood') {
      if (!UUID.test(accountId || '')) throw Object.assign(new Error('Invalid account route.'), { code: 'ACCOUNT_UNAVAILABLE', status: 404 });
      const signingAccount = validateAccount(await accountResolver.byId(provider, accountId), provider);
      if (!verifyWebhookSignature(rawBody, signature, signingAccount.webhookSecret)) throw Object.assign(new Error('Invalid signature.'), { code: 'INVALID_SIGNATURE', status: 401 });
      let raw;
      try { raw = JSON.parse(rawBody.toString('utf8')); } catch (_) { throw Object.assign(new Error('Invalid event body.'), { code: 'INVALID_WEBHOOK', status: 400 }); }
      event = eventFor(provider, raw);
      // iFood registers one webhook URL per application. The path account is
      // only the trusted signing key anchor; the signed merchantId routes each
      // event to its unique active tenant account after signature validation.
      account = event.merchantId ? validateAccount(await accountResolver.byMerchant(provider,event.merchantId),provider) : signingAccount;
    } else {
      const merchantId = headers['x-app-merchantid'] || headers['X-App-MerchantId'];
      if (typeof merchantId !== 'string') throw Object.assign(new Error('Missing merchant identity.'), { code: 'ACCOUNT_UNAVAILABLE', status: 404 });
      account = validateAccount(await accountResolver.byMerchant(provider, merchantId), provider);
      if(accountId&&account.id!==accountId)throw Object.assign(new Error('Webhook path does not match the authorized merchant account.'),{code:'ACCOUNT_UNAVAILABLE',status:404});
      const parsed = verifyWebhookAndParse(rawBody, signature, account.webhookSecret, headers);
      if (!parsed || parsed.externalAccountId !== account.merchantId) throw Object.assign(new Error('Invalid signature or merchant binding.'), { code: 'INVALID_SIGNATURE', status: 401 });
      event = parsed;
    }
    const normalized = Object.freeze({ id: event.externalEventId, orderId: event.externalOrderId,
      eventType: event.externalStatus || event.eventType || event.status || 'unknown',
      status: event.status || 'unmapped', occurredAt: event.occurredAt || null });
    const bodyDigest = digest(rawBody);
    const stored = await tenantTransaction(account.companyId, async client => {
      const result = await client.query(`INSERT INTO rotamoto.marketplace_event_inbox
        (company_id,event_id,external_account_id,provider,external_event_id,external_order_id,event_type,body_digest,event_data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        ON CONFLICT(provider,external_account_id,external_event_id) DO NOTHING RETURNING event_id`,
      [account.companyId, crypto.randomUUID(), account.id, provider, normalized.id, normalized.orderId,
        normalized.eventType, bodyDigest, JSON.stringify({ status: normalized.status, occurredAt: normalized.occurredAt })]);
      return result.rowCount === 1;
    });
    if(!deferProcessing)await processPending(account, normalized.id);
    const state = await tenantTransaction(account.companyId, client => client.query(`SELECT status FROM rotamoto.marketplace_event_inbox
      WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3`,[account.companyId,account.id,normalized.id]));
    if (!state.rowCount || !['processed','unmapped','rejected'].includes(state.rows[0].status)) {
      if(deferProcessing)return Object.freeze({duplicate:!stored,processed:false,queued:true});
      throw Object.assign(new Error('Event durably queued for retry.'),{code:'MARKETPLACE_EVENT_PENDING',status:503});
    }
    // Polling acknowledgments happen only after durable inbox and domain projection.
    return Object.freeze({ duplicate: !stored, processed: true });
  }

  async function processPending(account, externalEventId, claimedLeaseToken=null) {
    const leaseToken=crypto.randomUUID();
      const rows = await tenantTransaction(account.companyId, async client => claimedLeaseToken
        ? client.query(`SELECT event_id,external_order_id,event_data,received_at FROM rotamoto.marketplace_event_inbox
          WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3 AND status='processing' AND lease_token=$4`,
          [account.companyId,account.id,externalEventId,claimedLeaseToken])
        : client.query(`WITH candidate AS (
        SELECT event_id FROM rotamoto.marketplace_event_inbox WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3
          AND ((status IN ('received','retry') AND next_attempt_at<=now()) OR (status='processing' AND lease_until<now()))
          FOR UPDATE SKIP LOCKED
      ) UPDATE rotamoto.marketplace_event_inbox e SET status='processing',lease_token=$4,lease_until=now()+interval '90 seconds',attempts=attempts+1
        FROM candidate c WHERE e.company_id=$1 AND e.event_id=c.event_id
        RETURNING e.event_id,e.external_order_id,e.event_data,e.received_at`, [account.companyId, account.id, externalEventId,leaseToken]));
    const row = rows.rows[0]; if (!row) return false;
    const activeLease=claimedLeaseToken||leaseToken;
    try {
      const adapter = adapters[account.provider];
      const order = account.provider === 'ifood'
        ? await adapter.order({ companyId: account.companyId, orderId: row.external_order_id, credentials: account.credentials })
        : await adapter.order({ companyId: account.companyId, id: row.external_order_id });
      await tenantTransaction(account.companyId, async client => {
        const current = await client.query(`SELECT domain_order_id,last_event_at FROM rotamoto.marketplace_order_versions
          WHERE company_id=$1 AND external_account_id=$2 AND provider=$3 AND external_order_id=$4 FOR UPDATE`,
        [account.companyId, account.id, account.provider, row.external_order_id]);
        const occurred = row.event_data.occurredAt ? new Date(row.event_data.occurredAt) : new Date(row.received_at);
        const previous = current.rows[0];
        const isCurrent=!previous?.last_event_at||occurred>=new Date(previous.last_event_at);
        let domainOrderId = previous?.domain_order_id || crypto.randomUUID();
        const installation = await client.query(`INSERT INTO rotamoto.sync_installations(id,company_id,app_key,local_device_id)
          VALUES($1,$2,'restaurante',$3) ON CONFLICT(company_id,app_key,local_device_id) DO UPDATE SET last_seen_at=now() RETURNING id`,
        [crypto.randomUUID(), account.companyId, `marketplace-${account.provider}`]);
        const sourceInstallationId = installation.rows[0].id;
        if (!previous) {
          await client.query(`INSERT INTO rotamoto.domain_records(company_id,record_id,entity_type,source_app,source_installation_id,
            payload,version,created_at,updated_at) VALUES($1,$2,'Order','restaurante',$3,$4::jsonb,1,$5,$5)`,
          [account.companyId, domainOrderId, sourceInstallationId, JSON.stringify(canonicalOrder(account.provider, order)), occurred]);
        } else if (!previous.last_event_at || occurred >= new Date(previous.last_event_at)) {
          const existing = await client.query('SELECT payload,version,created_at FROM rotamoto.domain_records WHERE company_id=$1 AND record_id=$2 FOR UPDATE', [account.companyId, domainOrderId]);
          if (existing.rowCount) await client.query(`UPDATE rotamoto.domain_records SET payload=$3::jsonb,version=version+1,updated_at=GREATEST(updated_at,$4)
            WHERE company_id=$1 AND record_id=$2`, [account.companyId, domainOrderId,
            JSON.stringify({ ...existing.rows[0].payload, ...canonicalOrder(account.provider, order) }), occurred]);
        }
        await client.query(`INSERT INTO rotamoto.marketplace_order_versions(company_id,external_account_id,provider,external_order_id,last_event_at,last_event_id,domain_order_id)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(provider,external_account_id,external_order_id) DO UPDATE SET
          last_event_at=CASE WHEN marketplace_order_versions.last_event_at IS NULL OR EXCLUDED.last_event_at >= marketplace_order_versions.last_event_at THEN EXCLUDED.last_event_at ELSE marketplace_order_versions.last_event_at END,
          last_event_id=CASE WHEN marketplace_order_versions.last_event_at IS NULL OR EXCLUDED.last_event_at >= marketplace_order_versions.last_event_at THEN EXCLUDED.last_event_id ELSE marketplace_order_versions.last_event_id END,
          domain_order_id=marketplace_order_versions.domain_order_id,updated_at=now()`,
        [account.companyId, account.id, account.provider, row.external_order_id, occurred, row.event_id, domainOrderId]);
        if(isCurrent) {
          const matching={confirmed:['CONFIRM'],preparing:['START_PREPARATION'],ready:['READY'],dispatched:['DISPATCH_MERCHANT'],cancelled:['CANCEL_ORDER']}[row.event_data.status]||[];
          if(matching.length)await client.query(`UPDATE rotamoto.marketplace_command_outbox SET status='succeeded',completed_at=now(),lease_token=NULL,lease_until=NULL,
            last_error_code=NULL,updated_at=now() WHERE company_id=$1 AND external_account_id=$2 AND provider=$3 AND external_order_id=$4
              AND operation=ANY($5::text[]) AND status IN ('pending','unknown_outcome','needs_review')`,
          [account.companyId,account.id,account.provider,row.external_order_id,matching]);
        }
        await client.query(`UPDATE rotamoto.marketplace_event_inbox SET status='processed',processed_at=now(),last_error_code=NULL,lease_token=NULL,lease_until=NULL
          WHERE company_id=$1 AND event_id=$2 AND lease_token=$3`, [account.companyId, row.event_id,activeLease]);
        await client.query(`UPDATE rotamoto.external_accounts SET last_sync_at=now(),last_error_code=NULL,updated_at=now() WHERE company_id=$1 AND id=$2`, [account.companyId, account.id]);
      });
      return true;
    } catch (error) {
      const code = safeCode(error.code);
      await tenantTransaction(account.companyId, client => client.query(`UPDATE rotamoto.marketplace_event_inbox
        SET status=CASE WHEN attempts>=8 THEN 'rejected' ELSE 'retry' END,
            processed_at=CASE WHEN attempts>=8 THEN now() ELSE NULL END,lease_token=NULL,lease_until=NULL,
            next_attempt_at=now()+LEAST(interval '5 minutes',interval '1 second' * power(2,LEAST(attempts,8))),last_error_code=$2
        WHERE company_id=$1 AND event_id=$3 AND lease_token=$4`,
        [account.companyId,code,row.event_id,activeLease]));
      try { logger({ event: 'marketplace.order_processing_failed', provider: account.provider, errorCode: code }); } catch (_) {}
      throw error;
    }
  }

  async function processClaimed(account,externalEventId,leaseToken){
    validateAccount(account,account.provider);
    if(!UUID.test(leaseToken||''))throw Object.assign(new Error('Invalid inbox lease.'),{code:'INVALID_LEASE'});
    return processPending(account,externalEventId,leaseToken);
  }

  async function ingestPolled(account, events) {
    const processed = [];
    for (const event of events) {
      if (account.provider === 'ifood' && event.merchantId && event.merchantId !== account.merchantId)
        throw Object.assign(new Error('Polled event merchant does not match the authorized account.'), { code: 'ACCOUNT_UNAVAILABLE', status: 404 });
      const eventId = String(event.id);
      const normalizedEvent = account.provider === 'ifood'
        ? eventFor('ifood',{id:eventId,orderId:event.orderId,fullCode:event.fullCode||event.code,createdAt:event.createdAt})
        : eventFor('keeta',{externalEventId:eventId,externalAccountId:account.merchantId,externalOrderId:event.orderId,eventType:event.eventType,occurredAt:event.createdAt});
      const normalized = { id:eventId,orderId:normalizedEvent.externalOrderId,eventType:normalizedEvent.externalStatus||normalizedEvent.status,
        status:normalizedEvent.status,occurredAt:normalizedEvent.occurredAt||null };
      if (!normalized.orderId) continue;
      const stored = await tenantTransaction(account.companyId, async client => {
        const result = await client.query(`INSERT INTO rotamoto.marketplace_event_inbox
          (company_id,event_id,external_account_id,provider,external_event_id,external_order_id,event_type,body_digest,event_data)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(provider,external_account_id,external_event_id) DO NOTHING RETURNING event_id`,
        [account.companyId, crypto.randomUUID(), account.id, account.provider, normalized.id, normalized.orderId, normalized.eventType,
          digest(Buffer.from(JSON.stringify(event))), JSON.stringify({ status: normalized.status, occurredAt: normalized.occurredAt })]);
        if(result.rowCount===1)return 'received';
        const existing=await client.query(`SELECT status FROM rotamoto.marketplace_event_inbox WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3`,[account.companyId,account.id,normalized.id]);
        return existing.rows[0]?.status||'missing';
      });
      if (stored==='received'||stored==='retry'||stored==='processing') await processPending(account, eventId);
      const state=await tenantTransaction(account.companyId,client=>client.query(`SELECT status FROM rotamoto.marketplace_event_inbox WHERE company_id=$1 AND external_account_id=$2 AND external_event_id=$3`,[account.companyId,account.id,eventId]));
      if(state.rowCount&&['processed','unmapped','rejected'].includes(state.rows[0].status))processed.push(event);
    }
    if (processed.length) {
      const adapter = adapters[account.provider];
      if (account.provider === 'ifood') await adapter.acknowledgeEvents({ companyId: account.companyId, eventIds: processed.map(item => String(item.id)), credentials: account.credentials });
      else await adapter.acknowledgeEvents({ companyId: account.companyId, events: processed.map(item => ({ id: String(item.id), orderId: String(item.orderId), eventType: String(item.eventType) })) });
    }
    return processed.length;
  }

  async function pollAccount(account) {
    validateAccount(account, account.provider);
    const adapter = adapters[account.provider];
    const events = account.provider === 'ifood'
      ? await adapter.pollEvents({ companyId: account.companyId, credentials: account.credentials })
      : await adapter.pollEvents({ companyId: account.companyId, serviceMerchantIds: account.serviceMerchantIds });
    return ingestPolled(account, events);
  }

  async function enqueueCommand({ companyId, accountId, provider, externalOrderId, operation, idempotencyKey, commandData = {}, retryClass = 'reconcile_before_retry' }) {
    if (!PROVIDERS.has(provider) || !UUID.test(companyId) || !UUID.test(accountId) || !/^[A-Z_]{2,40}$/u.test(operation) ||
        typeof externalOrderId !== 'string' || !externalOrderId || typeof idempotencyKey !== 'string' || idempotencyKey.length < 16 ||
        !['safe_retry','idempotent','reconcile_before_retry','no_blind_retry'].includes(retryClass)) throw Object.assign(new Error('Invalid marketplace command.'), { code: 'INVALID_INPUT' });
    // Whitelist command data. Address, customer, credentials and opaque provider payloads are rejected.
    const allowed = new Set(['reason','quoteId','orderExternalCode','createdAt','preparationTime']);
    if (Object.keys(commandData).some(key => !allowed.has(key))) throw Object.assign(new Error('Unsafe command data.'), { code: 'INVALID_INPUT' });
    return tenantTransaction(companyId, async client => {
      const result = await client.query(`INSERT INTO rotamoto.marketplace_command_outbox
        (company_id,command_id,external_account_id,provider,external_order_id,operation,idempotency_key,command_data,retry_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(provider,external_account_id,operation,idempotency_key) DO NOTHING RETURNING command_id,status`,
      [companyId, crypto.randomUUID(), accountId, provider, externalOrderId, operation, idempotencyKey, JSON.stringify(commandData), retryClass]);
      return result.rows[0] || { duplicate: true };
    });
  }

  return Object.freeze({ ingest, ingestPolled, pollAccount, processPending, processClaimed, enqueueCommand });
}

function canonicalOrder(provider, order) {
  const items = Array.isArray(order.items) ? order.items.map(item => ({ name: String(item.name).slice(0,240), quantity: item.quantity })) : [];
  const result = { source: provider, externalId: order.externalId, externalDisplayId: order.externalDisplayId || null,
    status: order.status || null, orderType: order.orderType || null, items,
    // Marketplace totals and delivery prices are intentionally not converted or fabricated.
    amount: null, currency: null, logistics: null, createdAt: order.createdAt || null };
  if (provider === 'ifood') {
    result.customer = order.customer || null;
    result.address = order.address || null;
  }
  return result;
}

module.exports = { MAX_WEBHOOK_BYTES, digest, createMarketplaceRuntime, canonicalOrder, safeCode };
