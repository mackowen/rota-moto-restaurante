'use strict';
const assert=require('node:assert/strict');
process.env.NODE_ENV='test';
const {createOrsRouteDistanceProvider}=require('../backend/logistics/ors-route-distance');
const {createRouteDistanceProvider}=require('../backend/logistics/route-distance-provider');

(async()=>{
  const input={companyId:'tenant-synthetic',deliveryIds:['origin','a','b'],coordinatesByDeliveryId:{
    origin:{latitude:-23.55,longitude:-46.63},a:{latitude:-23.551,longitude:-46.631},b:{latitude:-23.552,longitude:-46.632}}};
  let calls=0,requestOptions=null,mode='ok';
  const fetchImpl=async(url,options)=>{
    calls++;requestOptions={url,options};
    if(mode==='timeout')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    const status=mode==='401'?401:mode==='403'?403:mode==='429'?429:mode==='5xx'?503:200;
    const payload=mode==='bad-json'?'not-json':mode==='no-route'?JSON.stringify({type:'FeatureCollection',features:[]}):JSON.stringify({type:'FeatureCollection',features:[{
      type:'Feature',geometry:{type:'LineString',coordinates:mode==='bad-coordinate'?[[181,-23.55],[-46.632,-23.552]]:[[-46.63,-23.55],[-46.6304,-23.5504],[-46.631,-23.551],[-46.632,-23.552]]},
      properties:{summary:{distance:1432.7,duration:99999},way_points:[0,1,3]}}]});
    return new Response(payload,{status,headers:{'content-type':mode==='bad-type'?'text/plain':'application/geo+json'}});
  };
  const provider=createOrsRouteDistanceProvider({apiKey:'synthetic-test-key',fetchImpl,timeoutMs:100,cacheTtlMs:10_000});
  assert.equal(provider.profile,'driving-car');
  const [first,concurrent]=await Promise.all([provider.calculateGeometry(input),provider.calculateGeometry(input)]);
  assert.equal(calls,1,'identical concurrent route requests are de-duplicated');
  assert.deepEqual(first,concurrent);assert.equal(first.status,'known');assert.equal(first.distanceM,1433);
  assert.equal(first.geometry.type,'LineString');assert.equal(first.geometry.coordinates.length,4);
  assert.equal(Object.hasOwn(first,'duration'),false,'provider duration is not an operational ETA');
  assert.equal(requestOptions.url,'https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson');
  assert.equal(requestOptions.options.method,'POST');assert.equal(requestOptions.options.headers.authorization,undefined);
  assert.equal(requestOptions.options.headers.Authorization,'synthetic-test-key');
  assert.match(requestOptions.options.body,/"coordinates"/u);assert.doesNotMatch(requestOptions.url,/tenant-synthetic|synthetic-test-key/u);
  const count=calls;assert.equal((await provider.calculateDistance(input)).distanceM,1433);assert.equal(calls,count,'geometry and distance share cache');
  for(const [value,reason] of [['401','ROUTE_DISTANCE_CREDENTIAL_REJECTED'],['403','ROUTE_DISTANCE_CREDENTIAL_REJECTED'],['429','ROUTE_DISTANCE_RATE_LIMITED'],['5xx','ROUTE_DISTANCE_HTTP_SERVER_ERROR'],['no-route','ROUTE_GEOMETRY_SCHEMA_INVALID'],['bad-json','ROUTE_DISTANCE_JSON_INVALID'],['bad-type','ROUTE_DISTANCE_CONTENT_TYPE_INVALID'],['bad-coordinate','ROUTE_GEOMETRY_SCHEMA_INVALID']]){
    mode=value;const result=await createOrsRouteDistanceProvider({apiKey:'synthetic-test-key',fetchImpl,cacheTtlMs:0}).calculateGeometry({...input,companyId:`${value}-tenant`});
    assert.notEqual(result.status,'known',value);assert.equal(result.reason,reason,value);
  }
  mode='ok';const malformed=await provider.calculateGeometry({...input,coordinatesByDeliveryId:{...input.coordinatesByDeliveryId,a:{latitude:91,longitude:0}}});
  assert.equal(malformed.status,'unknown');assert.equal(malformed.reason,'ROUTE_DISTANCE_COORDINATES_INVALID');
  assert.throws(()=>createOrsRouteDistanceProvider({apiKey:'x',baseUrl:'http://example.test'}),/HTTPS/u);
  assert.throws(()=>createOrsRouteDistanceProvider({apiKey:'x',baseUrl:'https://example.test/unexpected'}),/base HTTPS/u);
  assert.throws(()=>createOrsRouteDistanceProvider({apiKey:'x',profile:'motorcycle'}),/configuration/u);
  assert.throws(()=>createOrsRouteDistanceProvider({}),/API key/u);
  mode='timeout';const timeoutProvider=createOrsRouteDistanceProvider({apiKey:'synthetic-test-key',fetchImpl,timeoutMs:100,cacheTtlMs:0});
  const timeoutCalls=calls;const timeout=await timeoutProvider.calculateGeometry({...input,companyId:'timeout-tenant'});
  assert.equal(timeout.status,'unavailable');assert.equal(timeout.reason,'ROUTE_DISTANCE_PROVIDER_UNAVAILABLE');assert.equal(calls,timeoutCalls+1,'timeout has no automatic retry');
  mode='ok';const limited=createOrsRouteDistanceProvider({apiKey:'synthetic-test-key',fetchImpl,requestsPerMinute:1,cacheTtlMs:0});
  const allowed=await limited.calculateGeometry({...input,companyId:'limit-a'});assert.equal(allowed.status,'known');
  const limitedCalls=calls,blocked=await limited.calculateGeometry({...input,companyId:'limit-b'});
  assert.equal(blocked.reason,'ROUTE_DISTANCE_RATE_LIMITED');assert.equal(calls,limitedCalls,'local rate limit rejects without an extra provider call');
  const disabled=createRouteDistanceProvider({enabled:false});assert.equal(disabled,null);
  assert.equal(createRouteDistanceProvider({enabled:true,provider:'osrm',baseUrl:'http://127.0.0.1:5000',timeoutMs:500}).providerId,'osrm-route-v1');
  assert.equal(createRouteDistanceProvider({enabled:true,provider:'ors',baseUrl:'https://api.heigit.org/openrouteservice',profile:'driving-car',timeoutMs:500,
    requestsPerMinute:40},{apiKey:'synthetic-test-key',fetchImpl}).providerId,'openrouteservice-driving-car-v2','generic factory injects ORS without a provider-specific caller dependency');
  console.log('ORS adapter contract fixtures: request shape, validation, privacy, deduplication and failure mapping OK (no external call)');
})().catch(error=>{console.error(error);process.exitCode=1});
