'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { signParams, verifyWebhook, webhookEvent, normalizeOrder, create99FoodAdapter } = require('../backend/integrations/99food-protocol');
const { canonicalOrder } = require('../backend/integrations/marketplace-runtime');

const secret = 'synthetic-secret';
assert.equal(signParams({ timestamp: 1623814795, page_no: 1, app_id: '12345', page_size: 30 }, secret),
  signParams({ app_id: '12345', page_size: 30, page_no: 1, timestamp: 1623814795 }, secret));
const raw = Buffer.from('{"app_id":5764607584567296012,"app_shop_id":"shop-a","timestamp":1615432308,"type":"orderNew","data":{"order_id":5764607801871631353,"order_info":{"order_id":5764607801871631353,"status":100,"order_index":2,"delivery_type":1,"fulfillment_mode":0,"create_time":1615432308},"order_items":[{"app_item_id":"dish-1","name":"Dish","amount":2,"sku_price":250,"total_price":750,"real_price":700,"sub_item_list":[{"app_item_id":"extra-1","name":"Extra","amount":1,"sku_price":125,"total_price":125,"sub_item_list":[]}]}]}}');
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
const applicationRaw=Buffer.from(JSON.stringify({app_id:123,app_shop_id:'shop-a',timestamp:1615432309,type:'orderCancelApply',
  data:{order_id:'5764607801871631353',apply_id:'5764607801871639999',apply_reason:'customer text must not persist',
    reason_list:[{reason:'preparing'},{reason:'prepared'}],images:['https://example.invalid/private.jpg']}}));
const applicationSignature=crypto.createHash('md5').update(Buffer.concat([applicationRaw,Buffer.from(secret)])).digest('hex');
const applicationEvent=webhookEvent(applicationRaw,applicationSignature,secret);
assert.deepEqual(applicationEvent.application,{id:'5764607801871639999',reasons:[{id:'preparing',label:'preparing'},{id:'prepared',label:'prepared'}]});
assert.equal(JSON.stringify(applicationEvent).includes('customer text must not persist'),false);
assert.equal(JSON.stringify(applicationEvent).includes('private.jpg'),false);

const platformOrder = normalizeOrder({ data: { order_id:'5764607801871631353', order_info:{status:200,order_index:9,delivery_type:1,fulfillment_mode:0,create_time:1615432308,country:'BR',pay_type:1,pay_channel:150,
  price:{order_price:750,items_discount:50,delivery_price:100,service_price:25,customer_need_paying_money:825,shop_paid_money:15},
  order_items:[{app_item_id:'dish-1',name:'Dish',amount:2,sku_price:250,total_price:750,real_price:700,sub_item_list:[{app_item_id:'extra-1',name:'Extra',amount:1,sku_price:125,total_price:125,sub_item_list:[]}]}]} } });
assert.equal(platformOrder.status, 'confirmed');
assert.equal(platformOrder.fulfillment, 'platform');
assert.equal(platformOrder.items[0].quantity, 2);
assert.equal(platformOrder.items[0].options[0].name,'Extra');
assert.equal(platformOrder.items[0].lineTotalMinor,750);
assert.equal(platformOrder.money.currency,'BRL');
assert.equal(platformOrder.money.components.totalMinor,825);
assert.deepEqual(platformOrder.payment,{payType:1,payChannel:150,payMethod:null});
const canonicalPlatform = canonicalOrder('99food', platformOrder, { id:'00000000-0000-4000-8000-000000000099', companyId:'00000000-0000-4000-8000-000000000098' });
assert.equal(canonicalPlatform.status, 'AGUARDANDO');
assert.equal(canonicalPlatform.extensions.x_rotamoto_external_order.fulfillment, 'platform');
assert.equal(Object.hasOwn(canonicalPlatform, 'delivery'), false);
assert.equal(canonicalPlatform.money.provenance.sourceId,'99food');
assert.equal(canonicalPlatform.items[0].options[0].providerItemId,'extra-1');
assert.equal(canonicalPlatform.extensions.x_rotamoto_external_order.priceBreakdown.shop_paid_money,15);
assert.equal(canonicalPlatform.items[0].promotionSummary.length,0);
const ownDelivery = normalizeOrder({ data:{order_id:'42',order_info:{status:100,delivery_type:2,fulfillment_mode:0},order_items:[]} });
assert.equal(ownDelivery.fulfillment, 'merchant');
const pickup = normalizeOrder({ data:{order_id:'43',order_info:{status:100,delivery_type:0,fulfillment_mode:1},order_items:[]} });
assert.equal(pickup.fulfillment, 'customer_pickup');
assert.throws(() => normalizeOrder({data:{order_id:'44',order_info:{status:100,delivery_type:8,fulfillment_mode:0},order_items:[]}}), error => error.code === 'INVALID_PROVIDER_RESPONSE');
assert.throws(() => normalizeOrder({data:{order_id:'45',order_info:{status:100,delivery_type:1,fulfillment_mode:0,shop:{app_shop_id:'other'}},order_items:[]}},
  {expectedAppShopId:'shop-a'}),error=>error.code==='MERCHANT_ORDER_MISMATCH');

