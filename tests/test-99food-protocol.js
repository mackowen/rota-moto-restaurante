'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signParams, verifyWebhook, webhookEvent, normalizeOrder, create99FoodAdapter } = require('../backend/integrations/99food-protocol');
const { canonicalOrder } = require('../backend/integrations/marketplace-runtime');

const secret = 'synthetic-secret';
assert.equal(signParams({ timestamp: 1623814795, page_no: 1, app_id: '12345', page_size: 30 }, secret),
  signParams({ app_id: '12345', page_size: 30, page_no: 1, timestamp: 1623814795 }, secret));
const raw = Buffer.from('{"app_id":5764607584567296012,"app_shop_id":"shop-a","timestamp":1615432308,"type":"orderNew","data":{"order_id":5764607801871631353,"order_info":{"order_id":5764607801871631353,"status":100,"order_index":2,"delivery_type":1,"fulfillment_mode":0,"create_time":1615432308},"order_items":[{"name":"Dish","amount":2}]}}');
const signature = crypto.createHash('md5').update(Buffer.concat([raw, Buffer.from(secret)])).digest('hex');
assert.equal(verifyWebhook(raw, signature, secret), true);
assert.equal(verifyWebhook(raw, '0'.repeat(32), secret), false);
const event = webhookEvent(raw, signature, secret);
assert.equal(event.externalOrderId, '5764607801871631353');
assert.equal(event.status, 'placed');
assert.equal(event.externalAccountId, 'shop-a');
assert.equal(event.requiresOrderFetch, true);
assert.equal(webhookEvent(raw, signature, secret).externalEventId, event.externalEventId, 'provider webhook replay has a stable deduplication identity');
assert.throws(() => webhookEvent(raw, signature, 'wrong'), error => error.code === 'INVALID_SIGNATURE');

const platformOrder = normalizeOrder({ data: { order_id:'5764607801871631353', order_info:{status:200,order_index:9,delivery_type:1,fulfillment_mode:0,create_time:1615432308}, order_items:[{name:'Dish',amount:2}] } });
assert.equal(platformOrder.status, 'confirmed');
assert.equal(platformOrder.fulfillment, 'platform');
assert.equal(platformOrder.items[0].quantity, 2);
const canonicalPlatform = canonicalOrder('99food', platformOrder, { id:'00000000-0000-4000-8000-000000000099', companyId:'00000000-0000-4000-8000-000000000098' });
assert.equal(canonicalPlatform.status, 'AGUARDANDO');
assert.equal(canonicalPlatform.extensions.x_rotamoto_external_order.fulfillment, 'platform');
assert.equal(Object.hasOwn(canonicalPlatform, 'delivery'), false);
const ownDelivery = normalizeOrder({ data:{order_id:'42',order_info:{status:100,delivery_type:2,fulfillment_mode:0},order_items:[]} });
assert.equal(ownDelivery.fulfillment, 'merchant');
const pickup = normalizeOrder({ data:{order_id:'43',order_info:{status:100,delivery_type:0,fulfillment_mode:1},order_items:[]} });
assert.equal(pickup.fulfillment, 'customer_pickup');
assert.throws(() => normalizeOrder({data:{order_id:'44',order_info:{status:100,delivery_type:8,fulfillment_mode:0},order_items:[]}}), error => error.code === 'INVALID_PROVIDER_RESPONSE');

const requests=[];
const adapter=create99FoodAdapter({clock:()=>1710000000000,fetchImpl:async (url,init)=>{
  requests.push({url:String(url),init});
  return {status:200,ok:true,headers:{get:()=>null},json:async()=>({errno:0,errmsg:'ok',data:{order_id:'45',order_info:{status:100,delivery_type:1,fulfillment_mode:0},order_items:[]}})};
}});
const creds={appId:'123',appSecret:secret,appShopId:'shop-a',authToken:'token'};
(async()=>{
  const result=await adapter.order({id:'45',credentials:creds});
  assert.equal(result.fulfillment,'platform');
  assert.match(requests[0].url,/https:\/\/openapi\.99food\.com\/v1\/order\/order\/detail/u);
  assert.equal(requests[0].init.method,'GET');
  assert.equal(requests[0].init.headers.Authorization,undefined);
  const confirmed=await adapter.command({operation:'CONFIRM',id:'45',credentials:creds});
  assert.equal(confirmed.errno,0);
  assert.match(requests[1].url,/\/v1\/order\/order\/confirm/u);
  assert.equal(JSON.parse(requests[1].init.body).order_id, '45');
  await assert.rejects(adapter.command({operation:'SHIPPING_REQUEST',id:'45',credentials:creds}),error=>error.code==='UNSUPPORTED_OPERATION');
  await assert.rejects(adapter.command({operation:'CANCEL_ORDER',id:'45',credentials:creds,reasonId:1080}),error=>error.code==='INVALID_CANCELLATION');
  await adapter.command({operation:'CANCEL_REQUEST',id:'45',credentials:creds,applyId:'apply-1',agree:true});
  assert.match(requests[2].url,/\/v1\/order\/apply\/cancel/u);
  await assert.rejects(adapter.command({operation:'REFUND_REQUEST',id:'45',credentials:creds,applyId:'apply-2',agree:false}),error=>error.code==='INVALID_APPLICATION_RESPONSE');
  await adapter.command({operation:'REFUND_REQUEST',id:'45',credentials:creds,applyId:'apply-2',agree:false,baseReasonId:'reason-1',baseReason:'synthetic'});
  assert.match(requests[3].url,/\/v1\/order\/apply\/refund/u);
  process.stdout.write('99Food protocol contract and adapter tests passed.\n');
})().catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
