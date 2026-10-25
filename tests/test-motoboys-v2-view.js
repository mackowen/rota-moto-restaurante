'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
const first=source.indexOf('function bikesV2Icon(');
const last=source.indexOf('function destroyRouteMap()',first);
assert(first>=0&&last>first,'Motoboys V2 renderer is present');
const renderer=source.slice(first,last);
function renderFixture(count,{queue=[],availability={},permissions=true}={}){
  const drivers=Array.from({length:count},(_,index)=>({id:`driver-${index+1}`,companyId:'tenant-synthetic',name:`Pessoa ${index+1}`,phone:index===0?'(11) 90000-0001':'',status:'ACTIVE',createdAt:1000+index,updatedAt:2000+index,sync:{canonicalId:`canonical-${index+1}`}}));
  const context={
    state:{bikes:drivers,bikesUI:{selectedId:null,section:'overview',filter:'all',sort:'name',query:'',mobileDetail:false},pagination:{},settings:{global:{companyId:'tenant-synthetic'}}},
    restaurantQueueRecords:queue,restaurantQueueStatus:queue.length||count===0?'confirmed':'unknown',operationalAvailabilityCheckedAt:Object.keys(availability).length?1:0,operationalAvailabilityFailure:null,
    restaurantQueueLoading:false,restaurantQueueFailure:null,restaurantDispatchSettings:{mode:'manual',revision:1},syncSession:{companyId:'tenant-synthetic'},
    driverAvailabilityRecord:driver=>availability[driver.sync?.canonicalId]||null,
    bikeRaces:()=>[],locationInfo:()=>({valid:false,lat:null,lng:null,at:null,fresh:false,stale:false}),bikeArrivalDistance:()=>null,
    pageSlice:(key,rows)=>({items:rows,page:1,size:50,total:rows.length}),pager:()=>'',
    can:action=>permissions&&['create','edit','orders.manage','company.manage'].includes(action),canModule:()=>permissions,
    icon:name=>`<svg data-icon="${name}"></svg>`,header:(title,subtitle,actions='')=>`<header>${title} ${subtitle}${actions}</header>`,
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    dateFmt:value=>String(value||'sem data'),status:value=>`<span class="status">${value}</span>`,
    emptyStateMarkup:(title,copy)=>`<div class="empty"><strong>${title}</strong><span>${copy}</span></div>`,
    console,Date,Math,String,Number,Array,Map,Set,Intl,JSON
  };
  vm.createContext(context);vm.runInContext(renderer,context,{timeout:1000});
  return {html:vm.runInContext('bikes()',context,{timeout:1000}),state:context.state,drivers};
}
for(const count of [0,1,5,20]){
  const {html}=renderFixture(count);
  assert.match(html,/data-bikes-v2/u);
  if(count===0)assert.match(html,/bikes-v2-workspace no-selection/u,'empty roster uses one operational empty state, not a duplicate detail panel');
  assert.equal((html.match(/class="bikes-v2-person /gu)||[]).length,Math.min(count,50),`renders ${count} real roster rows`);
  assert.match(html,/Cadastrados/u);
  assert.match(html,/Disponibilidade não confirmada/u,'unknown availability is not rendered as offline/zero');
  assert.doesNotMatch(html,/<img\b|R\$ 48,50|92%/u,'no profile photos or reference-only financial values');
  if(count)assert.match(html,/Visão geral[\s\S]*Corridas[\s\S]*Histórico[\s\S]*Localização/u);
}
const syntheticQueue=[{driverId:'canonical-1',name:'Pessoa 1',online:true,present:true,confirmed:true,eligible:true,busy:false,checkedInAt:'2026-10-25T10:00:00Z'}];
const {html}=renderFixture(1,{queue:syntheticQueue,availability:{'canonical-1':{effectiveStatus:'online',updatedAt:'2026-10-25T10:00:00Z'}}});
assert.match(html,/Online/u);
assert.match(html,/Elegível/u);
assert.match(html,/presença confirmada/u);
assert.match(html,/data-bikeassign="canonical-1"/u,'operational action delegates using the canonical Driver id');
assert.match(source,/async function openAssignment\(preselectBikeId,preselectOrderId=null\)\{\s*if\(!canModule\('orders'\)\)/u,'assignment entry checks module access');
assert.match(source,/preselectBikeId===b\.id\|\|preselectBikeId===\(b\.sync\?\.canonicalId\|\|b\.id\)/u,'assignment recognizes local and canonical Driver identity');
assert(source.includes("()=>put('bikes',b)"),'new Driver continues through the existing local-first store');
if(process.argv.includes('--fixture')){
  const countArg=process.argv.find(argument=>argument.startsWith('--fixture-count='));
  const fixtureCount=countArg?Math.max(0,Math.min(20,Number(countArg.split('=')[1])||0)):5;
  const queue=Array.from({length:fixtureCount},(_,index)=>({driverId:`canonical-${index+1}`,name:`Motoboy ${index+1}`,online:index<3,present:index<2,confirmed:index<2,eligible:index===0,busy:index===1,checkedInAt:index<2?`2026-10-25T10:${String(index).padStart(2,'0')}:00Z`:null}));
  const availability=Object.fromEntries(queue.map((row,index)=>[row.driverId,{effectiveStatus:index<3?'online':'offline',updatedAt:'2026-10-25T10:05:00Z'}]));
  const fixture=renderFixture(fixtureCount,{queue,availability});
  process.stdout.write(JSON.stringify({html:fixture.html.replace(/^<header>[\s\S]*?<\/header>/u,'')})+'\n');
}else console.log('Motoboys V2 rendering, responsive data contract, and dispatch entry guards: PASS');
