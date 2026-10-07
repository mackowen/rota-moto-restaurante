'use strict';

const crypto=require('node:crypto');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function createMarketplaceAccountWriter({privilegedPool,secretProvider}={}){
  if(!privilegedPool||!secretProvider||typeof secretProvider.put!=='function')throw new TypeError('Privileged marketplace writer and secret provider required.');
  async function scoped(companyId,operation){
    const client=await privilegedPool.connect();
    try{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
      const role=await client.query('SELECT current_user AS role');if(role.rows[0]?.role!=='rotamoto_provider_resolver')throw Object.assign(new Error('Secret writer role is not isolated.'),{code:'SECRET_WRITER_ROLE_INVALID'});
      const value=await operation(client);await client.query('COMMIT');return value;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  async function provision({companyId,provider,merchantId,displayName,credentials,externalAccountId=null,serviceMerchantId=null,active=true}){
    if(!UUID.test(companyId||'')||!['ifood','keeta'].includes(provider)||typeof merchantId!=='string'||!merchantId||merchantId.length>255)throw new TypeError('Invalid marketplace account binding.');
    const integration=await scoped(companyId,async client=>{
      const result=await client.query('SELECT id::text FROM rotamoto.integrations WHERE company_id=$1 AND provider=$2',[companyId,provider]);
      return result.rows[0]?.id||null;
    });
    if(!integration)throw Object.assign(new Error('Marketplace integration row is missing.'),{code:'INTEGRATION_NOT_FOUND'});
    const row=await scoped(companyId,async client=>{
      const result=await client.query(`SELECT ea.id::text,ea.secret_ref,b.service_merchant_id FROM rotamoto.external_accounts ea
        LEFT JOIN rotamoto.marketplace_account_bindings b ON b.company_id=ea.company_id AND b.external_account_id=ea.id
          AND b.provider=$4 AND b.merchant_id=$3
        WHERE ea.company_id=$1 AND ea.integration_id=$2 AND ea.external_account_id=$3 FOR UPDATE OF ea`,[companyId,integration,merchantId,provider]);
      return result.rows[0]||null;
    });
    const id=externalAccountId||row?.id||crypto.randomUUID();
    const actualServiceMerchantId=serviceMerchantId||row?.service_merchant_id||(provider==='keeta'?crypto.randomUUID():null);
    const name=`marketplace/${provider}/${id}`;
    const storedCredentials={...credentials,accountScope:id,companyId};
    const encoded=JSON.stringify(storedCredentials);
    const stored=await secretProvider.put({name,scope:'tenant',tenantId:companyId,value:encoded});
    let actualId;
    try{
      actualId=await scoped(companyId,async client=>{
        await client.query(`INSERT INTO rotamoto.external_accounts(id,company_id,integration_id,external_account_id,display_name,link_status,confirmed_at,secret_ref,account_status,token_expires_at)
          VALUES($1,$2,$3,$4,$5,'confirmed',now(),$6,$8,CASE WHEN $7::bigint IS NULL THEN NULL ELSE to_timestamp($7/1000.0) END)
          ON CONFLICT(integration_id,external_account_id) DO UPDATE SET display_name=EXCLUDED.display_name,link_status='confirmed',confirmed_at=now(),
            secret_ref=EXCLUDED.secret_ref,account_status=EXCLUDED.account_status,token_expires_at=EXCLUDED.token_expires_at,last_error_code=NULL,updated_at=now()`,
        [id,companyId,integration,merchantId,typeof displayName==='string'?displayName.slice(0,160):null,stored.secretRef,Number.isFinite(credentials.tokenExpiresAt)?credentials.tokenExpiresAt:null,active?'active':'pending']);
        const actual=await client.query('SELECT id::text FROM rotamoto.external_accounts WHERE company_id=$1 AND integration_id=$2 AND external_account_id=$3',[companyId,integration,merchantId]);
        await client.query(`INSERT INTO rotamoto.marketplace_account_bindings(company_id,integration_id,external_account_id,provider,merchant_id,service_merchant_id,display_name,authorized)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(company_id,external_account_id,merchant_id) DO UPDATE SET
            service_merchant_id=EXCLUDED.service_merchant_id,display_name=EXCLUDED.display_name,authorized=EXCLUDED.authorized,updated_at=now()`,
        [companyId,integration,actual.rows[0].id,provider,merchantId,actualServiceMerchantId,typeof displayName==='string'?displayName.slice(0,160):null,active]);
        return actual.rows[0].id;
      });
    }catch(error){if(typeof secretProvider.remove==='function')await secretProvider.remove(stored.secretRef).catch(()=>{});throw error;}
    if(row?.secret_ref&&row.secret_ref!==stored.secretRef&&typeof secretProvider.remove==='function')await secretProvider.remove(row.secret_ref).catch(()=>{});
    return Object.freeze({id:actualId,provider,merchantId,serviceMerchantId:actualServiceMerchantId});
  }
  async function activate({companyId,accountId,provider,merchantId}){
    await scoped(companyId,async client=>{
      const result=await client.query(`UPDATE rotamoto.external_accounts ea SET account_status='active',last_error_code=NULL,updated_at=now()
        FROM rotamoto.integrations i WHERE ea.company_id=$1 AND ea.id=$2 AND ea.integration_id=i.id AND i.company_id=ea.company_id AND i.provider=$3
          AND ea.link_status='confirmed'`,[companyId,accountId,provider]);
      if(!result.rowCount)throw Object.assign(new Error('Marketplace account unavailable.'),{code:'ACCOUNT_UNAVAILABLE'});
      const binding=await client.query(`UPDATE rotamoto.marketplace_account_bindings SET authorized=true,updated_at=now()
        WHERE company_id=$1 AND external_account_id=$2 AND provider=$3 AND merchant_id=$4`,[companyId,accountId,provider,merchantId]);
      if(!binding.rowCount)throw Object.assign(new Error('Marketplace merchant binding unavailable.'),{code:'ACCOUNT_UNAVAILABLE'});
    });
  }
  async function setError({companyId,accountId,errorCode}){
    if(!/^[A-Z][A-Z0-9_]{1,63}$/u.test(errorCode||''))throw new TypeError('Invalid marketplace error code.');
    await scoped(companyId,async client=>client.query(`UPDATE rotamoto.external_accounts SET last_error_code=$3,updated_at=now()
      WHERE company_id=$1 AND id=$2 AND account_status='pending'`,[companyId,accountId,errorCode]));
  }
  async function revokeKeetaAuthorization({merchantId,eventKey,bodyDigest}){
    if(typeof merchantId!=='string'||!/^\d{1,18}$/u.test(merchantId)||typeof eventKey!=='string'||!/^[a-f0-9]{64}$/u.test(eventKey)||!Buffer.isBuffer(bodyDigest)||bodyDigest.length!==32)
      throw new TypeError('Invalid Keeta authorization revocation.');
    const routeClient=await privilegedPool.connect();let companyId=null;
    try{const route=await routeClient.query(`SELECT company_id::text FROM rotamoto.marketplace_account_routes WHERE provider='keeta' AND route_kind='merchant' AND route_key=$1`,[merchantId]);
      if(route.rowCount===1)companyId=route.rows[0].company_id;
    }finally{routeClient.release();}
    if(!companyId)return Object.freeze({matched:false,duplicate:false});
    return scoped(companyId,async client=>{
      const role=await client.query('SELECT current_user AS role');if(role.rows[0]?.role!=='rotamoto_provider_resolver')throw Object.assign(new Error('Resolver role is not isolated.'),{code:'CREDENTIAL_ROLE_INVALID'});
      const account=await client.query(`SELECT ea.id::text FROM rotamoto.external_accounts ea JOIN rotamoto.marketplace_account_bindings b
        ON b.company_id=ea.company_id AND b.external_account_id=ea.id JOIN rotamoto.integrations i
        ON i.company_id=ea.company_id AND i.id=ea.integration_id
        WHERE ea.company_id=$1 AND b.provider='keeta' AND b.merchant_id=$2 AND i.provider='keeta'`,[companyId,merchantId]);
      if(account.rowCount!==1)return Object.freeze({matched:false,duplicate:false});
      const inserted=await client.query(`INSERT INTO rotamoto.marketplace_authorization_events(company_id,provider,external_account_id,event_key,body_digest)
        VALUES($1,'keeta',$2,$3,$4) ON CONFLICT(company_id,provider,event_key) DO NOTHING RETURNING event_key`,[companyId,account.rows[0].id,eventKey,bodyDigest]);
      if(!inserted.rowCount){
        const existing=await client.query(`SELECT body_digest FROM rotamoto.marketplace_authorization_events
          WHERE company_id=$1 AND provider='keeta' AND event_key=$2`,[companyId,eventKey]);
        if(!existing.rowCount||!crypto.timingSafeEqual(existing.rows[0].body_digest,bodyDigest))
          throw Object.assign(new Error('Keeta authorization event identity was reused with different content.'),{code:'AUTHORIZATION_EVENT_CONFLICT',status:409});
        return Object.freeze({matched:true,duplicate:true});
      }
      await client.query(`UPDATE rotamoto.external_accounts SET account_status='revoked',last_error_code=NULL,updated_at=now() WHERE company_id=$1 AND id=$2`,[companyId,account.rows[0].id]);
      await client.query(`UPDATE rotamoto.marketplace_account_bindings SET authorized=false,updated_at=now() WHERE company_id=$1 AND external_account_id=$2 AND provider='keeta' AND merchant_id=$3`,[companyId,account.rows[0].id,merchantId]);
      await client.query(`UPDATE rotamoto.marketplace_command_outbox SET status='needs_review',lease_token=NULL,lease_until=NULL,completed_at=now(),last_error_code='ACCOUNT_REVOKED',updated_at=now()
        WHERE company_id=$1 AND external_account_id=$2 AND status IN ('queued','leased','pending','unknown_outcome')`,[companyId,account.rows[0].id]);
      return Object.freeze({matched:true,duplicate:false});
    });
  }
  async function disableAccount({companyId,provider,accountId}){
    if(!UUID.test(companyId||'')||!UUID.test(accountId||'')||!['ifood','keeta'].includes(provider))throw new TypeError('Invalid marketplace account disable request.');
    return scoped(companyId,async client=>{
      const result=await client.query(`UPDATE rotamoto.external_accounts ea SET account_status='disabled',last_error_code=NULL,updated_at=now()
        FROM rotamoto.integrations i WHERE ea.company_id=$1 AND ea.id=$2 AND ea.integration_id=i.id AND i.company_id=ea.company_id AND i.provider=$3
        RETURNING ea.id::text,ea.last_sync_at`,[companyId,accountId,provider]);
      if(!result.rowCount)throw Object.assign(new Error('Marketplace account not found.'),{code:'NOT_FOUND'});
      await client.query(`UPDATE rotamoto.marketplace_account_bindings SET authorized=false,updated_at=now() WHERE company_id=$1 AND external_account_id=$2 AND provider=$3`,[companyId,accountId,provider]);
      await client.query(`UPDATE rotamoto.marketplace_command_outbox SET status='needs_review',lease_token=NULL,lease_until=NULL,
        completed_at=now(),last_error_code='ACCOUNT_DISABLED',updated_at=now() WHERE company_id=$1 AND external_account_id=$2
          AND status IN ('queued','leased','pending','unknown_outcome')`,[companyId,accountId]);
      return {account:{id:result.rows[0].id,status:'disabled',lastSyncAt:result.rows[0].last_sync_at}};
    });
  }
  async function persistTokens({companyId,accountScope,refreshToken,expiresAt}){
    if(!UUID.test(companyId||'')||!UUID.test(accountScope||'')||typeof refreshToken!=='string'||!refreshToken)throw new TypeError('Invalid marketplace token update.');
    for(let attempt=0;attempt<4;attempt++){
    const row=await scoped(companyId,async client=>{
      const result=await client.query(`SELECT secret_ref FROM rotamoto.external_accounts WHERE company_id=$1 AND id=$2
        AND account_status='active' AND link_status='confirmed' FOR UPDATE`,[companyId,accountScope]);
      return result.rows[0]||null;
    });
    if(!row?.secret_ref)throw Object.assign(new Error('Account credentials are unavailable.'),{code:'ACCOUNT_UNAVAILABLE'});
    const name=`marketplace/${await scoped(companyId,async client=>{const result=await client.query(`SELECT i.provider FROM rotamoto.external_accounts ea JOIN rotamoto.integrations i ON i.id=ea.integration_id AND i.company_id=ea.company_id WHERE ea.company_id=$1 AND ea.id=$2`,[companyId,accountScope]);return result.rows[0]?.provider||'ifood';})}/${accountScope}`;
    const current=JSON.parse(await secretProvider.get(row.secret_ref,{name,scope:'tenant',tenantId:companyId}));
    const updated={...current,refreshToken,tokenExpiresAt:expiresAt};
    const next=await secretProvider.put({name,scope:'tenant',tenantId:companyId,value:JSON.stringify(updated)});
    const writeResult=await scoped(companyId,async client=>(await client.query(`UPDATE rotamoto.external_accounts SET secret_ref=$3,token_expires_at=to_timestamp($4/1000.0),updated_at=now()
      WHERE company_id=$1 AND id=$2 AND secret_ref=$5 AND account_status='active' AND link_status='confirmed'`,[companyId,accountScope,next.secretRef,expiresAt,row.secret_ref])).rowCount===1);
    if(writeResult){if(next.secretRef!==row.secret_ref&&typeof secretProvider.remove==='function')await secretProvider.remove(row.secret_ref).catch(()=>{});return;}
    if(typeof secretProvider.remove==='function')await secretProvider.remove(next.secretRef).catch(()=>{});
    }
    throw Object.assign(new Error('Marketplace token changed too frequently.'),{code:'TOKEN_PERSISTENCE_CONFLICT'});
  }
  return Object.freeze({provision,activate,setError,revokeKeetaAuthorization,disableAccount,scoped,persistTokens});
}

module.exports={createMarketplaceAccountWriter};
