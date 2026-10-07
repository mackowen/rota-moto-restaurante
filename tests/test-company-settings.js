'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {createAdminHttpHandler}=require('../backend/admin/http');
const {createAdminService}=require('../backend/admin/service');

const migration=fs.readFileSync(path.join(__dirname,'../backend/postgres/migrations/0033_company_operational_location.up.sql'),'utf8');
for(const column of ['support_phone','operational_address','operational_latitude','operational_longitude','operational_location_provenance','operational_location_version','company_settings_version'])assert.match(migration,new RegExp(`ADD COLUMN ${column}`));
assert.match(migration,/operational_location_provenance IS NULL OR operational_location_provenance = 'operator_confirmed'/u);
assert.match(migration,/GRANT SELECT \(support_phone, operational_address, operational_latitude, operational_longitude,/u);
assert.match(migration,/GRANT UPDATE \(name, support_phone, operational_address, operational_latitude, operational_longitude,/u);
assert.doesNotMatch(migration,/secret_ref|GRANT .* ON ALL TABLES|BYPASSRLS/u);
const groupingMigration=fs.readFileSync(path.join(__dirname,'../backend/postgres/migrations/0034_company_route_grouping_policy.up.sql'),'utf8');
assert.match(groupingMigration,/route_grouping_policy text NOT NULL DEFAULT 'nearest_extension'/u);
assert.match(groupingMigration,/route_grouping_policy IN \('nearest_extension', 'nearest_origin_round_robin'\)/u);
assert.match(groupingMigration,/GRANT SELECT \(route_grouping_policy\).*rotamoto_app/u);
assert.doesNotMatch(groupingMigration,/secret_ref|GRANT .* ON ALL TABLES|BYPASSRLS/u);

async function call(handler,url,body){const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.method='PUT';req.url=url;req.headers={'content-type':'application/json',cookie:`__Host-rotamoto_session=${'s'.repeat(43)}`,'x-csrf-token':'c'.repeat(43),origin:'https://restaurant.test'};req.socket={remoteAddress:'127.0.0.1',encrypted:true};let status,payload;const res={writeHead(value){status=value},end(value){payload=JSON.parse(value)}};await handler(req,res);return{status,payload}}

(async()=>{
  const received=[];
  const repository={async updateCompanyProfile(_client,principal,value){received.push({operation:'profile',tenant:principal.company_id,value});return{name:value.name,supportPhone:value.supportPhone,settingsVersion:value.expectedVersion+1}},
    async updateCompanyLocation(_client,principal,value){received.push({operation:'location',tenant:principal.company_id,value});return{operationalLocation:{address:value.address,latitude:value.latitude,longitude:value.longitude,provenance:'operator_confirmed',version:value.expectedVersion+1},operationalLocationVersion:value.expectedVersion+1}},
    async updateCompanyRouteGrouping(_client,principal,value){received.push({operation:'route-grouping',tenant:principal.company_id,value});return{routeGroupingPolicy:value.policy,settingsVersion:value.expectedVersion+1}}};
  const identityService={async withAuthenticatedTenant(_token,operation,permission){assert.equal(permission,'company.manage');return operation({},{company_id:'tenant-a',user_id:'operator-a'})},async verifyCsrf(){return true}};
  const handler=createAdminHttpHandler({identityService,adminService:createAdminService({repository}),allowedOrigin:'https://restaurant.test'});
  const profile=await call(handler,'/api/admin/company/profile',{expectedVersion:2,name:'Restaurante Principal',supportPhone:'11999990000'});
  assert.equal(profile.status,200);assert.equal(received[0].tenant,'tenant-a');assert.equal(received[0].value.name,'Restaurante Principal');
  const location=await call(handler,'/api/admin/company/location',{expectedVersion:0,address:'Rua Central, 10',latitude:-23.5,longitude:-46.6});
  assert.equal(location.status,200);assert.equal(location.payload.operationalLocation.provenance,'operator_confirmed');assert.equal(received[1].tenant,'tenant-a');
  const grouping=await call(handler,'/api/admin/company/route-grouping',{expectedVersion:2,policy:'nearest_origin_round_robin'});
  assert.equal(grouping.status,200);assert.equal(grouping.payload.routeGroupingPolicy,'nearest_origin_round_robin');assert.equal(received[2].tenant,'tenant-a');
  const invalidGrouping=await call(handler,'/api/admin/company/route-grouping',{expectedVersion:3,policy:'arbitrary'});
  assert.equal(invalidGrouping.status,400);assert.equal(received.length,3,'unsupported policy does not reach repository');
  const spoof=await call(handler,'/api/admin/company/location',{expectedVersion:1,address:'Rua',latitude:0,longitude:0,companyId:'tenant-b'});
  assert.equal(spoof.status,400);assert.equal(received.length,3,'unknown client tenant fields never reach repository');
  const badPair=await call(handler,'/api/admin/company/location',{expectedVersion:1,address:null,latitude:0,longitude:null});
  assert.equal(badPair.status,400);assert.equal(received.length,3,'unpaired coordinates are rejected');
  console.log('Company-owned settings, route grouping authority, explicit coordinates, revision and tenant validation: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
