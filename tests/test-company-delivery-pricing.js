'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Readable}=require('node:stream');
const {createAdminHttpHandler,validateDeliveryPricing}=require('../backend/admin/http');
const {createAdminService}=require('../backend/admin/service');
const {createAdminRepository}=require('../backend/admin/repository');
const app=fs.readFileSync(require.resolve('../app.js'),'utf8');
const migration=fs.readFileSync(require.resolve('../backend/postgres/migrations/0064_company_delivery_pricing.up.sql'),'utf8');
assert.match(migration,/ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/u,'canonical pricing requires forced tenant RLS');
assert.match(migration,/USING \(company_id=rotamoto\.current_tenant_id\(\)\)[\s\S]*WITH CHECK \(company_id=rotamoto\.current_tenant_id\(\)\)/u,'pricing isolation is tied to the authenticated tenant');
assert.doesNotMatch(migration,/INSERT INTO rotamoto\.company_delivery_pricing/u,'migration never copies legacy device values into canonical storage');
async function testUnavailableSchemaIsReported(){
 const repository=createAdminRepository(),companyRow={id:'tenant-a',name:'Empresa teste',status:'active',time_zone:null,support_phone:null,operational_address:null,operational_latitude:null,operational_longitude:null,operational_location_provenance:null,operational_location_version:0,company_settings_version:0,route_grouping_policy:'nearest_extension',created_at:new Date(),updated_at:new Date()};let pricingQueryIssued=false;
 const response=await repository.company({async query(sql){if(sql.includes('FROM rotamoto.companies'))return {rowCount:1,rows:[companyRow]};if(sql.includes('to_regclass'))return {rowCount:1,rows:[{available:false}]};if(sql.includes('FROM rotamoto.company_delivery_pricing'))pricingQueryIssued=true;throw Object.assign(new Error('unexpected query'),{code:'TEST_UNEXPECTED_QUERY'})}},{company_id:'tenant-a'});
 assert.equal(response.deliveryPricing.available,false,'pre-0064 schema explicitly disables pricing writes instead of advertising support');
 assert.equal(pricingQueryIssued,false,'the old schema is detected before a missing-table query can abort the transaction');
}
const operation=app.slice(app.indexOf("if(cat==='operacao')return card"),app.indexOf("if(cat==='origens'"));
assert.match(operation,/data-save-company-delivery-pricing/u,'pricing has an explicit company save');
assert.match(app,/baseVersion:previous\?\.baseVersion/u,'local draft retains its original canonical version');
assert.match(app,/expectedVersion=draft\?\.baseVersion/u,'a stale local draft cannot be silently rebased');
assert.match(app,/\/admin\/company\/delivery-pricing/u,'write/readback uses the company pricing API');
assert.match(app,/pricing_unavailable/u,'no fee is calculated from device-only settings');
assert.match(app,/deliveryPricingCanonical/u,'calculations consume canonical server pricing');
assert.match(app,/not\s+automatically|not\s+sent|não foram enviados/u,'legacy device values are not represented as canonical');
const pricingSave=app.slice(app.indexOf('async function saveCompanyDeliveryPricing()'),app.indexOf('\n}\n',app.indexOf('async function saveCompanyDeliveryPricing()'))+2);
assert.match(pricingSave,/data-delivery-model[\s\S]*data-setting\^="delivery\."[\s\S]*data-range-delete/u,'all model, pricing and range controls are locked for the save/readback cycle');
assert.match(pricingSave,/control\.isConnected\)control\.disabled=wasDisabled/u,'controls recover their previous authorization/disabled state after completion');
const valid={model:'perKm',minFee:5,perKm:2.5,fixedFee:8,round:true,roundTo:0.5,ranges:[{from:0,to:3,value:7},{from:3,to:null,value:11}],repasseMode:'percentage',repassePercent:85};
assert.deepEqual(validateDeliveryPricing({expectedVersion:0,settings:valid}).settings,valid);
for(const bad of [null,{}, {...valid,model:'range',ranges:[null]}, {...valid,model:'range',ranges:[{from:0,to:5,value:5},{from:4,to:null,value:7}]}, {...valid,model:'range',ranges:[{from:1,to:null,value:7}]}, {...valid,model:'perKm',perKm:0}, {...valid,perKm:1.001}, {...valid,repassePercent:101}])assert.throws(()=>validateDeliveryPricing({expectedVersion:0,settings:bad}),error=>error.code==='INVALID_INPUT');
async function call(handler,url,method,body){const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);req.method=method;req.url=url;req.headers={'content-type':'application/json',cookie:`__Host-rotamoto_session=${'s'.repeat(43)}`,'x-csrf-token':'c'.repeat(43),origin:'https://restaurant.test'};req.socket={remoteAddress:'127.0.0.1',encrypted:true};let status,payload;const res={writeHead(value){status=value},end(value){payload=value?JSON.parse(value):null}};await handler(req,res);return{status,payload}}
(async()=>{
 await testUnavailableSchemaIsReported();
 let writes=0;const repository={async updateCompanyDeliveryPricing(_client,principal,input){writes++;assert.equal(principal.company_id,'tenant-a');return {configured:true,settings:input.settings,version:input.expectedVersion+1}}};
 const identityService={async withAuthenticatedTenant(_token,operation,permission){assert.equal(permission,'company.manage');return operation({},{company_id:'tenant-a',user_id:'admin'})},async verifyCsrf(){return true}};
 const handler=createAdminHttpHandler({identityService,adminService:createAdminService({repository}),allowedOrigin:'https://restaurant.test'});
 const saved=await call(handler,'/api/admin/company/delivery-pricing','PUT',{expectedVersion:0,settings:valid});assert.equal(saved.status,200);assert.equal(saved.payload.version,1);assert.equal(writes,1);
 const invalid=await call(handler,'/api/admin/company/delivery-pricing','PUT',{expectedVersion:0,settings:{...valid,ranges:[null]}});assert.equal(invalid.status,400);assert.equal(writes,1);
 console.log('Company delivery pricing versioning, validation, atomic API handler and draft safeguards: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