const requests=[];
const adapter=create99FoodAdapter({clock:()=>1710000000000,fetchImpl:async (url,init)=>{
  requests.push({url:String(url),init});
  return {status:200,ok:true,headers:{get:()=>null},json:async()=>({errno:0,errmsg:'ok',data:{order_id:'45',order_info:{status:100,delivery_type:1,fulfillment_mode:0,shop:{app_shop_id:'shop-a'}},order_items:[]}})};
}});
const creds={appId:'123',appSecret:secret,appShopId:'shop-a',authToken:'token'};
(async()=>{
  const longAdapter=create99FoodAdapter({fetchImpl:async()=>({status:200,ok:true,headers:{get:()=>null},text:async()=>'{"errno":0,"data":{"order_id":5764607801871631353,"order_info":{"status":100,"delivery_type":1,"fulfillment_mode":0,"shop":{"app_shop_id":"shop-a"}},"order_items":[]}}'})});
  assert.equal((await longAdapter.order({id:'5764607801871631353',credentials:creds})).externalId,'5764607801871631353',
    'API response parsing preserves 64-bit order identifiers before normalization');
  const result=await adapter.order({id:'45',credentials:creds});
  assert.equal(result.fulfillment,'platform');
  assert.match(requests[0].url,/https:\/\/openapi\.99food\.com\/v1\/order\/order\/detail/u);
  assert.equal(requests[0].init.method,'GET');
  assert.equal(requests[0].init.headers.Authorization,undefined);
  const confirmed=await adapter.command({operation:'CONFIRM',id:'45',credentials:creds});
  assert.equal(confirmed.errno,0);
  assert.match(requests[1].url,/\/v1\/order\/order\/confirm/u);
  assert.equal(JSON.parse(requests[1].init.body).order_id, '45');
  await adapter.command({operation:'DELIVERED',id:'45',credentials:creds});
  assert.match(requests[2].url,/\/v1\/order\/order\/delivered/u);
  await adapter.command({operation:'CONFIRM_CASH_PAYMENT',id:'45',credentials:creds});
  assert.match(requests[3].url,/\/v1\/order\/order\/payConfirm/u);
  await assert.rejects(adapter.command({operation:'SHIPPING_REQUEST',id:'45',credentials:creds}),error=>error.code==='UNSUPPORTED_OPERATION');
  await assert.rejects(adapter.command({operation:'CANCEL_ORDER',id:'45',credentials:creds,reasonId:1080}),error=>error.code==='INVALID_CANCELLATION');
  await assert.rejects(adapter.command({operation:'CANCEL_ORDER',id:'45',credentials:{...creds,deliveryType:1},reasonId:1060}),error=>error.code==='INVALID_CANCELLATION');
  await adapter.command({operation:'CANCEL_REQUEST',id:'45',credentials:creds,applyId:'apply-1',agree:true});
  assert.match(requests[4].url,/\/v1\/order\/apply\/cancel/u);
  await assert.rejects(adapter.command({operation:'REFUND_REQUEST',id:'45',credentials:creds,applyId:'apply-2',agree:false}),error=>error.code==='INVALID_APPLICATION_RESPONSE');
  await adapter.command({operation:'REFUND_REQUEST',id:'45',credentials:creds,applyId:'apply-2',agree:false,baseReasonId:'reason-1',baseReason:'synthetic'});
  assert.match(requests[5].url,/\/v1\/order\/apply\/refund/u);
  const cooldown=create99FoodAdapter({fetchImpl:async()=>({status:200,ok:true,json:async()=>({errno:10103,errmsg:'Fail to refresh'})})});
  await assert.rejects(cooldown.request('/v1/auth/authtoken/refresh',{credentials:creds,params:{app_secret:secret}}),
    error=>error.code==='PROVIDER_TOKEN_REFRESH_COOLDOWN'&&error.retryAfterSeconds===120);
  process.stdout.write('99Food protocol contract and adapter tests passed.\n');
})().catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
