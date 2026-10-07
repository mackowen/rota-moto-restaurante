'use strict';

const crypto = require('node:crypto');
const { normalizeWebhook, verifyWebhookAndParse } = require('./keeta-protocol');
const { verifyWebhookSignature, normalizeOrderEvent, normalizeDeliveryEvent, normalizeOrder } = require('../logistics/providers/ifood');
const { normalizeKeetaOrder } = require('./keeta-adapter');

const MAX_WEBHOOK_BYTES = 256 * 1024;
const PROVIDERS = new Set(['ifood', 'keeta']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function digest(value) { return crypto.createHash('sha256').update(value).digest(); }
function safeCode(value) { return /^[A-Z][A-Z0-9_]{1,63}$/u.test(value || '') ? value : 'MARKETPLACE_PROCESSING_FAILED'; }
function eventFor(provider, raw) {
  if(provider==='ifood'){
    const order=normalizeOrderEvent(raw);
    if(order.status!=='unmapped')return Object.freeze({...order,kind:'order'});
    const delivery=normalizeDeliveryEvent(raw);
    return delivery.status!=='unmapped'?Object.freeze({...delivery,kind:'shipping'}):Object.freeze({...order,kind:'order'});
  }
  return Object.freeze({...normalizeWebhook(raw),kind:'order'});
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
      status: event.status || 'unmapped', occurredAt: event.occurredAt || null,kind:event.kind||'order',externalStatus:event.externalStatus||null });
    const bodyDigest = digest(rawBody);
    const stored = await tenantTransaction(account.companyId, async client => {
      const result = await client.query(`INSERT INTO rotamoto.marketplace_event_inbox
        (company_id,event_id,external_account_id,provider,external_event_id,external_order_id,event_type,body_digest,event_data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        ON CONFLICT(provider,external_account_id,external_event_id) DO NOTHING RETURNING event_id`,
      [account.companyId, crypto.randomUUID(), account.id, provider, normalized.id, normalized.orderId,
        normalized.eventType, bodyDigest, JSON.stringify({ status: normalized.status, occurredAt: normalized.occurredAt,kind:normalized.kind,externalStatus:normalized.externalStatus })]);
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
      if(account.provider==='ifood'&&row.event_data.kind==='shipping'){
        await tenantTransaction(account.companyId,async client=>{
          const occurred=row.event_data.occurredAt||row.received_at;
          const match={accepted:['SHIPPING_REQUEST'],in_progress:['SHIPPING_REQUEST'],completed:['SHIPPING_REQUEST'],cancelled:['SHIPPING_CANCEL','SHIPPING_REQUEST'],
            cancel_rejected:['SHIPPING_CANCEL'],failed:['SHIPPING_REQUEST']}[row.event_data.status]||[];
          const finalStatus=['failed','cancel_rejected'].includes(row.event_data.status)?'rejected':'succeeded';
          if(match.length)await client.query(`UPDATE rotamoto.marketplace_command_outbox SET status=$6,completed_at=now(),lease_token=NULL,lease_until=NULL,
            last_error_code=CASE WHEN $6='rejected' THEN 'SHIPPING_PROVIDER_REJECTED' ELSE NULL END,updated_at=now()
            WHERE company_id=$1 AND external_account_id=$2 AND provider='ifood' AND external_order_id=$3 AND operation=ANY($4::text[])
              AND created_at<=$5 AND status IN ('pending','unknown_outcome','needs_review')`,
          [account.companyId,account.id,row.external_order_id,match,occurred,finalStatus]);
          await client.query(`UPDATE rotamoto.marketplace_event_inbox SET status='processed',processed_at=now(),last_error_code=NULL,lease_token=NULL,lease_until=NULL
            WHERE company_id=$1 AND event_id=$2 AND lease_token=$3`,[account.companyId,row.event_id,activeLease]);
          await client.query(`UPDATE rotamoto.external_accounts SET last_sync_at=now(),last_error_code=NULL,updated_at=now() WHERE company_id=$1 AND id=$2`,[account.companyId,account.id]);
        });
        return true;
      }
      const adapter = adapters[account.provider];
      const order = account.provider === 'ifood'
        ? await adapter.order({ companyId: account.companyId, orderId: row.external_order_id, credentials: account.credentials })
        : await adapter.order({ companyId: account.companyId, id: row.external_order_id, credentials:account.credentials });
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
        status:normalizedEvent.status,occurredAt:normalizedEvent.occurredAt||null,kind:normalizedEvent.kind||'order',externalStatus:normalizedEvent.externalStatus||null };
      if (!normalized.orderId) continue;
      const stored = await tenantTransaction(account.companyId, async client => {
        const result = await client.query(`INSERT INTO rotamoto.marketplace_event_inbox
          (company_id,event_id,external_account_id,provider,external_event_id,external_order_id,event_type,body_digest,event_data)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(provider,external_account_id,external_event_id) DO NOTHING RETURNING event_id`,
        [account.companyId, crypto.randomUUID(), account.id, account.provider, normalized.id, normalized.orderId, normalized.eventType,
          digest(Buffer.from(JSON.stringify(event))), JSON.stringify({ status: normalized.status, occurredAt: normalized.occurredAt,kind:normalized.kind,externalStatus:normalized.externalStatus })]);
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
      else await adapter.acknowledgeEvents({ companyId: account.companyId, events: processed.map(item => ({ id: String(item.id), orderId: String(item.orderId), eventType: String(item.eventType) })),credentials:account.credentials });
    }
    return processed.length;
  }

  async function pollAccount(account) {
    validateAccount(account, account.provider);
    const adapter = adapters[account.provider];
    const events = account.provider === 'ifood'
      ? await adapter.pollEvents({ companyId: account.companyId, credentials: account.credentials })
      : await adapter.pollEvents({ companyId: account.companyId, serviceMerchantIds: account.serviceMerchantIds,credentials:account.credentials });
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

  const ORDER_COMMANDS = Object.freeze({
    ifood: new Set(['CONFIRM','START_PREPARATION','READY','DISPATCH_MERCHANT','CANCEL_ORDER','SHIPPING_QUOTE','SHIPPING_REQUEST','SHIPPING_CANCEL','SHIPPING_TRACKING']),
    keeta: new Set(['CONFIRM','READY','DISPATCH_MERCHANT','CANCEL_ORDER'])
  });

  async function listOrders(companyId, limit = 50) {
    if (!UUID.test(companyId || '') || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('Invalid order query.'),{code:'INVALID_INPUT'});
    return tenantTransaction(companyId, async client => {
      const result=await client.query(`SELECT v.domain_order_id::text AS "domainOrderId",v.provider,v.external_order_id AS "externalOrderId",
        d.payload->>'externalDisplayId' AS "displayId",d.payload->>'status' AS "providerStatus",d.payload->>'orderType' AS "orderType",
        a.display_name AS "merchantName",a.account_status AS "accountStatus",
        latest.operation AS "lastOperation",latest.status AS "commandStatus",latest.last_error_code AS "lastErrorCode",latest.updated_at AS "commandUpdatedAt",
        quote.result_data->>'externalQuoteReference' AS "quoteId",
        EXISTS(SELECT 1 FROM rotamoto.marketplace_command_outbox s WHERE s.company_id=v.company_id AND s.external_account_id=v.external_account_id
          AND s.external_order_id=v.external_order_id AND s.operation='SHIPPING_REQUEST' AND s.status IN ('pending','succeeded','unknown_outcome')) AS "shippingRequested"
        FROM rotamoto.marketplace_order_versions v
        JOIN rotamoto.domain_records d ON d.company_id=v.company_id AND d.record_id=v.domain_order_id AND d.entity_type='Order'
        JOIN rotamoto.external_accounts a ON a.company_id=v.company_id AND a.id=v.external_account_id
        LEFT JOIN LATERAL (SELECT operation,status,last_error_code,updated_at FROM rotamoto.marketplace_command_outbox c
          WHERE c.company_id=v.company_id AND c.external_account_id=v.external_account_id AND c.external_order_id=v.external_order_id
          ORDER BY c.created_at DESC LIMIT 1) latest ON true
        LEFT JOIN LATERAL (SELECT result_data FROM rotamoto.marketplace_command_outbox q
          WHERE q.company_id=v.company_id AND q.external_account_id=v.external_account_id AND q.external_order_id=v.external_order_id
            AND q.operation='SHIPPING_QUOTE' AND q.status='succeeded' ORDER BY q.created_at DESC LIMIT 1) quote ON true
        WHERE v.company_id=$1 AND v.provider IN ('ifood','keeta') ORDER BY v.updated_at DESC LIMIT $2`,[companyId,limit]);
      return result.rows;
    });
  }

  async function enqueueOrderCommand({companyId,domainOrderId,operation,idempotencyKey,commandData={}}) {
    if(!UUID.test(companyId||'')||!UUID.test(domainOrderId||'')||typeof operation!=='string'||
      typeof idempotencyKey!=='string'||idempotencyKey.length<16||idempotencyKey.length>160||
      !commandData||typeof commandData!=='object'||Array.isArray(commandData))throw Object.assign(new Error('Invalid marketplace order command.'),{code:'INVALID_INPUT'});
    return tenantTransaction(companyId,async client=>{
      const result=await client.query(`SELECT v.external_account_id::text AS account_id,v.provider,v.external_order_id,d.payload,
        a.account_status,a.link_status,i.status AS integration_status
        FROM rotamoto.marketplace_order_versions v
        JOIN rotamoto.domain_records d ON d.company_id=v.company_id AND d.record_id=v.domain_order_id AND d.entity_type='Order'
        JOIN rotamoto.external_accounts a ON a.company_id=v.company_id AND a.id=v.external_account_id
        JOIN rotamoto.integrations i ON i.company_id=a.company_id AND i.id=a.integration_id
        WHERE v.company_id=$1 AND v.domain_order_id=$2 FOR UPDATE OF v`,[companyId,domainOrderId]);
      if(result.rowCount!==1)throw Object.assign(new Error('Marketplace order not found.'),{code:'NOT_FOUND'});
      const order=result.rows[0];
      if(order.account_status!=='active'||order.link_status!=='confirmed'||order.integration_status!=='active'||order.payload?.source!==order.provider)
        throw Object.assign(new Error('Marketplace order account unavailable.'),{code:'ACCOUNT_UNAVAILABLE',status:409});
      if(!ORDER_COMMANDS[order.provider]?.has(operation))throw Object.assign(new Error('Unsupported marketplace operation.'),{code:'UNSUPPORTED_OPERATION'});
      const allowedByOperation={
        CANCEL_ORDER:order.provider==='keeta'?new Set(['reason','code']):new Set(['reason']),
        SHIPPING_REQUEST:new Set(['quoteId']),
        CONFIRM:order.provider==='keeta'?new Set(['orderExternalCode','preparationTime']):new Set(),
        DISPATCH_MERCHANT:order.provider==='keeta'?new Set(['deliveryTrackingInfo']):new Set(),
        START_PREPARATION:new Set(),READY:new Set(),SHIPPING_QUOTE:new Set(),SHIPPING_CANCEL:new Set(),SHIPPING_TRACKING:new Set()
      };
      const allowed=allowedByOperation[operation]||new Set();
      if(Object.keys(commandData).some(key=>!allowed.has(key)))throw Object.assign(new Error('Unsafe command data.'),{code:'INVALID_INPUT'});
      if(operation==='CANCEL_ORDER'&&(typeof commandData.reason!=='string'||!commandData.reason.trim()||commandData.reason.length>64||/[\u0000-\u001f\u007f]/u.test(commandData.reason)))throw Object.assign(new Error('Cancellation reason required.'),{code:'INVALID_INPUT'});
      if(order.provider==='keeta'&&operation==='CANCEL_ORDER'&&!['SYSTEMIC_ISSUES','DUPLICATE_APPLICATION','UNAVAILABLE_ITEM','RESTAURANT_WITHOUT_DELIVERY_PERSON','OUTDATED_MENU','ORDER_OUTSIDE_THE_DELIVERY_AREA','BLOCKED_CUSTOMER','OUTSIDE_DELIVERY_HOURS','INTERNAL_DIFFICULTIES_OF_THE_RESTAURANT','RISK_AREA','DELIVERY_PROBLEM'].includes(commandData.code))throw Object.assign(new Error('Invalid Keeta cancellation code.'),{code:'INVALID_INPUT'});
      const persistedData={...commandData};
      if(order.provider==='keeta'&&operation==='CONFIRM'){
        if(typeof persistedData.orderExternalCode!=='string'||!persistedData.orderExternalCode||typeof order.payload.createdAt!=='string')throw Object.assign(new Error('Keeta confirmation fields are unavailable.'),{code:'ORDER_DATA_UNAVAILABLE',status:409});
        if(persistedData.orderExternalCode.length>128||/[\u0000-\u001f\u007f]/u.test(persistedData.orderExternalCode)||persistedData.preparationTime!==undefined&&!Number.isInteger(persistedData.preparationTime))throw Object.assign(new Error('Invalid Keeta confirmation data.'),{code:'INVALID_INPUT'});
        persistedData.createdAt=order.payload.createdAt;
      }
      if(order.provider==='keeta'&&operation==='DISPATCH_MERCHANT'){
        const tracking=persistedData.deliveryTrackingInfo;let url;
        try{url=new URL(tracking?.externalTrackingURL);}catch(_){url=null;}
        if(!tracking||Object.keys(tracking).length!==1||typeof tracking.externalTrackingURL!=='string'||tracking.externalTrackingURL.length>2048||!url||url.protocol!=='https:'||url.username||url.password)
          throw Object.assign(new Error('A safe HTTPS tracking URL is required for Keeta self-delivery.'),{code:'INVALID_INPUT'});
      }
      if(operation==='SHIPPING_REQUEST'){
        if(!UUID.test(commandData.quoteId||''))throw Object.assign(new Error('A valid iFood quote ID is required.'),{code:'INVALID_INPUT'});
        const quote=await client.query(`SELECT 1 FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND external_account_id=$2
          AND provider='ifood' AND external_order_id=$3 AND operation='SHIPPING_QUOTE' AND status='succeeded'
          AND result_data->>'externalQuoteReference'=$4 AND (result_data->>'expiresAt')::timestamptz>now() LIMIT 1`,
        [companyId,order.account_id,order.external_order_id,commandData.quoteId]);
        if(!quote.rowCount)throw Object.assign(new Error('A current quote for this order is required.'),{code:'QUOTE_UNAVAILABLE',status:409});
      }
      if(['SHIPPING_CANCEL','SHIPPING_TRACKING'].includes(operation)){
        const delivery=await client.query(`SELECT 1 FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND external_account_id=$2
          AND provider='ifood' AND external_order_id=$3 AND operation='SHIPPING_REQUEST' AND status IN ('pending','succeeded','unknown_outcome') LIMIT 1`,
        [companyId,order.account_id,order.external_order_id]);
        if(!delivery.rowCount)throw Object.assign(new Error('No iFood delivery request is recorded for this order.'),{code:'SHIPPING_REQUEST_NOT_FOUND',status:409});
      }
      const retryClass=['SHIPPING_QUOTE','SHIPPING_TRACKING'].includes(operation)?'safe_retry':'reconcile_before_retry';
      const inserted=await client.query(`INSERT INTO rotamoto.marketplace_command_outbox
        (company_id,command_id,external_account_id,provider,external_order_id,operation,idempotency_key,command_data,retry_class)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(provider,external_account_id,operation,idempotency_key) DO NOTHING
        RETURNING command_id::text,status,operation,created_at`,[companyId,crypto.randomUUID(),order.account_id,order.provider,order.external_order_id,
        operation,idempotencyKey,JSON.stringify(persistedData),retryClass]);
      if(inserted.rowCount)return {...inserted.rows[0],duplicate:false};
      const existing=await client.query(`SELECT command_id::text,status,operation,external_order_id,command_data=$6::jsonb AS same_data,created_at FROM rotamoto.marketplace_command_outbox
        WHERE company_id=$1 AND external_account_id=$2 AND provider=$3 AND operation=$4 AND idempotency_key=$5`,
      [companyId,order.account_id,order.provider,operation,idempotencyKey,JSON.stringify(persistedData)]);
      if(!existing.rowCount)throw Object.assign(new Error('Marketplace idempotency conflict.'),{code:'IDEMPOTENCY_CONFLICT',status:409});
      if(existing.rows[0].external_order_id!==order.external_order_id||!existing.rows[0].same_data)
        throw Object.assign(new Error('Idempotency key was already used for a different command.'),{code:'IDEMPOTENCY_CONFLICT',status:409});
      return {...existing.rows[0],duplicate:true};
    });
  }

  return Object.freeze({ ingest, ingestPolled, pollAccount, processPending, processClaimed, enqueueCommand, enqueueOrderCommand, listOrders });
}

function canonicalOrder(provider, order) {
  const items = Array.isArray(order.items) ? order.items.map(item => ({ name: String(item.name).slice(0,240), quantity: item.quantity })) : [];
  const result = { source: provider, externalId: order.externalId, externalDisplayId: order.externalDisplayId || null,
    status: order.status || null, orderType: order.orderType || null, items,
    // Marketplace totals and delivery prices are intentionally not converted or fabricated.
    amount: null, currency: null, logistics: null, createdAt: order.createdAt || null };
  return result;
}

module.exports = { MAX_WEBHOOK_BYTES, digest, createMarketplaceRuntime, canonicalOrder, safeCode };
