'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const cardSource=source.match(/function ordersV2CardList\(rows\)\{[^\n]*\}/u)?.[0];
const bindSource=source.match(/function bindOrdersV2Actions\(root=document\)\{[^\n]*\}/u)?.[0];
assert(cardSource&&bindSource,'production card renderer and action binder are independently testable');
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
  state:{pagination:{orders:1}},filterOrders:()=>{calls.filter=true}
};
vm.runInNewContext(cardSource+"\n"+bindSource+"\nthis.render=ordersV2CardList;this.bind=bindOrdersV2Actions;",context);
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
assert.match(html,/Rua Exemplo 1, Centro/u);assert.match(html,/Motoboy Dois/u);assert.match(html,/R\$ 18\.50/u);
assert.doesNotMatch(html,/orders-v2-table|ordersV2Selection/u,'no duplicate table or persistent detail panel is emitted');
assert.match(context.render([]),/Nenhum pedido encontrado/u,'empty list remains informative');
let selected;
selected={dataset:{orderId:'synthetic-1'},classList:{toggle(name,value){selected[name]=value}},querySelector(){return{setAttribute(name,value){selected[name]=value}}}};
const select={dataset:{ordersSelect:'synthetic-1'},onclick:null,click(){this.onclick()}};
const open={dataset:{ordersOpen:'synthetic-2'},onclick:null,click(){this.onclick()}};
const print={dataset:{ordersPrint:'synthetic-2'},onclick:null,click(){this.onclick()}};
const qr={dataset:{ordersQr:'synthetic-2'},onclick:null,click(){this.onclick()}};
const root={querySelectorAll(selector){return selector==='[data-orders-select]'?[select]:selector==='[data-orders-open]'?[open]:selector==='[data-orders-print]'?[print]:selector==='[data-orders-qr]'?[qr]:selector==='[data-orders-metric]'?[]:selector==='.orders-v2-card'?[selected]:[]}};
context.bind(root);select.click();assert.equal(selected['is-selected'],true,'selection highlights the same card');assert.equal(selected['aria-pressed'],'true','selection state remains accessible');open.click();assert.equal(calls.open,'synthetic-2');print.click();assert.equal(calls.print,'synthetic-2');qr.click();assert.equal(calls.qr,'synthetic-2');
const ordersPage=source.match(/function orders\(\)\{[\s\S]*?\n\}/u)?.[0];
assert(ordersPage);assert.doesNotMatch(ordersPage,/ordersV2Selection|ordersV2DetailPanel|orders-v2-side-filters/u,'page has no persistent duplicate or duplicate filter panel');
assert.match(ordersPage,/orders-v2-metrics/u,'operational summary metrics remain available');
console.log('Orders V2 single-card rendering, responsive data contract and actions: PASS');
