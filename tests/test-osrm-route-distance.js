'use strict';
const assert=require('node:assert/strict');
const http=require('node:http');
process.env.NODE_ENV='test';
const {createOsrmRouteDistanceProvider}=require('../backend/logistics/osrm-route-distance');
const {createRouteDistanceService,calculateInsertionOptions}=require('../backend/logistics/route-insertion');

(async()=>{
  let mode='ok',requests=[],calls=0,modeCalls=0;
  const server=http.createServer((req,res)=>{
    calls++;requests.push({url:req.url,headers:req.headers});
    if(mode==='hang')return;
    if(mode==='fail-after-first'&&++modeCalls>1){res.writeHead(503,{'content-type':'application/json'});res.end('{}');return;}
    if(mode==='large'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({code:'Ok',routes:[{distance:10}],padding:'x'.repeat(70_000)}));return;}
    if(mode==='invalid-json'){res.writeHead(200,{'content-type':'application/json'});res.end('{');return;}
    if(mode==='bad-distance'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({code:'Ok',routes:[{distance:Infinity}]}));return;}
    if(mode==='overflow'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({code:'Ok',routes:[{distance:5_000_001}]}));return;}
    if(mode==='invalid-version'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({code:'Ok',data_version:42,routes:[{distance:10}]}));return;}
    if(mode==='unreachable'){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:'NoRoute'}));return;}
    if(mode==='4xx'||mode==='5xx'){res.writeHead(mode==='4xx'?400:503,{'content-type':'application/json'});res.end('{}');return;}
    res.writeHead(200,{'content-type':'application/json'});
    const sequence=new URL(req.url,'http://local').pathname.split('/').at(-1);
    const nums=sequence.split(';').map(point=>Number(point.split(',')[0]));
    const distance=nums.join(',')==='0,1'?10000:nums.join(',')==='2,0,1'?12500:nums.join(',')==='0,2,1'?11200:nums.join(',')==='0,1,2'?13000:nums.length*1000;
    res.end(JSON.stringify({code:'Ok',data_version:'2026-10-01T00:00:00Z',routes:[{distance,duration:999999}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${server.address().port}`;
  try{
    const provider=createOsrmRouteDistanceProvider({baseUrl:endpoint,version:'dataset-2026-10',timeoutMs:2000,cacheTtlMs:5000});
    const coordinatesByDeliveryId={a:{latitude:1,longitude:0},b:{latitude:2,longitude:1},new:{latitude:3,longitude:2}};
    const before=await provider.calculateDistance({companyId:'tenant-a',routeId:'private-route',deliveryIds:['a','b'],coordinatesByDeliveryId});
    assert.equal(before.status,'known');assert.equal(before.distanceM,10000);assert.equal(before.provenance.providerId,'osrm-route-v1');
    assert.equal(typeof before.provenance.evaluatedAt,'string');assert.equal(before.provenance.version,'2026-10-01T00:00:00Z','OSRM dataset version is retained when returned');
    const requestUrl=requests.at(-1).url;
    assert.match(requestUrl,/\/route\/v1\/driving\/0,1;1,2\?/u);
    assert.doesNotMatch(requestUrl,/tenant|delivery|route-a|Authorization|secret_ref/iu,'only coordinate sequence reaches OSRM');
    assert.equal(requests.at(-1).headers.authorization,undefined);
    const cachedCount=calls;
    const cached=await provider.calculateDistance({companyId:'tenant-a',deliveryIds:['a','b'],coordinatesByDeliveryId});
    assert.equal(cached.distanceM,10000);assert.equal(calls,cachedCount,'successful route result is cached');
    await provider.calculateDistance({companyId:'tenant-b',deliveryIds:['a','b'],coordinatesByDeliveryId});
    assert.equal(calls,cachedCount+1,'cache is tenant scoped');
    const otherConfig=createOsrmRouteDistanceProvider({baseUrl:endpoint,version:'different',timeoutMs:150});
    await otherConfig.calculateDistance({companyId:'tenant-a',deliveryIds:['a','b'],coordinatesByDeliveryId});
    assert.equal(calls,cachedCount+2,'cache is configuration scoped');
    const service=createRouteDistanceService({provider});
    const insertion=await calculateInsertionOptions({companyId:'tenant-c',routeId:'r',deliveryIds:['a','b'],newDeliveryId:'new',
      capacity:{status:'known',remainingSlots:1},coordinatesByDeliveryId,routeDistanceService:service});
    assert.equal(insertion.status,'known');assert.deepEqual(insertion.candidates.map(row=>row.position),[0,1,2]);
    assert.deepEqual(insertion.candidates.map(row=>row.incrementalDistanceM),[2500,1200,3000]);assert.equal(insertion.bestPosition,1);
    assert.equal(Object.hasOwn(before,'duration'),false,'OSRM duration is not promoted into ETA');
    for(const [current,expected,reason] of [['unreachable','unavailable','ROUTE_DISTANCE_UNREACHABLE'],['4xx','unavailable','ROUTE_DISTANCE_HTTP_ERROR'],
      ['5xx','unavailable','ROUTE_DISTANCE_HTTP_SERVER_ERROR'],['invalid-json','unknown','ROUTE_DISTANCE_JSON_INVALID'],
      ['bad-distance','unknown','ROUTE_DISTANCE_SCHEMA_INVALID'],['overflow','unknown','ROUTE_DISTANCE_SCHEMA_INVALID'],
      ['invalid-version','unknown','ROUTE_DISTANCE_SCHEMA_INVALID'],
      ['large','unknown','ROUTE_DISTANCE_RESPONSE_TOO_LARGE']]){
      mode=current;const value=await provider.calculateDistance({companyId:'error-tenant',deliveryIds:['a','b'],coordinatesByDeliveryId:{a:coordinatesByDeliveryId.a,b:{latitude:2,longitude:1.5}}});
      assert.equal(value.status,expected,current);assert.equal(value.reason,reason,current);
    }
    mode='ok';const invalid=await provider.calculateDistance({companyId:'x',deliveryIds:['a','b'],coordinatesByDeliveryId:{a:{latitude:91,longitude:0},b:{latitude:0,longitude:0}}});
    assert.equal(invalid.status,'unknown');assert.equal(invalid.reason,'ROUTE_DISTANCE_COORDINATES_INVALID');
    assert.equal((await createOsrmRouteDistanceProvider().calculateDistance({})).reason,'ROUTE_DISTANCE_PROVIDER_NOT_CONFIGURED');
    assert.throws(()=>createOsrmRouteDistanceProvider({baseUrl:'http://example.org'}),/HTTPS/u);
    mode='fail-after-first';modeCalls=0;
    const interrupted=await calculateInsertionOptions({companyId:'tenant-mid-request',routeId:'r',deliveryIds:['a','b'],newDeliveryId:'new',
      capacity:{status:'known',remainingSlots:1},coordinatesByDeliveryId,routeDistanceService:service});
    assert.equal(interrupted.status,'unavailable','a provider outage midway through n+1 comparison fails closed');
    assert.equal(interrupted.bestPosition,null,'partial candidate coverage cannot pick a route insertion');
    mode='hang';const timeoutProvider=createOsrmRouteDistanceProvider({baseUrl:endpoint,timeoutMs:100});const timed=await timeoutProvider.calculateDistance({companyId:'timeout',deliveryIds:['a','b'],coordinatesByDeliveryId:{a:coordinatesByDeliveryId.a,b:{latitude:2,longitude:1.5}}});
    assert.equal(timed.status,'unavailable');assert.equal(timed.reason,'ROUTE_DISTANCE_PROVIDER_UNAVAILABLE');
    console.log('OSRM route-distance adapter: local HTTP contract, privacy, cache, insertion and fail-closed cases OK');
  }finally{await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1});
