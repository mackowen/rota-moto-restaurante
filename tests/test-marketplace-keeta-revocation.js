'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {createMarketplaceHttpHandler}=require('../backend/integrations/marketplace-http');

async function request(handler,rawBody,signature){
  const req=Readable.from([rawBody]);req.url='/api/marketplace/keeta/authorization-webhook';req.method='POST';req.requestId='synthetic-request';
  req.headers={'content-type':'application/json','x-app-signature':signature};
  const response={headers:{},writeHead(status,headers){this.status=status;this.headers=headers;},end(body){this.body=body;}};
  await handler(req,response);return response;
}
(async()=>{
  const appSecret='synthetic-keeta-secret',calls=[];
  const handler=createMarketplaceHttpHandler({pool:{},adapters:{},accountResolver:{async byId(){return null;},async byMerchant(){return null;}},accountWriter:{async revokeKeetaAuthorization(value){calls.push(value);return {matched:true,duplicate:calls.length>1};}},
    keetaApplicationCredentials:async()=>({clientId:'12345',clientSecret:appSecret})});
  const event={authId:'synthetic-auth',clientId:12345,createTime:1791331200000,opType:2,shopId:789,shopName:'Synthetic Shop'};
  const raw=Buffer.from(JSON.stringify(event));const signature=crypto.createHmac('sha256',appSecret).update(raw).digest('base64');
  const accepted=await request(handler,raw,signature);assert.equal(accepted.status,200);assert.equal(JSON.parse(accepted.body).revoked,true);
  const replay=await request(handler,raw,signature);assert.equal(JSON.parse(replay.body).duplicate,true);assert.equal(calls.length,2);
  const forged=await request(handler,raw,`${signature.slice(0,-2)}aa`);assert.equal(forged.status,401);assert.equal(calls.length,2,'invalid signature cannot reach tenant revocation');
  const extra=Buffer.from(JSON.stringify({...event,company_id:'forged-tenant'}));const extraSig=crypto.createHmac('sha256',appSecret).update(extra).digest('base64');
  assert.equal((await request(handler,extra,extraSig)).status,400,'uncontracted tenant selector is rejected');assert.equal(calls.length,2);
  process.stdout.write('Keeta authorization revocation webhook: PASS (raw signature, body schema, idempotency boundary, forged tenant rejected)\n');
})().catch(error=>{process.stderr.write(`Keeta authorization revocation webhook: FAIL (${error.stack||error})\n`);process.exitCode=1;});
