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
assert.match(zero.html,/Sem pedidos neste período/u);
assert.match(zero.html,/Faturamento bruto registrado/u);
assert.match(zero.html,/Registros financeiros ainda não consultados/u);
assert.doesNotMatch(zero.html,/Faturamento bruto registrado[\s\S]*R\$ 0,00/u,'financial data absence never becomes revenue zero');
assert.match(zero.html,/report-unavailable--compact[\s\S]*Entenda a limitação/u,'financial limitation stays compact with explanation on demand');
assert.match(zero.html,/Canceladas e falhas[\s\S]*Canceladas[\s\S]*Com falha/u,'the operational overview retains both state counts in a balanced tile');
assert.match(zero.html,/Ver explicação de/u,'long metric notes remain available through disclosure controls');
assert.equal((zero.html.match(/data-report-operational-panel=/gu)||[]).length,8,'all detailed sections remain available');
assert.match(zero.html,/<header class="report-v2-heading"><div class="report-v2-heading-toolbar">/u,'report subnavigation and sync state share a compact toolbar');
assert.doesNotMatch(zero.html,/<h1>Relatórios<\/h1>/u,'report body does not duplicate the application page heading');
assert.match(zero.html,/<details id="report-advanced-filters" class="report-advanced-filters"\s*>/u,'advanced filters start collapsed in either main area unless the user opened them');
for(const match of zero.html.matchAll(/aria-labelledby="([^"]+)"/gu))for(const id of match[1].split(/\s+/u))assert(zero.html.includes(`id="${id}"`),`accessible report label ${id} refers to an existing heading or tab`);
const expanded=renderFor(0,{mainView:'operational',advancedFiltersOpen:true}).html;
assert.match(expanded,/<details id="report-advanced-filters" class="report-advanced-filters" open>/u,'advanced filter expansion persists across report renders');
const app=fs.readFileSync(require.resolve('../app.js'),'utf8');
const reportStart=app.indexOf('function reports(){');
const reportEnd=app.indexOf('function activateReportMainView(',reportStart);
assert(reportStart>=0&&reportEnd>reportStart,'the reports screen factory remains available');
assert.match(app.slice(reportStart,reportEnd),/return header\('Relatórios','Análises executivas e operacionais'\)/u,'reports uses the shared page-header component with a real title');
assert.match(app.slice(reportStart,reportEnd),/RotaMotoAnalytics\.aggregate\(\{orders:state\.orders,deliveries:state\.deliveries,deliveryEvents:state\.deliveryEvents,earnings:state\.earnings,bikes:state\.bikes,financialEvents:financeLedgerStatus==='confirmed'&&canReadFinancialEvents&&sameFinanceContext\(financeLedgerOwner\)\?tenantFinancialEvents:undefined/u,'reports aggregates the local IndexedDB projection and includes only tenant-scoped server-confirmed ledger events');
assert.match(app.slice(reportStart,reportEnd),/reportFreshness\(sync,\{online:navigator\.onLine!==false,sessionActive:!!syncSession,[\s\S]*companyId:syncSession\?\.companyId/u,'report freshness is bound to the active tenant and live session');
assert.match(app,/transport:'unverified'/u,'startup does not preserve a stale connected state as current confirmation');
assert.match(app,/transport:'connected',lastSuccessAt:confirmedAt,[\s\S]*lastServerConfirmedAt:confirmedAt,serverConfirmedCompanyId:session\.companyId/u,'only a completed server sync cycle records a tenant-bound confirmation');
assert.match(app,/advanced\?\.addEventListener\('toggle',\(\)=>\{state\.report\.advancedFiltersOpen=advanced\.open\}\)/u,'filter expansion state survives tab switching and filter rerender');
const filters=zero.html.slice(zero.html.indexOf('<section class="report-filters-card report-filters-card--shared"'),zero.html.indexOf('</section>',zero.html.indexOf('<section class="report-filters-card report-filters-card--shared"'))+10);
assert.match(filters,/report-period-control[\s\S]*report-driver-control[\s\S]*report-advanced-filters[\s\S]*report-advanced-grid/u,'primary and advanced filters remain inside one panel');
const freshnessOptions={sessionActive:true,online:true,canSync:true,companyId:'tenant-a',formatDate:value=>`DATA-${value}`};
const unverified=View.reportFreshness({state:'ready',transport:'unverified'},freshnessOptions);
assert.equal(unverified.label,'Não verificado');
assert.match(unverified.note,/dados salvos neste aparelho/u);
const confirmed=View.reportFreshness({state:'ready',transport:'connected',lastServerConfirmedAt:123,serverConfirmedCompanyId:'tenant-a',pending:0,conflicts:0,rejected:0},freshnessOptions);
assert.equal(confirmed.label,'Confirmado');
assert.match(confirmed.note,/servidor em DATA-123/u);
assert.match(confirmed.note,/dados salvos neste aparelho/u,'a server-confirmed sync still identifies IndexedDB as the report source');
const partial=View.reportFreshness({state:'ready',transport:'connected',lastServerConfirmedAt:123,serverConfirmedCompanyId:'tenant-a',pending:2,conflicts:1,rejected:0},freshnessOptions);
assert.equal(partial.label,'Atenção');
assert.match(partial.note,/2 alterações pendentes; 1 conflito/u);
assert.equal(View.reportFreshness({state:'offline',transport:'offline',lastServerConfirmedAt:123},{...freshnessOptions,online:false}).label,'Offline');
assert.equal(View.reportFreshness({state:'unauthenticated',transport:'unauthenticated'},{...freshnessOptions,sessionActive:false}).label,'Sessão encerrada');
assert.equal(View.reportFreshness({state:'error',transport:'unavailable',lastServerConfirmedAt:123},freshnessOptions).label,'Servidor indisponível');
const otherTenant=View.reportFreshness({state:'ready',transport:'connected',lastServerConfirmedAt:123,serverConfirmedCompanyId:'tenant-b'},freshnessOptions);
assert.equal(otherTenant.label,'Não verificado','a prior tenant confirmation cannot be reused for the active company');
assert.match(otherTenant.note,/não comprova a empresa ativa/u);
const confirmedHtml=View.render({report:Analytics.aggregate({orders:[],deliveries:[]},{now,period:'all',timeZone:'America/Sao_Paulo'}),filters:{mainView:'executive',executiveCategory:'overview'},statusLabel:labelStatus,typeLabel:()=> 'Entrega',sources:{},bikes:[],types:[],freshNote:confirmed.note,freshnessLabel:confirmed.label});
assert.match(confirmedHtml,/class="report-sync-indicator" role="status" aria-label="Sincronização confirmada pelo servidor/u,'the compact badge remains accessible and carries the honest source explanation');
assert.match(confirmedHtml,/report-sync-indicator[\s\S]*>Confirmado<\/div>/u);
console.log('Analytics renderer point-count, axis accessibility, empty and unavailable states: PASS');

// Unavailable, loading, failed and successfully empty consultations must differ.
const renderFinancialState=(financialState,confirmed=false,financialDiagnostic,filters={})=>View.render({report:Analytics.aggregate({orders:[],deliveries:[],...(confirmed?{financialEvents:[]}: {})},{now,period:'all',timeZone:'America/Sao_Paulo'}),filters:{mainView:'executive',executiveCategory:'finance',...filters},statusLabel:labelStatus,typeLabel:()=> 'Entrega',sources:{},bikes:[],types:[],freshNote:'Dados locais',financialState,financialDiagnostic});
for(const [state,title] of [['loading','Carregando os registros financeiros'],['offline','Sem conexão para consultar pagamentos'],['NETWORK_ERROR','Falha de conexão com o servidor'],['permission-unavailable','Seu perfil não permite consultar pagamentos'],['session-required','Entre novamente para consultar pagamentos'],['FORBIDDEN','Consulta financeira não autorizada pelo servidor'],['MFA_REQUIRED','Confirme a segurança da sua conta'],['FINANCE_READ_FAILED','Não foi possível consultar os registros financeiros']]){
 const html=renderFinancialState(state);
 assert(html.includes(title),`financial state ${state} has a clear user-facing explanation`);
 if(state!=='loading')assert.match(html,/role="alert"/u,'a failed consultation is an alert, not an empty dataset');
 assert.doesNotMatch(html,/Nenhum lançamento financeiro neste período/u,'unread data cannot be described as an empty ledger');
}
const confirmedEmpty=renderFinancialState('confirmed',true);
assert.match(confirmedEmpty,/Nenhum lançamento financeiro neste período/u);
assert.doesNotMatch(confirmedEmpty,/Não foi possível consultar os registros financeiros/u);
const financeDiagnosticHtml=renderFinancialState('FORBIDDEN',false,{stage:'http',httpStatus:403,errorCode:'FORBIDDEN'});
assert.match(financeDiagnosticHtml,/data-finance-stage="http" data-finance-http-status="403" data-finance-error-code="FORBIDDEN"/u,'sanitized HTTP diagnostics identify a real server denial');
const executiveFinance=financeDiagnosticHtml.slice(financeDiagnosticHtml.indexOf('data-report-executive-panel="finance"'),financeDiagnosticHtml.indexOf('data-report-executive-panel="drivers"'));
assert.equal((executiveFinance.match(/Consulta financeira não autorizada pelo servidor/gu)||[]).length,1,
  'executive financial panel presents one denial notice without repeating its title and explanation below');
const operationalFinance=renderFinancialState('permission-unavailable',false,null,{mainView:'operational',operationalSection:'report-costs'});
const costsPanel=operationalFinance.slice(operationalFinance.indexOf('data-report-operational-panel="report-costs"'),operationalFinance.indexOf('data-report-operational-panel="report-intelligence"'));
assert.equal((costsPanel.match(/Seu perfil não permite consultar pagamentos/gu)||[]).length,1,
  'detailed costs panel presents one permission notice instead of duplicating it in a status metric');
const day=renderFor(1).html;
const hourlyStart=day.indexOf('aria-label="Pedidos por hora"');
assert(hourlyStart>=0);
const hourlyDetails=day.slice(hourlyStart,day.indexOf('</section>',hourlyStart));
assert.match(hourlyDetails,/23:00/u,'expanded hourly distribution includes the second half of the day');
assert.equal((hourlyDetails.match(/class="analytics-bar-row"/gu)||[]).length,24,'all 24 hourly rows are available in the detailed distribution');
assert.match(day,/report-chart-axis-measure/u,'axis reserves space for real formatted labels outside the plotted SVG');
console.log('Report financial read states and complete hourly distribution: PASS');

(async()=>{
 const vm=require('node:vm');
 const source=app.slice(app.indexOf('let financeLedgerFetchedAt='),app.indexOf('function reports(){'));
 let calls=0,renders=0,fail=true,malformed=false,networkFail=false,errorCode='FORBIDDEN';
 const context={state:{tab:'reports'},syncSession:{userId:'test-user',companyId:'test-company',permissions:['finance.read']},navigator:{onLine:true},window:{},Date,setTimeout,
  syncUrl:()=>'/api/finance/events',req:async()=>{},fetch:async()=>{calls++;if(networkFail)throw new TypeError('Failed to fetch');return{ok:!fail,status:fail?403:200,json:async()=>malformed?{}:fail?{error:{code:errorCode}}:{events:[],coverage:{complete:false}}}},
  render(){renders++;vm.runInContext('queueFinanceLedgerRead()',context)}};
 vm.createContext(context);
 vm.runInContext(source+';globalThis.probe={refresh:refreshFinanceLedger,status:()=>financeLedgerStatus,diagnostic:()=>financeLedgerDiagnostic,owner:()=>financeLedgerOwner};',context);
 const pending=context.probe.refresh();
 assert.equal(context.probe.status(),'loading','a real pending request is visibly loading');
 assert.equal(await pending,false);
 assert.equal(context.probe.status(),'FORBIDDEN');
 assert.deepEqual(JSON.parse(JSON.stringify(context.probe.diagnostic())),{stage:'http',httpStatus:403,errorCode:'FORBIDDEN'},'a server denial preserves the exact safe HTTP diagnostic');
 assert.equal(renders,1,'a failed financial query updates the visible report');
 assert.equal(calls,1,'rendering the failure must not start an automatic request loop');
 fail=false;
 assert.equal(await context.probe.refresh({force:true}),true,'a subsequent explicit read can recover');
 assert.equal(context.probe.status(),'confirmed');
 assert.equal(context.probe.owner().companyId,'test-company','confirmed ledger is bound to the authenticated tenant');
 assert.equal(calls,2,'a successful render reuses the confirmed read');
 context.navigator.onLine=false;
 assert.equal(await context.probe.refresh(),false);
 assert.equal(context.probe.status(),'offline');
 assert.equal(calls,2,'offline consultation never makes a request');
 context.navigator.onLine=true;networkFail=true;
 assert.equal(await context.probe.refresh({force:true}),false);
 assert.equal(context.probe.status(),'NETWORK_ERROR','a fetch failure has its own user-facing state');
 assert.equal(context.probe.diagnostic().stage,'connection');
 networkFail=false;malformed=true;
 assert.equal(await context.probe.refresh({force:true}),false);
 assert.equal(context.probe.status(),'FINANCE_RESPONSE_INVALID','an invalid successful response cannot become an empty financial history');
 errorCode='MFA_REQUIRED';fail=true;malformed=false;
 assert.equal(await context.probe.refresh({force:true}),false);
 assert.equal(context.probe.status(),'MFA_REQUIRED','server MFA requirements remain distinct from permission denials');
 assert.equal(context.probe.diagnostic().errorCode,'MFA_REQUIRED');
 context.syncSession={userId:'test-user',companyId:'test-company',permissions:[]};
 const callsBeforePermissionGate=calls;
 assert.equal(await context.probe.refresh({force:true}),false);
 assert.equal(context.probe.status(),'permission-unavailable');
 assert.equal(calls,callsBeforePermissionGate,'a client-known missing permission makes no HTTP request');

 let releaseOldResponse;
 const raceContext={...context,state:{tab:'reports'},syncSession:{userId:'user-a',companyId:'tenant-a',permissions:['finance.read']},navigator:{onLine:true},
   fetch:()=>new Promise(resolve=>{releaseOldResponse=resolve}),render(){}};
 vm.createContext(raceContext);
 vm.runInContext(source+';globalThis.probe={refresh:refreshFinanceLedger,status:()=>financeLedgerStatus,owner:()=>financeLedgerOwner};',raceContext);
 const staleRead=raceContext.probe.refresh();
 await Promise.resolve();
 raceContext.syncSession={userId:'user-b',companyId:'tenant-b',permissions:['finance.read']};
 releaseOldResponse({ok:true,status:200,json:async()=>({events:[{event_id:'tenant-a-event'}],coverage:{}})});
 assert.equal(await staleRead,false,'a response begun under the previous user/tenant is ignored');
 assert.equal(raceContext.probe.owner(),null,'a stale response cannot confirm ownership for the newly active tenant');
 assert.equal(raceContext.state.financialEvents,undefined,'a stale tenant ledger cannot be displayed');
 console.log('Financial consultation loading, visible failure, retry, offline and invalid-response lifecycle: PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
