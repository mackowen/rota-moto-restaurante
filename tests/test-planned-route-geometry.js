'use strict';
const assert=require('node:assert/strict');
const {createLogisticsIntelligenceService}=require('../backend/logistics/intelligence');

const companyId='00000000-0000-4000-8000-000000000010';
const routeId='00000000-0000-4000-8000-000000000020';
const stopA='00000000-0000-4000-8000-000000000030';
const stopB='00000000-0000-4000-8000-000000000040';
const driverId='00000000-0000-4000-8000-000000000050';
function clientFor({driver=driverId,provenance='manual',origin=true}={}){return {async query(sql,params){
  if(sql.includes("payload->>'status' AS status"))return {rowCount:1,rows:[{version:4,status:'ACTIVE',delivery_ids:[stopA,stopB]}]};
  if(sql.includes('operational_latitude'))return {rowCount:origin?1:0,rows:origin?[{origin_mode:'establishment',origin_latitude:-23.5,origin_longitude:-46.6,
    origin_provenance:'confirmed_address',return_to_origin:true,version:3,establishment_location_version:7,updated_at:new Date(),operational_address:'Synthetic origin'}]:[]};
  if(sql.includes('WITH ORDINALITY planned'))return {rowCount:2,rows:[
    {delivery_id:stopA,driver_id:driver,provenance,accuracy_m:8,latitude:-23.51,longitude:-46.61},
    {delivery_id:stopB,driver_id:driver,provenance,accuracy_m:9,latitude:-23.52,longitude:-46.62}
  ]};
  throw new Error(`Unexpected query: ${sql.slice(0,80)}`);
}}}

(async()=>{
  const inputs=[];
  const provider={providerId:'osrm-route-v1',async calculateDistance(){return {status:'unavailable',distanceM:null,reason:'UNUSED'}},async calculateGeometry(input){inputs.push(input);return {status:'known',geometry:{type:'LineString',coordinates:[[-46.6,-23.5],[-46.61,-23.51],[-46.62,-23.52],[-46.6,-23.5]]},distanceM:5200,provenance:{kind:'canonical',providerId:'osrm-route-v1'}}}};
  const service=createLogisticsIntelligenceService({routeDistanceProvider:provider});
  const principal={company_id:companyId,driver_id:driverId};
  const result=await service.getPlannedRouteGeometry(clientFor(),principal,routeId);
  assert.equal(result.status,'known');assert.equal(result.routeId,routeId);assert.equal(result.routeVersion,4);assert.deepEqual(result.deliveryIds,[stopA,stopB]);
  assert.deepEqual(result.stops,[{deliveryId:stopA,position:1,latitude:-23.51,longitude:-46.61},{deliveryId:stopB,position:2,latitude:-23.52,longitude:-46.62}],
    'authorized route response exposes only ordered, confirmed destination snapshots for its assigned stops');
  assert.deepEqual(result.origin,{latitude:-23.5,longitude:-46.6,provenance:'confirmed_address',mode:'establishment'});
  assert.deepEqual(inputs[0].deliveryIds,['__route_origin__',stopA,stopB,'__route_origin__'],'origin, canonical stop sequence and configured return are preserved');
  assert.deepEqual(inputs[0].coordinatesByDeliveryId[stopA],{latitude:-23.51,longitude:-46.61});
  assert.equal(Object.hasOwn(result,'duration'),false,'route geometry never implies an ETA');
  await assert.rejects(()=>service.getPlannedRouteGeometry(clientFor(),{company_id:companyId,driver_id:'00000000-0000-4000-8000-000000000099'},routeId),error=>error.code==='NOT_FOUND');
  const missingCoords=await service.getPlannedRouteGeometry(clientFor({provenance:'approximate'}),{company_id:companyId},routeId);
  assert.equal(missingCoords.status,'unavailable');assert.equal(missingCoords.reason,'ROUTE_STOP_COORDINATES_INCOMPLETE');
  const missingOrigin=await service.getPlannedRouteGeometry(clientFor({origin:false}),{company_id:companyId},routeId);
  assert.equal(missingOrigin.status,'unavailable');assert.equal(missingOrigin.reason,'ROUTE_ORIGIN_UNKNOWN');
  assert.equal(missingOrigin.stops.length,2,'destination markers remain available when road origin is unknown');
  const noProvider=await createLogisticsIntelligenceService().getPlannedRouteGeometry(clientFor(),{company_id:companyId,driver_id:driverId},routeId);
  assert.equal(noProvider.reason,'ROUTE_GEOMETRY_PROVIDER_NOT_CONFIGURED');
  assert.deepEqual(noProvider.stops.map(stop=>stop.deliveryId),[stopA,stopB],'ordered stops do not depend on a routing provider');
  console.log('Canonical planned route geometry scope, sequence, provenance and fail-closed cases: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
