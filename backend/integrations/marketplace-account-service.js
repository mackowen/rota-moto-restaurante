'use strict';

const crypto=require('node:crypto');
const {digest}=require('./marketplace-runtime');

function failure(code,status=400){return Object.assign(new Error('Marketplace account request failed.'),{code,status});}
function validPublicUrl(value){try{const url=new URL(value);const callbackQuery=[...url.searchParams.entries()];return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&
  (callbackQuery.length===0||callbackQuery.length===1&&callbackQuery[0][0]==='marketplace'&&callbackQuery[0][1]==='keeta')?url.toString():null;}catch(_){return null;}}

function createMarketplaceAccountService({pool,accountWriter,secretProvider,adapters,applicationCredentials,publicCallbackUrl,keetaWebhookBaseUrl,clock=()=>new Date()}={}){
  if(!pool||!accountWriter||!secretProvider||!adapters||typeof applicationCredentials!=='function'||!validPublicUrl(publicCallbackUrl))
    throw new TypeError('Marketplace account lifecycle configuration is incomplete.');
  if(!validPublicUrl(keetaWebhookBaseUrl))throw new TypeError('Keeta webhook base URL must be public HTTPS.');
  async function tenantTx(companyId,operation){
    const client=await pool.connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);const result=await operation(client);await client.query('COMMIT');return result;}
    catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  async function ensureIntegration(companyId,provider){return tenantTx(companyId,async client=>{
    await client.query(`INSERT INTO rotamoto.integrations(id,company_id,provider,status) VALUES($1,$2,$3,'pending') ON CONFLICT(company_id,provider) DO NOTHING`,[crypto.randomUUID(),companyId,provider]);
    const result=await client.query('SELECT id::text FROM rotamoto.integrations WHERE company_id=$1 AND provider=$2',[companyId,provider]);
    if(!result.rowCount)throw failure('INTEGRATION_NOT_FOUND',500);return result.rows[0].id;
  });}
  async function storeState({companyId,integrationId,provider,state,verifier=null,expiresInSeconds}){
    const stateHash=digest(Buffer.from(state,'utf8'));
    let stored=null;
    if(verifier)stored=await secretProvider.put({name:`marketplace/oauth/${provider}`,scope:'tenant',tenantId:companyId,value:verifier});
    try{
      await tenantTx(companyId,client=>client.query(`INSERT INTO rotamoto.marketplace_oauth_states(state_digest,company_id,integration_id,provider,redirect_uri,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`,[stateHash,companyId,integrationId,provider,publicCallbackUrl,new Date(clock().getTime()+expiresInSeconds*1000)]));
      if(stored)await accountWriter.scoped(companyId,client=>client.query(`INSERT INTO rotamoto.marketplace_oauth_secrets(state_digest,company_id,secret_ref) VALUES($1,$2,$3)`,[stateHash,companyId,stored.secretRef]));
    }catch(error){if(stored&&typeof secretProvider.remove==='function')await secretProvider.remove(stored.secretRef).catch(()=>{});throw error;}
    return stateHash;
  }
  async function begin(companyId,provider){
    if(!['ifood','keeta'].includes(provider))throw failure('PROVIDER_UNAVAILABLE',409);
    const integrationId=await ensureIntegration(companyId,provider);
    const credentials=await applicationCredentials(provider,companyId);
    if(!credentials||typeof credentials.clientId!=='string'||typeof credentials.clientSecret!=='string')throw failure('PROVIDER_CREDENTIALS_NOT_CONFIGURED',503);
    const state=crypto.randomBytes(32).toString('base64url');
    if(provider==='ifood'){
      const code=await adapters.ifood.requestUserCode({companyId,credentials});
      await storeState({companyId,integrationId,provider,state,verifier:code.authorizationCodeVerifier,expiresInSeconds:code.expiresIn});
      return Object.freeze({provider,state,userCode:code.userCode,verificationUrl:code.verificationUrlComplete,expiresIn:code.expiresIn,
        instructions:'Abra o link, autorize o aplicativo e informe o código de autorização recebido.'});
    }
    const url=await adapters.keeta.authorizationUrl({companyId,redirectUri:publicCallbackUrl,state,credentials});
    await storeState({companyId,integrationId,provider,state,expiresInSeconds:600});
    return Object.freeze({provider,state,authorizationUrl:url,expiresIn:600});
  }
  async function consumeState(companyId,provider,state){
    if(typeof state!=='string'||!/^[A-Za-z0-9_-]{40,64}$/u.test(state))throw failure('OAUTH_STATE_INVALID',400);
    const stateHash=digest(Buffer.from(state,'utf8'));
    const record=await tenantTx(companyId,async client=>{
      const result=await client.query(`UPDATE rotamoto.marketplace_oauth_states SET consumed_at=now()
        WHERE state_digest=$1 AND company_id=$2 AND provider=$3 AND consumed_at IS NULL AND expires_at>$4
        RETURNING integration_id::text,redirect_uri`,[stateHash,companyId,provider,clock()]);
      if(!result.rowCount)throw failure('OAUTH_STATE_EXPIRED_OR_USED',409);
      return result.rows[0];
    });
    return {stateHash,record};
  }
  async function verifier(companyId,stateHash){
    const row=await accountWriter.scoped(companyId,async client=>{
      const result=await client.query('SELECT secret_ref FROM rotamoto.marketplace_oauth_secrets WHERE company_id=$1 AND state_digest=$2',[companyId,stateHash]);return result.rows[0]||null;
    });
    if(!row?.secret_ref)throw failure('OAUTH_VERIFIER_UNAVAILABLE',503);
    return secretProvider.get(row.secret_ref,{name:'marketplace/oauth/ifood',scope:'tenant',tenantId:companyId});
  }
  async function finishIfood(companyId,{state,authorizationCode}){
    if(typeof authorizationCode!=='string'||!authorizationCode.trim()||authorizationCode.length>512)throw failure('INVALID_AUTHORIZATION_CODE',400);
    const consumed=await consumeState(companyId,'ifood',state);
    const codeVerifier=await verifier(companyId,consumed.stateHash);
    const app=await applicationCredentials('ifood',companyId);
    const token=await adapters.ifood.exchangeAuthorizationCode({companyId,authorizationCode:authorizationCode.trim(),authorizationCodeVerifier:codeVerifier,credentials:app});
    const temporaryScope=crypto.randomUUID();
    const credentials={...app,accessToken:token.accessToken,refreshToken:token.refreshToken,
      tokenExpiresAt:clock().getTime()+token.expiresIn*1000,accountScope:temporaryScope,companyId};
    const merchants=await adapters.ifood.merchants({companyId,credentials});
    if(!merchants.length)throw failure('AUTHORIZED_MERCHANT_NOT_VISIBLE_YET',409);
    const accounts=[];
    for(const merchant of merchants){
      const stored=await accountWriter.provision({companyId,provider:'ifood',merchantId:merchant.id,displayName:merchant.name,
        credentials:{clientId:app.clientId,clientSecret:app.clientSecret,refreshToken:token.refreshToken,tokenExpiresAt:clock().getTime()+token.expiresIn*1000}});
      accounts.push({id:stored.id,displayName:merchant.name,status:'active'});
    }
    await tenantTx(companyId,client=>client.query("UPDATE rotamoto.integrations SET status='active',updated_at=now() WHERE id=$1 AND company_id=$2",[consumed.record.integration_id,companyId]));
    await cleanupState(companyId,consumed.stateHash);
    return Object.freeze({provider:'ifood',accounts:Object.freeze(accounts)});
  }
  async function finishKeeta(companyId,{state,authId}){
    if(typeof authId!=='string'||!authId||authId.length>128||/[\u0000-\u001f\u007f]/u.test(authId))throw failure('INVALID_AUTH_ID',400);
    const consumed=await consumeState(companyId,'keeta',state);
    const app=await applicationCredentials('keeta',companyId);
    const result=await adapters.keeta.merchantInfo({companyId,authId,credentials:app});
    if(!Array.isArray(result.authorizedShops)||!result.authorizedShops.length)throw failure('AUTHORIZED_MERCHANT_NOT_VISIBLE_YET',409);
    const accounts=[];
    const seenShops=new Set();
    for(const shop of result.authorizedShops){
      const keetaMerchantId=typeof shop.shopId==='number'?shop.shopId:typeof shop.shopId==='string'&&/^\d+$/u.test(shop.shopId)?Number(shop.shopId):NaN;
      if(!Number.isSafeInteger(keetaMerchantId)||keetaMerchantId<1)continue;
      if(seenShops.has(String(shop.shopId)))continue;
      seenShops.add(String(shop.shopId));
      const stored=await accountWriter.provision({companyId,provider:'keeta',merchantId:String(shop.shopId),displayName:shop.shopName,
        active:false,credentials:{clientId:app.clientId,clientSecret:app.clientSecret}});
      const ordersWebhookURL=new URL(encodeURIComponent(stored.id),keetaWebhookBaseUrl.endsWith('/')?keetaWebhookBaseUrl:`${keetaWebhookBaseUrl}/`).toString();
      try{
        await adapters.keeta.onboardMerchant({companyId,merchantId:stored.serviceMerchantId,keetaMerchantId,ordersWebhookURL,credentials:app});
        await accountWriter.activate({companyId,accountId:stored.id,provider:'keeta',merchantId:String(shop.shopId)});
      }catch(error){
        const code=/^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code||'')?error.code:'KEETA_ONBOARDING_FAILED';
        await accountWriter.setError({companyId,accountId:stored.id,errorCode:code});
        throw error;
      }
      accounts.push({id:stored.id,displayName:typeof shop.shopName==='string'?shop.shopName.slice(0,160):null,status:'active'});
    }
    if(!accounts.length)throw failure('AUTHORIZED_MERCHANTS_INVALID',502);
    await tenantTx(companyId,client=>client.query("UPDATE rotamoto.integrations SET status='active',updated_at=now() WHERE id=$1 AND company_id=$2",[consumed.record.integration_id,companyId]));
    await cleanupState(companyId,consumed.stateHash);
    return Object.freeze({provider:'keeta',accounts:Object.freeze(accounts)});
  }
  async function cleanupState(companyId,stateHash){
    const row=await accountWriter.scoped(companyId,async client=>{
      const result=await client.query('DELETE FROM rotamoto.marketplace_oauth_secrets WHERE company_id=$1 AND state_digest=$2 RETURNING secret_ref',[companyId,stateHash]);return result.rows[0]||null;
    });
    if(row?.secret_ref&&typeof secretProvider.remove==='function')await secretProvider.remove(row.secret_ref).catch(()=>{});
    await tenantTx(companyId,client=>client.query('DELETE FROM rotamoto.marketplace_oauth_states WHERE company_id=$1 AND state_digest=$2',[companyId,stateHash]));
  }
  return Object.freeze({begin,finishIfood,finishKeeta});
}

module.exports={createMarketplaceAccountService,validPublicUrl};
