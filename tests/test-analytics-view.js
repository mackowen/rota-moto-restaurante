'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const Analytics=require('../analytics');
const View=require('../analytics-view');

const now=Date.parse('2026-10-26T12:00:00Z');
const labelStatus=status=>({DELIVERED:'Concluída',CANCELLED:'Cancelada',FAILED:'Com falha',OUT_FOR_DELIVERY:'Em andamento'})[status]||'Outro';
const renderFor=(count,extraFilters={})=>{
  const statuses=['DELIVERED','CANCELLED','FAILED','OUT_FOR_DELIVERY'];
  const orders=Array.from({length:count},(_,index)=>({id:`order-${index}`,deliveryId:`delivery-${index}`,createdAt:Date.parse(`2026-10-${String(index+1).padStart(2,'0')}T12:00:00Z`),status:statuses[index%statuses.length],amountMinor:1200,currency:'BRL',value:12,sourceId:'manual'}));
  const deliveries=orders.map((order,index)=>({id:`delivery-${index}`,orderId:order.id,status:statuses[index%statuses.length]}));
  const report=Analytics.aggregate({orders,deliveries},{now,period:'all',timeZone:'America/Sao_Paulo'});
  return {report,html:View.render({report,filters:{mainView:'executive',executiveCategory:'overview',fromDate:'2026-10-01',toDate:'2026-10-26',...extraFilters},statusLabel:labelStatus,typeLabel:()=> 'Entrega',sources:{manual:'Manual'},bikes:[],types:['NORMAL'],freshNote:'Dados locais'})};
};
const chartMarkup=html=>{
  const start=html.indexOf('<svg class="report-chart"');
  assert.notEqual(start,-1,'daily chart SVG exists when a point is available');
  const end=html.indexOf('</svg>',start)+6;
  return html.slice(start,end);
};
for(const count of [1,5,20]){
  const {report,html}=renderFor(count);
  assert.equal(report.deliveryTotal,count);
  const chart=chartMarkup(html);
  assert.equal((chart.match(/<rect\b/gu)||[]).length,count,'every actual daily point is plotted without truncation or generated values');
  assert.match(chart,/tabindex="0" role="img" aria-label="2026-10-01: 1"/u,'sampled bars have an accessible keyboard tooltip');
  assert.match(html,/report-chart-yaxis[\s\S]*report-chart-xaxis/u,'axis labels render as normal HTML text, outside the scaled SVG');
  assert.match(html,/01\/10/u,'civil dates use DD/MM labels');
}
const zero=renderFor(0);
assert.equal(zero.report.deliveryTotal,0);
assert.doesNotMatch(zero.html,/<svg class="report-chart"/u,'zero deliveries show an empty state instead of zero-value bars');
assert.match(zero.html,/Sem dados neste período/u);
assert.match(zero.html,/Fonte financeira indisponível/u);
assert.doesNotMatch(zero.html,/Faturamento por dia[\s\S]*R\$ 0,00/u,'financial data absence never becomes revenue zero');
assert.match(zero.html,/report-unavailable--compact[\s\S]*Entenda a limitação/u,'financial limitation stays compact with explanation on demand');
assert.match(zero.html,/Canceladas e falhas[\s\S]*Canceladas[\s\S]*Com falha/u,'the operational overview retains both state counts in a balanced tile');
assert.match(zero.html,/Ver explicação de/u,'long metric notes remain available through disclosure controls');
assert.equal((zero.html.match(/data-report-operational-panel=/gu)||[]).length,8,'all detailed sections remain available');
assert.match(zero.html,/<header class="report-v2-heading"><div class="report-v2-heading-toolbar">/u,'report subnavigation and sync state share a compact toolbar');
assert.doesNotMatch(zero.html,/<h1>Relatórios<\/h1>/u,'report body does not duplicate the application page heading');
assert.match(zero.html,/<details id="report-advanced-filters" class="report-advanced-filters"\s*>/u,'advanced filters start collapsed in either main area unless the user opened them');
const expanded=renderFor(0,{mainView:'operational',advancedFiltersOpen:true}).html;
assert.match(expanded,/<details id="report-advanced-filters" class="report-advanced-filters" open>/u,'advanced filter expansion persists across report renders');
const app=fs.readFileSync(require.resolve('../app.js'),'utf8');
const reportStart=app.indexOf('function reports(){');
const reportEnd=app.indexOf('function activateReportMainView(',reportStart);
assert(reportStart>=0&&reportEnd>reportStart,'the reports screen factory remains available');
assert.match(app.slice(reportStart,reportEnd),/return header\('Relatórios','Análises executivas e operacionais'\)/u,'reports uses the shared page-header component with a real title');
assert.match(app,/advanced\?\.addEventListener\('toggle',\(\)=>\{state\.report\.advancedFiltersOpen=advanced\.open\}\)/u,'filter expansion state survives tab switching and filter rerender');
const filters=zero.html.slice(zero.html.indexOf('<section class="report-filters-card report-filters-card--shared"'),zero.html.indexOf('</section>',zero.html.indexOf('<section class="report-filters-card report-filters-card--shared"'))+10);
assert.match(filters,/report-period-control[\s\S]*report-driver-control[\s\S]*report-advanced-filters[\s\S]*report-advanced-grid/u,'primary and advanced filters remain inside one panel');
console.log('Analytics renderer point-count, axis accessibility, empty and unavailable states: PASS');
