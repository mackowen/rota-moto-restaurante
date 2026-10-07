'use strict';

const crypto = require('node:crypto');
const { retryDelayMs, sanitizeProviderError } = require('./registry');
const { createMarketplaceRuntime } = require('./marketplace-runtime');

const SIDE_EFFECTS = new Set(['CONFIRM','START_PREPARATION','READY','DISPATCH_MERCHANT','CANCEL_ORDER','SHIPPING_REQUEST','SHIPPING_CANCEL']);
function sanitizedError(error) { return sanitizeProviderError(error); }

function createMarketplaceWorker({ pool, companyIds, adapters, accountResolver, logger = () => {}, clock = () => Date.now(), random = Math.random,
  leaseSeconds = 45, pollIntervalMs = 1000 } = {}) {
  if (!pool || !Array.isArray(companyIds) || !companyIds.length || !adapters || typeof accountResolver !== 'function')
    throw new TypeError('Marketplace worker configuration is incomplete.');
  let stopped = false;
  const runtime=createMarketplaceRuntime({pool,adapters,accountResolver:{
    byId:(provider,accountId,companyId)=>accountResolver(provider,accountId,companyId),
    byMerchant:(provider,merchantId)=>accountResolver.byMerchant(provider,merchantId)
  },logger});

  async function claim(companyId) {
    const lease = crypto.randomUUID();
    const result = await pool.query('SELECT * FROM rotamoto.claim_marketplace_command($1,$2,$3)', [companyId,lease,leaseSeconds]);
    return result.rows[0] ? { ...result.rows[0], lease_token: lease } : null;
  }

  async function reconcileUnknown(companyId) {
    let command;
    const client=await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
      const result=await client.query(`SELECT command_id,external_account_id,provider,external_order_id,operation
        FROM rotamoto.marketplace_command_outbox WHERE company_id=$1 AND status='unknown_outcome'
          AND updated_at < now()-interval '60 seconds' ORDER BY updated_at LIMIT 1`,[companyId]);
      command=result.rows[0]||null; await client.query('COMMIT');
    } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
    if(!command)return false;
    let confirmed=false;
    try {
      const account=await accountResolver(command.provider,command.external_account_id,companyId);
      if(account?.status==='active'&&account.companyId===companyId&&account.provider===command.provider) {
        const order=command.provider==='ifood'
          ? await adapters.ifood.order({companyId,orderId:command.external_order_id,credentials:account.credentials})
          : await adapters.keeta.order({companyId,id:command.external_order_id});
        const state=String(order.status||'').toUpperCase();
        const expected={CONFIRM:['CONFIRMED'],START_PREPARATION:['PREPARATION_STARTED'],READY:['READY_TO_PICKUP','READY_FOR_PICKUP'],
          DISPATCH_MERCHANT:['DISPATCHED'],CANCEL_ORDER:['CANCELLED']}[command.operation]||[];
        confirmed=expected.includes(state);
      }
    } catch(error) {
      try { logger({event:'marketplace.reconciliation_failed',provider:command.provider,errorCode:sanitizedError(error).code}); } catch(_) {}
    }
    const settleClient=await pool.connect();
    try {
      await settleClient.query('BEGIN'); await settleClient.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
      await settleClient.query(`UPDATE rotamoto.marketplace_command_outbox SET status=CASE WHEN $3 THEN 'succeeded' ELSE 'unknown_outcome' END,
        completed_at=CASE WHEN $3 THEN now() ELSE completed_at END,
        last_error_code=CASE WHEN $3 THEN NULL ELSE 'RECONCILIATION_UNCONFIRMED' END,updated_at=now()
        WHERE company_id=$1 AND command_id=$2 AND status='unknown_outcome'`,[companyId,command.command_id,confirmed]);
      await settleClient.query('COMMIT');
    } catch(error) { await settleClient.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { settleClient.release(); }
    return true;
  }

  async function execute(command, account) {
    const adapter = adapters[command.provider];
    const common = command.provider === 'ifood'
      ? { companyId: command.company_id, orderId: command.external_order_id, credentials: account.credentials }
      : { companyId: command.company_id, id: command.external_order_id };
    switch (command.operation) {
      case 'CONFIRM': return command.provider === 'ifood' ? adapter.confirmOrder(common) : adapter.confirm({ ...common, ...command.command_data });
      case 'START_PREPARATION': if (command.provider !== 'ifood') throw Object.assign(new Error('Unsupported command.'),{code:'UNSUPPORTED_OPERATION'}); return adapter.startPreparation(common);
      case 'READY': return command.provider === 'ifood' ? adapter.readyToPickup(common) : adapter.readyForPickup(common);
      case 'DISPATCH_MERCHANT': return command.provider === 'ifood' ? adapter.dispatchMerchantDelivery(common) : adapter.dispatchSelfDelivery({ ...common, deliveryTrackingInfo: command.command_data.deliveryTrackingInfo });
      case 'CANCEL_ORDER': return command.provider === 'ifood' ? adapter.requestOrderCancellation({ ...common, reason: command.command_data.reason }) : adapter.requestCancellation({ ...common, ...command.command_data });
      case 'SHIPPING_QUOTE': if (command.provider !== 'ifood') throw Object.assign(new Error('Unsupported command.'),{code:'UNSUPPORTED_OPERATION'}); return adapter.quote(common);
      case 'SHIPPING_REQUEST': if (command.provider !== 'ifood') throw Object.assign(new Error('Unsupported command.'),{code:'UNSUPPORTED_OPERATION'}); return adapter.dispatch({ ...common, quoteId: command.command_data.quoteId });
      case 'SHIPPING_CANCEL': if (command.provider !== 'ifood') throw Object.assign(new Error('Unsupported command.'),{code:'UNSUPPORTED_OPERATION'}); return adapter.cancel(common);
      case 'SHIPPING_TRACKING': if (command.provider !== 'ifood') throw Object.assign(new Error('Unsupported command.'),{code:'UNSUPPORTED_OPERATION'}); return adapter.tracking(common);
      default: throw Object.assign(new Error('Unsupported marketplace operation.'),{code:'UNSUPPORTED_OPERATION'});
    }
  }

  async function settle(command, outcome) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id',$1,true)",[command.company_id]);
      if (outcome.ok) {
        const pending = outcome.value?.confirmation === 'pending' || outcome.value?.status === 'pending';
        await client.query(`UPDATE rotamoto.marketplace_command_outbox SET status=$4,lease_token=NULL,lease_until=NULL,
          completed_at=CASE WHEN $4='succeeded' THEN now() ELSE NULL END,last_error_code=NULL,updated_at=now()
          WHERE company_id=$1 AND command_id=$2 AND lease_token=$3`,
        [command.company_id,command.command_id,command.lease_token,pending?'pending':'succeeded']);
      } else {
        const failure = sanitizedError(outcome.error);
        const unknown = outcome.error?.code === 'PROVIDER_TIMEOUT' || outcome.error?.classification === 'unknown' ||
          (SIDE_EFFECTS.has(command.operation) && Number(outcome.error?.status)>=500);
        const retrySafe = ['safe_retry','idempotent'].includes(command.retry_class);
        const explicitRateLimit=Number(outcome.error?.status)===429;
        const delay = !unknown && (retrySafe||explicitRateLimit) ? retryDelayMs({status:outcome.error?.status,retryAfterSeconds:outcome.error?.retryAfterSeconds,
          code:outcome.error?.code,attempts:command.attempts,classification:failure.class==='transient'?'TRANSIENT':failure.class==='rate_limit'?'RATE_LIMIT':'PERMANENT'},command.attempts,random) : null;
        const status = unknown ? 'unknown_outcome' : delay !== null ? 'queued' : failure.class === 'reauth_required' ? 'needs_review' : 'rejected';
        await client.query(`UPDATE rotamoto.marketplace_command_outbox SET status=$4,lease_token=NULL,lease_until=NULL,
          next_attempt_at=CASE WHEN $4='queued' THEN now()+($5::int*interval '1 millisecond') ELSE next_attempt_at END,
          completed_at=CASE WHEN $4 IN ('unknown_outcome','rejected','needs_review') THEN now() ELSE NULL END,
          last_error_code=$6,updated_at=now() WHERE company_id=$1 AND command_id=$2 AND lease_token=$3`,
        [command.company_id,command.command_id,command.lease_token,status,delay||0,failure.code]);
        if(failure.class==='reauth_required')await client.query(`UPDATE rotamoto.external_accounts SET account_status='reauthorization_required',last_error_code=$3,updated_at=now()
          WHERE company_id=$1 AND id=$2`,[command.company_id,command.external_account_id,failure.code]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }

  async function runOnce() {
    for (const companyId of companyIds) {
      const eventLease=crypto.randomUUID();
      const claimedEvent=await pool.query('SELECT * FROM rotamoto.claim_marketplace_event($1,$2,$3)',[companyId,eventLease,90]);
      const event=claimedEvent.rows[0];
      if(event){
        try {
          const account=await accountResolver(event.provider,event.external_account_id,companyId);
          if(!account||account.status!=='active'||account.companyId!==companyId||account.provider!==event.provider)
            throw Object.assign(new Error('Marketplace inbox account unavailable.'),{code:'ACCOUNT_UNAVAILABLE'});
          await runtime.processClaimed(account,event.external_event_id,eventLease);
        } catch(error) {
          try { logger({event:'marketplace.inbox_worker_failed',provider:event.provider,errorCode:sanitizedError(error).code}); } catch(_) {}
        }
        return true;
      }
      for(const provider of ['ifood','keeta']) {
        const pollLease=crypto.randomUUID();
        const claimed=await pool.query('SELECT * FROM rotamoto.claim_marketplace_poll_account($1,$2,$3,$4)',[companyId,provider,pollLease,90]);
        const poll=claimed.rows[0];
        if(poll) {
          let nextDelay=30;
          let pollErrorCode=null,reauthorize=false;
          try {
            const account=await accountResolver(provider,poll.account_id,companyId);
            if(!account||account.status!=='active'||account.companyId!==companyId||account.provider!==provider)
              throw Object.assign(new Error('Marketplace account unavailable.'),{code:'ACCOUNT_UNAVAILABLE',status:403});
            const adapter=adapters[provider];
            const events=provider==='ifood'
              ? await adapter.pollEvents({companyId,credentials:account.credentials})
              : await adapter.pollEvents({companyId,serviceMerchantIds:[account.serviceMerchantId]});
            await runtime.ingestPolled(account,events);
          } catch(error) {
            const failure=sanitizedError(error);
            pollErrorCode=failure.code;reauthorize=failure.class==='reauth_required';
            nextDelay=error?.retryAfterSeconds?Math.min(3600,Math.max(1,error.retryAfterSeconds)):Math.min(300,30*Math.pow(2,Math.min(poll.attempts||0,4)));
            try{logger({event:'marketplace.poll_failed',provider,errorCode:failure.code});}catch(_){}
          } finally {
            const client=await pool.connect();
            try {
              await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
              await client.query(`UPDATE rotamoto.external_accounts SET poll_next_at=now()+($4::int*interval '1 second'),
                poll_lease_token=NULL,poll_lease_until=NULL,last_sync_at=CASE WHEN $5::text IS NULL THEN now() ELSE last_sync_at END,
                last_error_code=$5,account_status=CASE WHEN $6 THEN 'reauthorization_required' ELSE account_status END,updated_at=now()
                WHERE company_id=$1 AND id=$2 AND poll_lease_token=$3`,
              [companyId,poll.account_id,pollLease,nextDelay,pollErrorCode,reauthorize]);
              await client.query('COMMIT');
            } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;} finally{client.release();}
          }
          return true;
        }
      }
      if(await reconcileUnknown(companyId))return true;
      const command = await claim(companyId);
      if (!command) continue;
      try {
        const account = await accountResolver(command.provider, command.external_account_id, command.company_id);
        if (!account || account.status !== 'active' || account.companyId !== command.company_id || account.provider !== command.provider)
          throw Object.assign(new Error('Marketplace account unavailable.'),{code:'ACCOUNT_UNAVAILABLE',status:403});
        const value = await execute(command, account); // provider HTTP is outside PostgreSQL transactions.
        await settle(command,{ok:true,value});
      } catch (error) {
        await settle(command,{ok:false,error}).catch(() => {});
        try { logger({event:'marketplace.command_failed',provider:command.provider,operation:command.operation,errorCode:sanitizedError(error).code}); } catch (_) {}
      }
      return true;
    }
    return false;
  }

  async function start({ signal } = {}) {
    while (!stopped && !signal?.aborted) {
      let worked = false;
      try { worked = await runOnce(); }
      catch (error) { try { logger({event:'marketplace.worker_error',errorCode:sanitizedError(error).code}); } catch (_) {} }
      if (worked) continue;
      const jitter = 0.5 + random();
      await new Promise(resolve => {
        const timer=setTimeout(resolve,Math.round(pollIntervalMs*jitter));
        signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});
      });
    }
  }
  return Object.freeze({ runOnce, reconcileUnknown, start, stop(){stopped=true;} });
}

module.exports = { createMarketplaceWorker, SIDE_EFFECTS, sanitizedError };
