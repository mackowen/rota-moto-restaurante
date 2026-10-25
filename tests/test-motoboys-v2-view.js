'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8');
const first=source.indexOf('function bikesV2Icon(');
const last=source.indexOf('function destroyRouteMap()',first);
assert(first>=0&&last>first,'Motoboys V2 renderer is present');
const renderer=source.slice(first,last);
function fixtureIcon(name){const paths={bike:'<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="m6 17 3-8h4l5 8M9 9h3l2 4H8"/>',bag:'<path d="M5 8h14l-1 13H6zM9 8a3 3 0 0 1 6 0"/>',pin:'<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',route:'<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 17c5 0 1-7 8-9"/>'};return `<svg data-icon="${name}" viewBox="0 0 24 24">${paths[name]||'<circle cx="12" cy="12" r="7"/>'}</svg>`}
function renderFixture(count,{queue=[],availability={},permissions=true,width=1280}={}){
  const drivers=Array.from({length:count},(_,index)=>({id:`driver-${index+1}`,companyId:'tenant-synthetic',name:`Pessoa ${index+1}`,phone:'',status:'ACTIVE',createdAt:1000+index,updatedAt:2000+index,sync:{canonicalId:`canonical-${index+1}`}}));
  const context={
    state:{bikes:drivers,bikesUI:{selectedId:null,section:'overview',filter:'all',sort:'name',query:'',mobileDetail:false},pagination:{},settings:{global:{companyId:'tenant-synthetic'}}},
    restaurantQueueRecords:queue,restaurantQueueStatus:queue.length||count===0?'confirmed':'unknown',operationalAvailabilityCheckedAt:Object.keys(availability).length?1:0,operationalAvailabilityFailure:null,
    restaurantQueueLoading:false,restaurantQueueFailure:null,restaurantDispatchSettings:{mode:'manual',revision:1},syncSession:{companyId:'tenant-synthetic'},
    driverAvailabilityRecord:driver=>availability[driver.sync?.canonicalId]||null,
    bikeRaces:()=>[],locationInfo:()=>({valid:false,lat:null,lng:null,at:null,fresh:false,stale:false}),bikeArrivalDistance:()=>null,
    pageSlice:(key,rows)=>({items:rows,page:1,size:50,total:rows.length}),pager:()=>'',
    can:action=>permissions&&['create','edit','orders.manage','company.manage'].includes(action),canModule:()=>permissions,
    document:{querySelector:selector=>selector==='.bikes-v2'?null:selector==='#main'?{getBoundingClientRect:()=>({width}),scrollTop:0}:null},getComputedStyle:()=>({paddingLeft:'0px',paddingRight:'0px'}),window:{innerWidth:width},
    icon:fixtureIcon,header:(title,subtitle,actions='')=>`<header>${title} ${subtitle}${actions}</header>`,
    esc:value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),
    dateFmt:value=>String(value||'sem data'),status:value=>`<span class="status">${value}</span>`,
    emptyStateMarkup:(title,copy,iconName='bag')=>`<div class="empty"><div class="empty-icon">${fixtureIcon(iconName)}</div><strong>${title}</strong><span>${copy}</span></div>`,
    console,Date,Math,String,Number,Array,Map,Set,Intl,JSON
  };
  vm.createContext(context);vm.runInContext(renderer,context,{timeout:1000});
  return {html:vm.runInContext('bikes()',context,{timeout:1000}),state:context.state,drivers,render:()=>vm.runInContext('bikes()',context,{timeout:1000})};
}
for(const count of [0,1,5,20]){
  const {html}=renderFixture(count);
  assert.match(html,/data-bikes-v2/u);
  if(count===0)assert.match(html,/bikes-v2-workspace no-selection/u,'empty roster uses one operational empty state, not a duplicate detail panel');
  assert.equal((html.match(/class="bikes-v2-person /gu)||[]).length,Math.min(count,50),`renders ${count} real roster rows`);
  assert.match(html,/Cadastrados/u);
  assert.match(html,/Disponibilidade não confirmada/u,'unknown availability is not rendered as offline/zero');
  assert.doesNotMatch(html,/<img\b|R\$ 48,50|92%|\(11\) 90000-0001/u,'no profile photos, personal-looking fixture phone, or reference-only financial values');
  if(count)assert.match(html,/Visão geral[\s\S]*Corridas[\s\S]*Histórico[\s\S]*Localização/u);
}
const mobileStart=renderFixture(5,{width:390});
assert.equal(mobileStart.state.bikesUI.selectedId,null,'mobile opens on the roster rather than auto-opening the first person');
assert.equal(mobileStart.state.bikesUI.mobileDetail,false,'initial mobile state is the roster');
assert.match(mobileStart.html,/bikes-v2-workspace no-selection/u,'initial mobile renderer carries the list-only state');
const mobileDetail=renderFixture(1,{width:390});
mobileDetail.state.bikesUI.selectedId=mobileDetail.drivers[0].id;
mobileDetail.state.bikesUI.mobileDetail=true;
mobileDetail.html=mobileDetail.render();
assert.match(mobileDetail.html,/class="bikes-v2 mobile-detail"/u,'mobile detail mode belongs to the root targeted by responsive visibility rules');
assert.doesNotMatch(mobileDetail.html,/class="bikes-v2-workspace[^"]*mobile-detail/u,'workspace does not carry a state class consumed by root-level selectors');
mobileDetail.state.bikesUI.section='location';
const mobileLocation=mobileDetail.render();
assert.match(mobileLocation,/<div class="empty-icon"><svg data-icon="pin" viewBox="0 0 24 24"><path/u,'empty location fixture includes a visible semantic icon instead of an empty SVG');
const syntheticQueue=[{driverId:'canonical-1',name:'Pessoa 1',online:true,present:true,confirmed:true,eligible:true,busy:false,checkedInAt:'2026-10-25T10:00:00Z'}];
const {html}=renderFixture(1,{queue:syntheticQueue,availability:{'canonical-1':{effectiveStatus:'online',updatedAt:'2026-10-25T10:00:00Z'}}});
assert.match(html,/Online/u);
assert.match(html,/Elegível/u);
assert.match(html,/presença confirmada/u);
const noCheckin=renderFixture(1,{queue:[{driverId:'canonical-1',name:'Pessoa 1',online:true,present:false,confirmed:false,eligible:false,busy:false}],availability:{'canonical-1':{effectiveStatus:'online'}}}).html;
assert.match(noCheckin,/Sem check-in/u);
assert.match(noCheckin,/Online · sem check-in confirmado/u,'online lease remains distinct from missing presence check-in');
const waitingPresence=renderFixture(1,{queue:[{driverId:'canonical-1',name:'Pessoa 1',online:true,present:true,confirmed:false,eligible:false,busy:false}],availability:{'canonical-1':{effectiveStatus:'online'}}}).html;
assert.match(waitingPresence,/Online · aguardando elegibilidade/u,'confirmed online lease remains distinct from dispatch eligibility');
assert.match(html,/data-bikeassign="canonical-1"/u,'operational action delegates using the canonical Driver id');
assert.match(html,/aria-label="Voltar à equipe"/u,'detail return affordance is concise and accessible');
assert.match(source,/ui\.listScroll=bikesV2ReadScroll\(\)/u,'mobile selection preserves the roster scroll position');
assert.match(source,/bikesV2RestoreScroll\(position\)/u,'return restores the preserved roster scroll position');
assert.match(source,/function bikesV2CompactNavigation\(\)/u,'responsive selection uses available container width');
assert.match(source,/state\.tab==='bikes'&&tab!=='bikes'&&state\.bikesUI\)state\.bikesUI\.mobileDetail=false/u,'leaving the module returns its compact view to the roster state');
assert.match(fs.readFileSync(require.resolve('../styles.css'),'utf8'),/\.bikes-v2 \.empty-icon[^}]*background:var\(--info-soft\);color:var\(--info\)/u,'empty state icon uses semantic contrast tokens');
assert.match(source,/async function openAssignment\(preselectBikeId,preselectOrderId=null\)\{\s*if\(!canModule\('orders'\)\)/u,'assignment entry checks module access');
assert.match(source,/preselectBikeId===b\.id\|\|preselectBikeId===\(b\.sync\?\.canonicalId\|\|b\.id\)/u,'assignment recognizes local and canonical Driver identity');
assert(source.includes("()=>put('bikes',b)"),'new Driver continues through the existing local-first store');
if(process.argv.includes('--fixture')){
  const countArg=process.argv.find(argument=>argument.startsWith('--fixture-count='));
  const widthArg=process.argv.find(argument=>argument.startsWith('--fixture-width='));
  const sectionArg=process.argv.find(argument=>argument.startsWith('--fixture-section='));
  const fixtureCount=countArg?Math.max(0,Math.min(20,Number(countArg.split('=')[1])||0)):5;
  const fixtureWidth=widthArg?Math.max(320,Number(widthArg.split('=')[1])||390):390;
  const queue=Array.from({length:fixtureCount},(_,index)=>({driverId:`canonical-${index+1}`,name:`Motoboy ${index+1}`,online:index<3,present:index<2,confirmed:index<2,eligible:index===0,busy:index===1,checkedInAt:index<2?`2026-10-25T10:${String(index).padStart(2,'0')}:00Z`:null}));
  const availability=Object.fromEntries(queue.map((row,index)=>[row.driverId,{effectiveStatus:index<3?'online':'offline',updatedAt:'2026-10-25T10:05:00Z'}]));
  const fixture=renderFixture(fixtureCount,{queue,availability,width:fixtureWidth});
  if(sectionArg&&fixture.drivers.length){fixture.state.bikesUI.selectedId=fixture.drivers[0].id;fixture.state.bikesUI.section=sectionArg.split('=')[1];fixture.state.bikesUI.mobileDetail=fixtureWidth<780;fixture.html=fixture.render()}
  process.stdout.write(JSON.stringify({html:fixture.html.replace(/^<header>[\s\S]*?<\/header>/u,'')})+'\n');
}else console.log('Motoboys V2 rendering, responsive data contract, and dispatch entry guards: PASS');
module.exports={renderFixture};
