'use strict';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function parseCredentials(serialized) {
  let value;
  try { value = JSON.parse(serialized); } catch (_) { throw Object.assign(new Error('Marketplace credential is invalid.'),{code:'CREDENTIAL_INVALID'}); }
  const allowed = new Set(['clientId','clientSecret','refreshToken','authorizationCode','authorizationCodeVerifier','accessToken','tokenExpiresAt','accountScope','companyId']);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.has(key)) ||
      typeof value.clientId !== 'string' || !value.clientId || typeof value.clientSecret !== 'string' || !value.clientSecret) {
    throw Object.assign(new Error('Marketplace credential is invalid.'),{code:'CREDENTIAL_INVALID'});
  }
  return Object.freeze({ ...value, accountScope:value.accountScope||null, companyId:value.companyId||null });
}

function createMarketplaceAccountResolver({ privilegedPool, secretProvider } = {}) {
  if (!privilegedPool || !secretProvider) throw new TypeError('Marketplace resolver requires privileged database and secret provider.');
  async function withTenant(companyId, operation) {
    if (!UUID.test(companyId || '')) throw Object.assign(new Error('Invalid tenant.'),{code:'INVALID_TENANT'});
    const client=await privilegedPool.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.tenant_id',$1,true)",[companyId]);
      const identity=await client.query('SELECT current_user AS role');
      if(identity.rows[0]?.role!=='rotamoto_provider_resolver') throw Object.assign(new Error('Resolver role is not isolated.'),{code:'CREDENTIAL_ROLE_INVALID'});
      const result=await operation(client); await client.query('COMMIT'); return result;
    } catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;} finally{client.release();}
  }
  async function material(row) {
    const credentials=parseCredentials(await secretProvider.get(row.secret_ref,{name:`marketplace/${row.provider}/${row.id}`,scope:'tenant',tenantId:row.company_id}));
    return Object.freeze({ id:row.id,companyId:row.company_id,integrationId:row.integration_id,provider:row.provider,
      merchantId:row.merchant_id,serviceMerchantId:row.service_merchant_id,status:row.account_status,
      authorized:row.authorized&&row.link_status==='confirmed',credentials,webhookSecret:credentials.clientSecret });
  }
  async function lookup(where,values) {
    const companyId=where.companyId;
    const row=await withTenant(companyId,async client=>{
      const result=await client.query(`SELECT ea.id::text,ea.company_id::text,ea.integration_id::text,ea.link_status,ea.account_status,ea.secret_ref,
        b.provider,b.merchant_id,b.service_merchant_id,b.authorized
        FROM rotamoto.external_accounts ea JOIN rotamoto.marketplace_account_bindings b
          ON b.company_id=ea.company_id AND b.external_account_id=ea.id
        JOIN rotamoto.integrations i ON i.company_id=ea.company_id AND i.id=ea.integration_id
        WHERE ${where.sql} AND b.authorized AND ea.account_status='active' AND ea.link_status='confirmed' AND i.status='active'
        ORDER BY b.created_at DESC LIMIT 2`,values);
      if(result.rowCount!==1) return null;
      return result.rows[0];
    });
    return row?material(row):null;
  }
  async function byId(provider,accountId,companyId=null) {
    if(!UUID.test(accountId||'')) return null;
    // Webhook account route IDs are opaque lookup hints; tenant identity comes only from the row.
    const route=await (async()=>{
      const client=await privilegedPool.connect();try{const r=await client.query(`SELECT company_id::text FROM rotamoto.marketplace_account_routes
        WHERE provider=$1 AND route_kind='account' AND route_key=$2`,[provider,accountId]);return r.rows.length===1?r.rows[0].company_id:null;}finally{client.release();}
    })();
    const findCompany=companyId||route;
    if(!findCompany||route&&route!==findCompany)return null;
    return lookup({companyId:findCompany,sql:'ea.company_id=$1 AND ea.id=$2 AND b.provider=$3'},[findCompany,accountId,provider]);
  }
  async function byMerchant(provider,merchantId) {
    if(typeof merchantId!=='string'||!merchantId||merchantId.length>255)return null;
    // Global uniqueness of (provider, merchant_id) is enforced by migration 0035.
    const client=await privilegedPool.connect();let companyId;
    try{const result=await client.query(`SELECT company_id::text FROM rotamoto.marketplace_account_routes
      WHERE provider=$1 AND route_kind='merchant' AND route_key=$2`,[provider,merchantId]);companyId=result.rows.length===1?result.rows[0].company_id:null;}
    finally{client.release();}
    return companyId?lookup({companyId,sql:'b.company_id=$1 AND b.provider=$2 AND b.merchant_id=$3'},[companyId,provider,merchantId]):null;
  }
  async function list(companyId,provider) {
    const rows=await withTenant(companyId,async client=>(await client.query(`SELECT ea.id::text FROM rotamoto.external_accounts ea
      JOIN rotamoto.marketplace_account_bindings b ON b.company_id=ea.company_id AND b.external_account_id=ea.id
      JOIN rotamoto.integrations i ON i.company_id=ea.company_id AND i.id=ea.integration_id
      WHERE ea.company_id=$1 AND b.provider=$2 AND b.authorized AND ea.account_status='active' AND ea.link_status='confirmed' AND i.status='active'`,[companyId,provider])).rows);
    const values=[];for(const row of rows){const item=await byId(provider,row.id,companyId);if(item)values.push(item);}return values;
  }
  async function credentials(provider,companyId) { const rows=await list(companyId,provider);return rows[0]?.credentials||null; }
  return Object.freeze({byId,byMerchant,list,credentials});
}

module.exports={createMarketplaceAccountResolver,parseCredentials};
