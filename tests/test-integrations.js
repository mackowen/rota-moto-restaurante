'use strict';
const {create99FoodService}=require('../99food-service');
const {createKeetaService}=require('../keeta-service');
function assert(x,m){if(!x)throw new Error(m)}
const f=create99FoodService({FOOD99_BASE_URL:'https://sandbox.example',FOOD99_CLIENT_ID:'id',FOOD99_CLIENT_SECRET:'secret',FOOD99_WEBHOOK_SECRET:'hook'});
assert(f.diagnostics().configured,'99Food adapter should report configured');
const k=createKeetaService({KEETA_CLIENT_ID:'id',KEETA_CLIENT_SECRET:'secret',KEETA_APP_ID:'app'});
const sig=k.signature('GET','https://open.mykeeta.com/api/open/opendelivery/v1/events:polling',{b:'2',a:'1'},{});
assert(sig&&typeof sig==='string','Keeta signature must be generated server-side');
console.log('provider adapter tests: OK');
