'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('app.js','utf8');
const statusBlock=source.match(/let ordersQuickFilter='all';[\s\S]*?function orderQuickFilterMarkup\(\)\{[^\n]*\}/u)?.[0];
const actionsBlock=source.match(/function bindOrderRowActions\(root\)\{[^\n]*\}/u)?.[0];
const filterBlock=source.match(/function filterOrders\(\)\{[^\n]*\}/u)?.[0];
assert(statusBlock&&actionsBlock&&filterBlock,'orders filtering and row action functions remain separately testable');

const orders=[
  {id:'wait',num:'1',status:'AGUARDANDO'},
  {id:'assigned',num:'2',status:'ASSIGNED'},
  {id:'route',num:'3',status:'OUT_FOR_DELIVERY'},
  {id:'done',num:'4',status:'DELIVERED'},
  {id:'cancelled',num:'5',status:'CANCELLED'}
];
const buttons=['detail','print','qr'].map((kind)=>({
  dataset:kind==='detail'?{detail:'assigned'}:kind==='print'?{printOrder:'assigned'}:{qrOpen:'assigned'},
  onclick:null,click(){this.onclick?.()}
}));
const table={innerHTML:'',querySelectorAll(selector){return selector==='[data-detail]'?[buttons[0]]:selector==='[data-print-order]'?[buttons[1]]:selector==='[data-qr-open]'?[buttons[2]]:[]}};
const controls={q:{value:''},fs:{value:''},fb:{value:''},ft:{value:''},ordersTable:table};
const quickButtons=['all','waiting','assigned','route','completed','cancelled'].map(key=>({dataset:{ordersQuickFilter:key},classList:{toggle(){}},setAttribute(){}}));
const captured={};
const context={
  ordersQuickFilter:'all',
  ORDER_QUICK_STATUS:null,
  ordersWithCanonicalDeliveryStatus:()=>orders,
  document:{getElementById:id=>controls[id]||null,querySelectorAll:selector=>selector==='[data-orders-quick-filter]'?quickButtons:[]},
  tablePage(rows,key){captured.rows=rows;captured.key=key;return rows.map(row=>row.id).join(',')},
  bindPagination(){},renderOrderQRCodes(){},
  openDetail:id=>captured.open=id,openPrintPreview:id=>captured.print=id,openQrPreview:id=>captured.qr=id,
  state:{pagination:{orders:1}},String,Number,Set,Math
};
vm.runInNewContext(`${statusBlock}\n${actionsBlock}\n${filterBlock}\nthis.quickStatuses=ORDER_QUICK_STATUS;this.filter=filterOrders;this.setFilter=key=>ordersQuickFilter=key;this.bindRows=bindOrderRowActions;`,context);
for(const [key,expected] of Object.entries({waiting:['wait'],assigned:['assigned'],route:['route'],completed:['done'],cancelled:['cancelled'],all:['wait','assigned','route','done','cancelled']})){
  context.setFilter(key);context.filter();
  assert.deepEqual(Array.from(captured.rows,row=>row.id),expected,`${key} quick filter uses the intended status group`);
}
controls.q.value='2';controls.fs.value='';context.setFilter('all');context.filter();
assert.deepEqual(Array.from(captured.rows,row=>row.id),['assigned'],'text search composes with status selection');
context.bindRows(table);buttons.forEach(button=>button.click());
assert.deepEqual(captured,{rows:[orders[1]],key:'orders',open:'assigned',print:'assigned',qr:'assigned'},'rebuilt results preserve open, print and QR actions');
console.log('Orders quick filters, composable search and rebuilt row actions: PASS');
