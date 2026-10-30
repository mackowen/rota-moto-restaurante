const fs=require('fs'),vm=require('vm');
const src=fs.readFileSync(__dirname+'/app.js','utf8');
function grab(name){const start=src.indexOf('function '+name+'(');if(start<0)throw new Error('missing '+name);let i=src.indexOf('{',start),depth=0,inStr=null,esc=false;for(;i<src.length;i++){const c=src[i];if(inStr){if(esc)esc=false;else if(c==='\\')esc=true;else if(c===inStr)inStr=null;continue}if(c==='"'||c==="'"||c==='`'){inStr=c;continue}if(c==='{')depth++;else if(c==='}'&&--depth===0)return src.slice(start,i+1)}throw new Error('unclosed '+name)}
const names=['normalizeDeliveryModel','normalizedDeliveryRanges','validateDeliveryRanges','calculateDeliveryFee','motoboyEarningsForDelivery'];
let code=names.map(grab).join('\n');code+=';globalThis.test={'+names.join(',')+'};';
const ctx={money:n=>`R$ ${Number(n).toFixed(2)}`,syncSession:{companyId:'tenant-a'},state:{settings:{}}};vm.createContext(ctx);vm.runInContext(code,ctx);const t=ctx.test;
const assert=(a,b,m)=>{if(a!==b)throw Error(`${m}: ${a} !== ${b}`)};
const pricing=settings=>({delivery:settings,deliveryPricingCanonical:{configured:true,companyId:'tenant-a',settings}});
let s=pricing({model:'perKm',perKm:2.5,minFee:8,round:false,roundTo:1,ranges:[],repasseMode:'full',repassePercent:100});
assert(t.calculateDeliveryFee(4.2,s).value,10.5,'per KM');assert(t.motoboyEarningsForDelivery({deliveryFee:10.5},s),10.5,'100% repasse');
s.deliveryPricingCanonical.settings.repasseMode='percentage';s.deliveryPricingCanonical.settings.repassePercent=90;assert(t.motoboyEarningsForDelivery({deliveryFee:20},s),18,'90% repasse');
s=pricing({model:'range',minFee:0,perKm:99,fixedFee:99,round:false,roundTo:1,ranges:[{from:0,to:3,value:8},{from:3,to:5,value:10},{from:5,to:null,value:15}],repasseMode:'percentage',repassePercent:80});
assert(t.calculateDeliveryFee(4.2,s).value,10,'range');assert(t.calculateDeliveryFee(7,s).value,15,'open range');assert(t.motoboyEarningsForDelivery({deliveryFee:15},s),12,'80% range payout');
 s=pricing({model:'perDelivery',fixedFee:12,minFee:0,round:false,roundTo:1,ranges:[],repasseMode:'full',repassePercent:100});assert(t.calculateDeliveryFee(99,s).value,12,'fixed');
s=pricing({model:'range',ranges:[{from:0,to:5,value:10}],minFee:0,round:false});assert(t.calculateDeliveryFee(6,s).value,null,'no fallback');
assert(t.calculateDeliveryFee(4.2,{delivery:{model:'perKm',perKm:99}}).error,'pricing_unavailable','device-only settings are never used as canonical delivery pricing');
console.log('billing logic tests: OK');
