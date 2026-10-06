'use strict';
const assert=require('node:assert/strict');
const {Readable}=require('node:stream');
const {COOKIE_NAME}=require('../backend/identity/http');
const {createTerritorialAnalyticsHttpHandler}=require('../backend/analytics/territorial-http');

async function call(handler,{path='/api/analytics/territorial?period=30',method='GET',payload,cookie=true,origin='https://app.example.invalid',permission='orders.read',csrf='csrf-ok'}={}) {
  const chunks=payload===undefined?[]:[Buffer.from(JSON.stringify(payload))];
  const req=Readable.from(chunks);req.url=path;req.method=method;req.headers={host:'app.example.invalid',...(cookie?{cookie:`${COOKIE_NAME}=${'A'.repeat(43)}`}:{ }),...(origin?{origin}:{}),...(payload?{'content-type':'application/json','content-length':String(Buffer.byteLength(JSON.stringify(payload)))}:{}),...(csrf?{'x-csrf-token':csrf}:{})};req.socket={encrypted:true,remoteAddress:'127.0.0.1'};req.clientIp='127.0.0.1';
  const res={headers:null,status:null,body:null,writeHead(status,headers){this.status=status;this.headers=headers},end(body){this.body=body}};
  const handled=await handler(req,res);return {handled,res};
}
(async()=>{
  let result=await call(createTerritorialAnalyticsHttpHandler({identityService:{async withAuthenticatedTenant(_t,op,p){assert.equal(p,'orders.read');return op({},{});}},service:{async heatmap(_c,_p,q){return{cells:[],query:q}}}}));
  assert.equal(result.handled,true);assert.equal(result.res.status,200);assert.equal(JSON.parse(result.res.body).source,undefined);
  result=await (async()=>{
    const h=createTerritorialAnalyticsHttpHandler({identityService:{async withAuthenticatedTenant(_t,op,p){assert.equal(p,'company.manage');return op({session_id:'s'},{company_id:'c',user_id:'u'})},async verifyCsrf(){return true}},service:{async setDestination(_c,_p,id,input){return{deliveryId:id,version:input.expectedVersion+1}}}});
    return call(h,{path:'/api/analytics/territorial/deliveries/11111111-1111-4111-8111-111111111111/destination',method:'PUT',payload:{latitude:-23,longitude:-46,accuracyM:null,confirmDestination:true,expectedVersion:0}});
  })();
  assert.equal(result.res.status,200);assert.equal(JSON.parse(result.res.body).version,1);
  result=await (async()=>{
    const h=createTerritorialAnalyticsHttpHandler({identityService:{async withAuthenticatedTenant(){throw Object.assign(new Error('no'),{code:'FORBIDDEN'})}},service:{}});
    return call(h,{permission:'company.manage',path:'/api/analytics/territorial/deliveries/11111111-1111-4111-8111-111111111111/destination',method:'PUT',payload:{latitude:0,longitude:0,confirmDestination:true,expectedVersion:0}});
  })();
  assert.equal(result.res.status,403);
  result=await (async()=>{
    const h=createTerritorialAnalyticsHttpHandler({identityService:{async withAuthenticatedTenant(_t,op){return op({session_id:'s'},{company_id:'c',user_id:'u'})},async verifyCsrf(){return false}},service:{async setDestination(){throw new Error('should not write')}}});
    return call(h,{path:'/api/analytics/territorial/deliveries/11111111-1111-4111-8111-111111111111/destination',method:'PUT',payload:{latitude:0,longitude:0,confirmDestination:true,expectedVersion:0}});
  })();
  assert.equal(result.res.status,403);
  result=await call(createTerritorialAnalyticsHttpHandler({identityService:{async withAuthenticatedTenant(){throw new Error('should not authenticate')}} ,service:{}}),{cookie:false});
  assert.equal(result.res.status,401);
  result=await call(createTerritorialAnalyticsHttpHandler({identityService:{async withAuthenticatedTenant(_t,op){return op({}, {driver_id:'driver'})}},service:{async heatmap(){throw new Error('driver scope must not query all-tenant aggregate')}}}));
  assert.equal(result.res.status,403);
  console.log('Territorial analytics HTTP authorization/CSRF checks: OK');
})().catch(error=>{process.stderr.write(`${error.name}: ${error.message}\n`);process.exitCode=1});
