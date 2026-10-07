'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ui=fs.readFileSync(require.resolve('../logistics-ui.js'),'utf8');
assert.match(ui,/const \[\{settings:routeSettings\},company\] = await Promise\.all\(\[api\('\/logistics\/route-settings'\),api\('\/admin\/company'\)\]\)/u,
  'Logistics settings consume the canonical direct Company response without a duplicate wrapper assumption');
process.env.NODE_ENV='test';
const {createLogisticsIntelligenceService}=require('../backend/logistics/intelligence');
const companyId='10000000-0000-4000-8000-000000000001',userId='20000000-0000-4000-8000-000000000001';
const calls=[];
let stored=null;
let companyLocation=null;
const client={async query(sql,params=[]){calls.push({sql,params});
  if(sql.includes('FROM rotamoto.companies company LEFT JOIN rotamoto.logistics_route_settings')){const mode=stored?.origin_mode||'establishment',origin=mode==='custom'?stored:companyLocation;return {rowCount:1,rows:[{origin_mode:mode,origin_latitude:origin?.latitude??origin?.origin_latitude??null,origin_longitude:origin?.longitude??origin?.origin_longitude??null,origin_provenance:mode==='custom'?stored?.origin_provenance:companyLocation?.provenance||null,return_to_origin:stored?.return_to_origin||false,version:stored?.version||0,establishment_location_version:companyLocation?.version||0,updated_at:stored?.updated_at||'2026-10-06T00:00:00Z',operational_address:companyLocation?.address||null}]};}
  if(sql.includes('SELECT version FROM rotamoto.logistics_route_settings'))return {rowCount:stored?1:0,rows:stored?[{version:stored.version}]:[]};
  if(sql.includes('INSERT INTO rotamoto.logistics_route_settings')){stored={origin_mode:params[1],origin_latitude:params[2],origin_longitude:params[3],origin_provenance:params[4],
    return_to_origin:params[5],version:stored?(stored.version+1):1,updated_at:'2026-10-06T00:00:00Z'};return {rowCount:1,rows:[{version:stored.version,updated_at:stored.updated_at}]};}
  return {rowCount:1,rows:[]};
}};
const principal={company_id:companyId,user_id:userId};
const service=createLogisticsIntelligenceService({});
(async()=>{
  const unknown=(await service.getRouteSettings(client,principal)).settings;assert.equal(unknown.originMode,'establishment');assert.equal(unknown.origin,null);assert.equal(unknown.establishmentLocationVersion,0);
  companyLocation={latitude:-23.55,longitude:-46.63,provenance:'operator_confirmed',version:4,address:'Endereço cadastral'};
  const establishment=(await service.getRouteSettings(client,principal)).settings;assert.deepEqual(establishment.origin,{latitude:-23.55,longitude:-46.63,address:'Endereço cadastral'});assert.equal(establishment.originProvenance,'operator_confirmed');assert.equal(establishment.establishmentLocationVersion,4);
  const saved=await service.updateRouteSettings(client,principal,{expectedVersion:0,originMode:'custom',latitude:12.3,longitude:-45.6,returnToOrigin:true});
  assert.equal(saved.settings.origin.latitude,12.3);assert.equal(saved.settings.returnToOrigin,true);
  assert.equal(saved.settings.origin.longitude,-45.6,'custom Route origin remains separate from Company location');assert.equal(companyLocation.latitude,-23.55);
  const write=calls.find(item=>item.sql.includes('INSERT INTO rotamoto.logistics_route_settings'));
  assert.equal(write.params[0],companyId,'settings write is tenant scoped');assert.equal(write.params[6],userId,'operator recorded');
  const audit=calls.find(item=>item.sql.includes("'logistics.route_settings_updated'"));
  assert.ok(audit,'configuration update is audited');assert.equal(audit.params[1],companyId);assert.equal(audit.params[3],companyId,
    'audit resource id is a separate text parameter, not a reused tenant UUID placeholder');
  await assert.rejects(service.updateRouteSettings(client,principal,{expectedVersion:0,originMode:'custom',latitude:91,longitude:1,returnToOrigin:false}),/Coordenadas/u);
  await assert.rejects(service.updateRouteSettings(client,principal,{expectedVersion:0,originMode:'establishment',latitude:1,longitude:null,returnToOrigin:false}),/estabelecimento/u);
  console.log('Operational route origin/return settings validation and tenant scope: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
