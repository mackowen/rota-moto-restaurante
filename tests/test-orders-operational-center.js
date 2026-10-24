'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const panelSource=source.match(/function ordersV2OperationalContent\(\)\{[\s\S]*?\n\}/u)?.[0];
const bindSource=source.match(/function bindOrdersOperationalActions\(root=document\)\{[^\n]*\}/u)?.[0];
assert(panelSource&&bindSource,'production operations panel and action binding are available');

const future=new Date(Date.now()+60000).toISOString();
const order={id:'synthetic-order-1',num:'S-1',status:'AGUARDANDO',dispatchable:true};
const execution={delivery:{status:'ASSIGNED',driverId:'synthetic-driver-1'},facts:[{type:'DELIVERY_ACCEPTED',occurredAt:'2026-10-24T10:00:00Z'}],operation:{status:'synced'}};
const context={
  ordersWithCanonicalDeliveryStatus:()=>[order],ordersV2CanDispatch:row=>row.dispatchable,
  deliveryHistoryForOrder:()=>execution,ordersSelectedId:order.id,
  restaurantQueueStatus:'confirmed',restaurantQueueUpdatedAt:Date.now(),
  ordersV2QueueFresh:()=>context.restaurantQueueStatus==='confirmed'&&Date.now()-context.restaurantQueueUpdatedAt<30000,
  ordersV2EligibleQueue:records=>records.filter(row=>row.eligible===true&&Date.parse(row.leaseExpiresAt||'')>Date.now()),
  restaurantQueueRecords:[{driverId:'synthetic-driver-1',name:'Motoboy sintético',eligible:true,leaseExpiresAt:future}],
  state:{bikes:[{id:'synthetic-driver-1',name:'Motoboy sintético'}],orders:[order]},
  orderPlanningStatus:()=> 'ASSIGNED',can:()=>true,canAssignOwnDelivery:()=>true,
  RotaMotoContract:{canTransition:()=>true},statusLabel:value=>String(value),
  syncOperationLabel:value=>String(value),dateFmt:()=> '24/10/2026 10:00',
  esc:value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
  openAssignment:(driverId,orderId)=>{context.assignment={driverId,orderId}},
  openDetail:id=>{context.open=id},refreshRestaurantQueue:options=>{context.refresh=options}
};
vm.runInNewContext(panelSource+'\n'+bindSource+'\nthis.panel=ordersV2OperationalContent;this.bind=bindOrdersOperationalActions;',context);
let html=context.panel();
assert.match(html,/Pedidos aguardando atribuição/u);
assert.match(html,/>1</u,'assignment count is derived from current eligible orders');
assert.match(html,/Motoboy sintético/u,'only current server-eligible queue members are shown');
assert.match(html,/Selecionar pedidos para distribuir/u,'bulk action explicitly opens the eligible selection flow');
assert.match(html,/Preparar distribuição do selecionado/u,'selected action clearly refers to the current pedido');
assert.match(html,/Abre a mesma distribuição com este pedido já marcado/u,'the selected action explains its preselection and confirmation behavior');
assert.match(html,/Corrida aceita/u,'the selected delivery shows its received execution event');
assert.doesNotMatch(html,/Gerenciamento completo|data-orders-manage/u,'central does not repeat the card open action');
assert.match(html,/data-orders-assign-driver="synthetic-driver-1"/u,'eligible driver action is scoped to the selected dispatchable order');
assert.match(html,/Usar este motoboy/u,'driver action label explains the preselection context');
assert.match(html,/este pedido e este motoboy marcados; confirme para atribuir/u,'driver action states that assignment still requires confirmation');

context.restaurantQueueStatus='error';
context.restaurantQueueRecords=[{driverId:'synthetic-driver-1',name:'Motoboy sintético',eligible:true,leaseExpiresAt:future}];
html=context.panel();
assert.match(html,/Nenhum motoboy é apresentado como disponível/u,'failed queue read is explicit');
assert.doesNotMatch(html,/data-orders-assign-driver=/u,'stale eligible rows cannot be used for quick assignment');
assert.match(html,/>—</u,'unknown availability is not converted to zero');

const button=(dataset={})=>({dataset,handler:null,addEventListener(_name,handler){this.handler=handler},click(){this.handler({currentTarget:this})}});
const assign=button({ordersDispatchSelected:''}),root={
  querySelector(selector){return selector==='[data-orders-dispatch-all]'?button():selector==='[data-orders-dispatch-selected]'?assign:null},
  querySelectorAll(){return []}
};
context.document={querySelector:()=>null};context.bind(root);assign.click();
assert.equal(context.assignment.orderId,order.id,'dispatch button delegates to the existing confirmation workflow');
assert.equal(context.open,undefined,'central panel does not bind a duplicate open action');
console.log('Orders operational center: live eligibility, event facts, unavailable state and guarded actions PASS');
