'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const cardSource=source.match(/function ordersV2CardList\(rows\)\{[^\n]*\}/u)?.[0];
const bindSource=source.match(/function bindOrdersV2Actions\(root=document\)\{[^\n]*\}/u)?.[0];
const opsBindSource=source.match(/function bindOrdersOperationalActions\(root=document\)\{[^\n]*\}/u)?.[0];
const eligibleSource=source.match(/function ordersV2EligibleQueue\(records,now=Date\.now\(\)\)\{[^\n]*\}/u)?.[0];
const dispatchableSource=source.match(/function ordersV2CanDispatch\(order\)\{[^\n]*\}/u)?.[0];
assert(cardSource&&bindSource&&opsBindSource&&eligibleSource&&dispatchableSource,'production card renderer, dispatch eligibility and operation handlers are independently testable');
const calls={};
const context={
  ordersSelectedId:'synthetic-1',
  ordersV2QrEligible:order=>Boolean(order.qrEligible),
  emptyStateMarkup:(title,detail)=>'<div>'+title+': '+detail+'</div>',
  isExternalOrder:()=>false,knownDeliveryFeeBRL:order=>order.fee,
  esc:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
  dateFmt:()=> '24/10/2026, 10:30',
  status:value=>'<span class="status">'+String(value)+'</span>',
  externalOrderStatus:()=> '',orderSourceLabel:order=>order.source,
  money:value=>'R$ '+Number(value).toFixed(2),
  ordersV2Icon:name=>'<svg data-icon="'+name+'" aria-hidden="true"></svg>',
  openDetail:id=>calls.open=id,openPrintPreview:id=>calls.print=id,openQrPreview:id=>calls.qr=id,
  renderOrdersOperationalPanel:()=>{calls.panel=(calls.panel||0)+1},
  state:{pagination:{orders:1},orders:[{id:'synthetic-1'},{id:'synthetic-2'}]},filterOrders:()=>{calls.filter=true},
  document:{querySelector:()=>null},can:()=>true,ordersV2CanDispatch:()=>true,
  refreshRestaurantQueue:options=>{calls.queueRefresh=options},
  openAssignment:(driver,order)=>{calls.assignment={driver,order}}
};
vm.runInNewContext(cardSource+"\n"+bindSource+"\n"+opsBindSource+"\nthis.render=ordersV2CardList;this.bind=bindOrdersV2Actions;this.bindOps=bindOrdersOperationalActions;",context);
vm.runInNewContext(eligibleSource+"\nthis.eligible=ordersV2EligibleQueue;",context);
assert.deepEqual(Array.from(context.eligible([
  {driverId:'eligible',eligible:true,leaseExpiresAt:'2026-10-24T10:01:00.000Z'},
  {driverId:'unconfirmed',eligible:false,leaseExpiresAt:'2026-10-24T10:01:00.000Z'},
  {driverId:'expired',eligible:true,leaseExpiresAt:'2026-10-24T09:59:00.000Z'},
  {driverId:'missing-lease',eligible:true,leaseExpiresAt:null}
],Date.parse('2026-10-24T10:00:00.000Z')).map(row=>row.driverId)),['eligible'],'operations panel only counts server-eligible couriers with a live lease');
context.canAssignOwnDelivery=order=>order.ownDelivery!==false;
context.orderPlanningStatus=order=>order.status;
context.RotaMotoContract={canTransition:(from,to)=>from==='CREATED'&&to==='ASSIGNED'||from==='REDELIVERY'&&to==='ASSIGNED'};
vm.runInNewContext(dispatchableSource+'\nthis.dispatchable=ordersV2CanDispatch;',context);
assert.equal(context.dispatchable({status:'CREATED',ownDelivery:true}),true,'a new eligible own delivery may be offered for assignment');
for(const row of [
  {status:'ASSIGNED',ownDelivery:true},
  {status:'CREATED',ownDelivery:true,driverId:'already-assigned'},
  {status:'CREATED',ownDelivery:false},
  {status:'CREATED',ownDelivery:true,deleted:true}
])assert.equal(context.dispatchable(row),false,'assigned, external, deleted or ineligible states are excluded');
const orders=[
 {id:'synthetic-1',num:'S-1',customer:'Cliente Um',address:'Rua Exemplo 1, Centro',status:'AGUARDANDO',bike:'Não atribuído',source:'Manual',fee:12,qrEligible:false},
 {id:'synthetic-2',num:'S-2',customer:'Cliente Dois',address:'Avenida longa de teste, 200, complemento 5, Bairro Central',status:'EM ROTA',bike:'Motoboy Dois',source:'iFood',fee:18.5,qrEligible:true}
];
const html=context.render(orders);
assert.equal((html.match(/class="orders-v2-card /gu)||[]).length,2,'one card is rendered per order');
assert.equal((html.match(/data-orders-open=/gu)||[]).length,2,'each card has one primary open action');
assert.equal((html.match(/data-orders-print=/gu)||[]).length,2,'each card has one compact print action');
assert.equal((html.match(/data-orders-select=/gu)||[]).length,2,'selection remains on every card');
assert.equal((html.match(/data-orders-qr=/gu)||[]).length,1,'QR appears only for an eligible delivery');
assert.equal((html.match(/Abrir pedido/gu)||[]).length,2,'one clearly named primary order action per card');
assert.match(html,/Rua Exemplo 1, Centro/u);assert.match(html,/Motoboy Dois/u);assert.match(html,/R\$ 18\.50/u);
assert.doesNotMatch(html,/orders-v2-table|ordersV2Selection/u,'no duplicate table or persistent detail panel is emitted');
assert.match(context.render([]),/Nenhum pedido encontrado/u,'empty list remains informative');
for(const count of [1,5,20]){
  const rows=Array.from({length:count},(_,i)=>({id:`fixture-${count}-${i}`,num:String(i+1),customer:`Cliente ${i+1}`,address:'Endereço sintético',status:'AGUARDANDO',source:'Manual',fee:10}));
  assert.equal((context.render(rows).match(/class="orders-v2-card /gu)||[]).length,count,`${count}-order fixture renders exactly one card per order`);
}
let selected;
selected={dataset:{orderId:'synthetic-1'},classList:{toggle(name,value){selected[name]=value}},querySelector(){return{setAttribute(name,value){selected[name]=value}}}};
const select={dataset:{ordersSelect:'synthetic-1'},onclick:null,click(){this.onclick()}};
const open={dataset:{ordersOpen:'synthetic-2'},onclick:null,click(){this.onclick()}};
const print={dataset:{ordersPrint:'synthetic-2'},onclick:null,click(){this.onclick()}};
const qr={dataset:{ordersQr:'synthetic-2'},onclick:null,click(){this.onclick()}};
const root={querySelectorAll(selector){return selector==='[data-orders-select]'?[select]:selector==='[data-orders-open]'?[open]:selector==='[data-orders-print]'?[print]:selector==='[data-orders-qr]'?[qr]:selector==='[data-orders-metric]'?[]:selector==='.orders-v2-card'?[selected]:[]}};
 const button=dataset=>({dataset,onclick:null,addEventListener(_name,handler){this.onclick=handler},click(){this.onclick({currentTarget:this})}});
const all=button({}),queueDispatch=button({ordersQueueDispatch:'waiting-synthetic'}),refresh=button({});
context.document.querySelector=selector=>selector==='[data-orders-queue-refresh]'?refresh:null;
const opsRoot={querySelector:selector=>selector==='[data-orders-dispatch-all]'?all:null,querySelectorAll:selector=>selector==='[data-orders-queue-dispatch]'?[queueDispatch]:[]};
context.bindOps(opsRoot);all.click();assert.deepEqual(calls.assignment,{driver:null,order:undefined},'bulk assignment reuses the guarded assignment workflow');queueDispatch.click();assert.deepEqual(calls.assignment,{driver:null,order:'waiting-synthetic'},'a waiting order reuses the existing assignment workflow');assert.equal(calls.open,undefined,'central panel does not duplicate the card open action');refresh.click();assert.equal(calls.queueRefresh.force,true,'refresh explicitly rechecks the operational server queue');
context.bind(root);select.click();assert.equal(selected['is-selected'],true,'selection highlights the same card');assert.equal(selected['aria-pressed'],'true','selection state remains accessible');assert.equal(calls.panel,1,'selection updates the operational panel');open.click();assert.equal(calls.open,'synthetic-2');print.click();assert.equal(calls.print,'synthetic-2');qr.click();assert.equal(calls.qr,'synthetic-2');
const ordersPage=source.match(/function orders\(\)\{[\s\S]*?\n\}/u)?.[0];
assert(ordersPage);assert.doesNotMatch(ordersPage,/ordersV2Selection|ordersV2DetailPanel|orders-v2-side-filters/u,'page has no persistent duplicate or duplicate filter panel');
assert.match(ordersPage,/Central operacional/u,'operational work area is present beside the list');
assert.doesNotMatch(ordersPage,/ordersV2Metrics\(all\)/u,'repeated quick-filter metrics are removed from the side panel');
assert.match(source,/ordersV2EligibleQueue\(restaurantQueueRecords\)/u,'eligible courier list uses confirmed server queue records and lease validity');
assert.match(source,/openAssignment\(button\.dataset\.ordersAssignDriver,selected\.id\)/u,'quick dispatch delegates to the existing assignment workflow');
console.log('Orders V2 compact cards, operational panel and guarded dispatch actions: PASS');
