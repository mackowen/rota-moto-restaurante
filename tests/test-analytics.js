'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Analytics = require('../analytics');
const View = require('../analytics-view');
const OrderMoney = require('../order-money');

const now = Date.parse('2026-10-06T12:00:00Z');
const orders = [
  { id: 'o-done', deliveryId: 'd-done', createdAt: Date.parse('2026-10-06T01:00:00Z'), status: 'FINALIZADA', type: 'NORMAL', value: 12, deliveryFee: 12, deliveryFeeCurrency: 'BRL', km: 4, amountMinor: 12500, currency: 'BRL', money: { currency: 'BRL', completeness: 'complete', provenance: { kind: 'import', sourceId: 'ifood' }, components: { itemsSubtotalMinor: 12500, discountMinor: 0, deliveryFeeMinor: 1200, serviceFeeMinor: 0, otherFeeMinor: 0, totalMinor: 13700 } }, sourceId: 'ifood', bikeId: 'driver-1', bike: 'Ana', customer: 'Cliente QA', phone: '11999990000', address: 'Rua QA, 123' },
  { id: 'o-cancel', deliveryId: 'd-cancel', createdAt: Date.parse('2026-10-05T23:50:00Z'), status: 'CANCELADA', type: 'NORMAL', amountMinor: null, currency: 'BRL', sourceId: 'manual', bike: 'Ana', customer: ' cliente   qa ', address: 'RUA  QA, 123' },
  { id: 'o-failed', deliveryId: 'd-failed', createdAt: Date.parse('2026-10-05T18:00:00Z'), status: 'FAILED', type: 'RETORNO', sourceId: 'keeta', driverId: 'driver-2' },
  { id: 'o-estimate', deliveryId: 'd-estimate', createdAt: Date.parse('2026-10-04T10:00:00Z'), status: 'EM ROTA', type: 'NORMAL', km: 2.5, sourceId: 'ifood' },
  { id: 'o-invalid-date', createdAt: 'not-a-date', status: 'FINALIZADA', value: 99 },
];
const deliveries = [
  { id: 'd-done', orderId: 'o-done', driverId: 'driver-1', status: 'DELIVERED', assignedAt: now - 90 * 60000, acceptedAt: now - 80 * 60000, pickedUpAt: now - 60 * 60000, arrivedAt: now - 15 * 60000, completedAt: now, estimatedDistanceM: 5000, actualDistanceM: 6200 },
  { id: 'd-cancel', orderId: 'o-cancel', status: 'CANCELLED' },
  { id: 'd-failed', orderId: 'o-failed', status: 'FAILED' },
  { id: 'd-estimate', orderId: 'o-estimate', status: 'OUT_FOR_DELIVERY', estimatedDistanceM: null, actualDistanceM: null },
];
const earnings = [
  { id: 'e1', deliveryId: 'd-done', amountMinor: 900, currency: 'BRL' },
  { id: 'e2', deliveryId: 'd-done', amountMinor: 300, currency: 'BRL' },
  { id: 'e-usd', deliveryId: 'd-estimate', amountMinor: 1000, currency: 'USD' },
  { id: 'e-invalid', deliveryId: 'd-failed', amountMinor: 4.2, currency: 'BRL' },
];

for (const [key, item] of Object.entries(Analytics.DATA_DICTIONARY)) {
  for (const required of ['name', 'source', 'formula', 'unit', 'states', 'period', 'missing', 'limits']) assert.ok(item[required], `${key}.${required} documented`);
}

const report = Analytics.aggregate({ orders, deliveries, earnings, bikes: [{ id: 'driver-2', name: 'Bia' }] }, { now, period: '30' });
assert.equal(report.total, 4);
assert.equal(report.deliveryTotal, 4);
assert.equal(report.invalidCreatedAt, 1);
assert.equal(report.completedCount, 1);
assert.equal(report.cancelledCount, 1);
assert.equal(report.failedCount, 1);
assert.equal(report.openCount, 1);
assert.deepEqual(report.deliveryFees, { total: 12, average: 12, count: 1 });
assert.equal(report.coverage.deliveryFee.missing, 0);
assert.equal(report.orderTicket.BRL.total, 137);
assert.equal(report.orderTicket.BRL.average, 137);
assert.equal(report.moneyComponents['itemsSubtotalMinor:BRL'].total, 125);
assert.equal(report.moneyComponents['deliveryFeeMinor:BRL'].total, 12);
assert.equal(report.coverage.orderAmount.complete, 1);
assert.equal(report.coverage.orderAmount.available, 1);
assert.deepEqual(report.financial.totals.BRL,{grossMinor:13700,discountMinor:0,orderTotalMinor:13700,count:1});
assert.deepEqual(report.financial.coverage,{available:1,total:3,cancelled:1,missing:2});
assert.equal(report.financial.diagnostics.reasons['missing-money'], 2, 'legacy rows without Order.money are diagnosed separately from missing coverage');
const financialDiagnosis = Analytics.aggregate({ orders: [
  { id: 'partial-money', createdAt: now, status: 'NOVO', money: OrderMoney.fromDecimal(5, 'BRL', 'deliveryFeeMinor') },
  { id: 'legacy-money', createdAt: now, status: 'NOVO', amountMinor: 500, currency: 'BRL' },
] }, { now, period: '30' }).financial;
assert.deepEqual(financialDiagnosis.coverage, { available: 0, total: 2, cancelled: 0, missing: 2 });
assert.equal(financialDiagnosis.diagnostics.reasons.partial, 1);
assert.equal(financialDiagnosis.diagnostics.reasons['missing-money'], 1);
assert.equal(financialDiagnosis.diagnostics.missingFields['money.components.totalMinor'], 1);
assert.deepEqual(report.financial.dailyByCurrency.BRL,[{date:'2026-10-06',grossMinor:13700,discountMinor:0,orderTotalMinor:13700,count:1}]);
assert.equal(report.financial.received.available,false,'Order total is not a payment receipt');
assert.equal(report.financial.refunds.available,false,'order status does not prove refunds or adjustments');
assert.deepEqual(report.driverPayout, { total: 12, average: 12, count: 1 });
assert.equal(report.estimatedDistance.total, 7.5);
assert.equal(report.estimatedDistance.count, 2);
assert.equal(report.actualDistance.total, 6.2);
assert.equal(report.actualDistance.count, 1);
assert.equal(report.durations.assignedToAccepted.average, 10);
assert.equal(report.durations.acceptedToPickedUp.average, 20);
assert.equal(report.durations.pickedUpToArrived.average, 45);
assert.equal(report.durations.arrivedToCompleted.average, 15);
assert.equal(report.durations.assignedToCompleted.average, 90);
assert.equal(report.hourlyVolume, null);
assert.equal(report.weekdayVolume, null);
assert.equal(report.sourceCounts.ifood, 2);
assert.equal(report.driverCounts['driver-1'].completed, 1);
assert.equal(report.driverCounts['legacy-name:Ana'].total, 1);
assert.equal(report.driverCounts.unassigned.total, 1);
assert.equal(report.deliveryStatusCounts.DELIVERED, 1);
assert.equal(report.distinctCustomerCount, 1);
assert.equal(report.customerGroups[0].count, 2);
assert.equal(report.distinctAddressCount, 1);
assert.equal(report.addressGroups[0].count, 2);

const returnOrder = { id:'order-return',deliveryId:'delivery-original',createdAt:now,status:'CANCELADA',type:'NORMAL',sourceId:'ifood',bikeId:'driver-original',bike:'Entregador original',customer:'=HYPERLINK("https://example.invalid")',deliveryFee:9,deliveryFeeCurrency:'BRL',money:{currency:'BRL',completeness:'complete',provenance:{kind:'manual'},components:{itemsSubtotalMinor:1000,discountMinor:0,deliveryFeeMinor:900,serviceFeeMinor:0,otherFeeMinor:0,totalMinor:1900}} };
const returnDeliveries = [
  {id:'delivery-original',orderId:'order-return',driverId:'driver-original',status:'CANCELLED'},
  {id:'local-return-alias',canonicalId:'delivery-return',orderId:'order-return',driverId:'driver-return',status:'RETURNED',extensions:{x_rotamoto_delivery_type:'RETURN',x_rotamoto_return_of_delivery_id:'delivery-original'}},
  {id:'delivery-return',orderId:'order-return',driverId:'driver-return',status:'RETURNED',extensions:{x_rotamoto_delivery_type:'RETURN',x_rotamoto_return_of_delivery_id:'delivery-original'}},
];
const returnReport = Analytics.aggregate({orders:[returnOrder],deliveries:returnDeliveries,bikes:[{id:'driver-original',name:'Entregador original'},{id:'driver-return',name:'Entregador da devolução'}],earnings:[]},{now,period:'all'});
assert.equal(returnReport.total,1,'a return remains attached to the single canonical Order');
assert.equal(returnReport.deliveryTotal,2,'a distinct return Delivery is counted once even if duplicated in a local snapshot');
assert.equal(returnReport.deliveryStatusCounts.CANCELLED,1);
assert.equal(returnReport.deliveryStatusCounts.RETURNED,1);
assert.equal(returnReport.returnedCount,1);
assert.equal(returnReport.driverCounts['driver-return'].total,1,'the return is attributed to its operational Driver');
assert.equal(returnReport.coverage.deliveryFee.total,0,'a RETURN does not create a completed-order delivery fee');
assert.equal(returnReport.driverPayout.count,0,'a RETURN does not create an Earning');
const filteredReturn = Analytics.aggregate({orders:[returnOrder],deliveries:returnDeliveries,bikes:[{id:'driver-original',name:'Entregador original'},{id:'driver-return',name:'Entregador da devolução'}],earnings:[]},{now,period:'all',driver:'driver-return',status:'RETURNED',type:'NORMAL',source:'ifood',includeExportRows:true});
assert.equal(filteredReturn.total,1,'combined operation filters retain the associated Order once');
assert.equal(filteredReturn.deliveryTotal,2,'status/Driver filtering counts distinct operations');
assert.equal(filteredReturn.exportRows.length,1,'CSV projection does not duplicate the Order for a RETURN');
assert.equal(filteredReturn.exportRows[0].status,'RETURNED','the CSV reflects the operation status that matched the filter');
assert.match(Analytics.csvRow([filteredReturn.exportRows[0].customer]),/^"'=HYPERLINK/u,'formula-leading customer values remain neutralized in CSV');
assert.equal(filteredReturn.driverPayout.count,0,'combined filters do not infer payment for the RETURN');
assert.equal(filteredReturn.financial.coverage.cancelled,1,'a re-delivery and return do not duplicate or monetize a cancelled Order');
const returnHtml = View.render({ report:returnReport, filters:{period:'all',bike:'',status:'',type:'',source:''}, statusLabel:value=>({CANCELLED:'Cancelada',RETURNED:'Devolvida'})[value]||'Em andamento', typeLabel:()=>'Entrega', sources:{ifood:'iFood'}, bikes:[], types:['NORMAL'], freshNote:'fixture sintética' });
assert.match(returnHtml,/report-metric-label">Entregas<\/span><strong class="report-metric-value">2</u,'the dashboard counts distinct delivery operations');
assert.match(returnHtml,/Pedidos no período[\s\S]*>1</u,'the report retains one Order in the financial/commercial cohort');
assert.match(returnHtml,/data-status-filter="RETURNED"/u,'RETURN status is available to the status chart filter');
assert.match(returnHtml,/value="RETURNED"/u,'RETURN status is available in combined report filters');
assert.match(returnHtml,/Devoluções recebidas/u,'the RETURN state is presented in Portuguese');
assert.match(returnHtml,/<dt>Entregas<\/dt>/u,'driver performance labels the distinct operational unit');

const badMoney = Analytics.aggregate({ orders: [{ id: 'x', createdAt: now, status: 'FINALIZADA', sourceId: 'manual', value: 8, amountMinor: 1200, currency: 'BRL' }, { id: 'y', createdAt: now, status: 'FINALIZADA', deliveryFee: 'NaN', amountMinor: 200, currency: 'USD' }, { id: 'jpy', createdAt: now, status: 'CANCELADA', amountMinor: 500, currency: 'JPY' }, { id: 'kwd', createdAt: now, status: 'CANCELADA', amountMinor: 1234, currency: 'KWD' }, { id: 'bad-currency', createdAt: now, status: 'CANCELADA', amountMinor: 900, currency: 'ZZZ' }], deliveries: [{ id: 'x', orderId: 'x', status: 'DELIVERED' }, { id: 'y', orderId: 'y', status: 'DELIVERED' }, { id: 'jpy', orderId: 'jpy', status: 'CANCELLED' }, { id: 'kwd', orderId: 'kwd', status: 'CANCELLED' }, { id: 'bad-currency', orderId: 'bad-currency', status: 'CANCELLED' }] }, { now, period: 'all' });
assert.equal(badMoney.deliveryFees.total, 8); // Legacy value is a delivery fee, not product revenue.
assert.equal(badMoney.coverage.deliveryFee.available, 1);
assert.equal(badMoney.coverage.deliveryFee.missing, 1);
assert.deepEqual(Object.keys(badMoney.orderTicket), [], 'ambiguous legacy amountMinor is excluded from ticket analytics');
assert.equal(badMoney.coverage.orderAmount.available, 0);
assert.equal(badMoney.coverage.orderAmount.missing, 5);
assert.deepEqual({ ...badMoney.coverage.orderAmount.kinds }, { legacy_delivery_fee: 1, legacy_ambiguous_total: 4 });

const financialFixtureOrders = [
  { id:'fin-paid-looking',createdAt:Date.parse('2026-10-06T02:30:00Z'),status:'FINALIZADA',payments:[{status:'PAID',amountMinor:9500}],money:{currency:'BRL',completeness:'complete',provenance:{kind:'manual'},components:{itemsSubtotalMinor:10000,discountMinor:1000,deliveryFeeMinor:1000,serviceFeeMinor:500,otherFeeMinor:0,totalMinor:10500}} },
  { id:'fin-pending',createdAt:Date.parse('2026-10-06T04:00:00Z'),status:'AGUARDANDO',money:{currency:'BRL',completeness:'partial',provenance:{kind:'manual'},components:{itemsSubtotalMinor:3000}} },
  { id:'fin-cancelled',createdAt:Date.parse('2026-10-06T05:00:00Z'),status:'CANCELADA',money:{currency:'BRL',completeness:'complete',provenance:{kind:'manual'},components:{itemsSubtotalMinor:2000,discountMinor:0,deliveryFeeMinor:0,serviceFeeMinor:0,otherFeeMinor:0,totalMinor:2000}} },
];
const financialFixture=Analytics.aggregate({orders:financialFixtureOrders,deliveries:[{id:'fin-delivery-1',orderId:'fin-paid-looking',status:'DELIVERED'},{id:'fin-delivery-return',orderId:'fin-paid-looking',status:'RETURNED',extensions:{x_rotamoto_delivery_type:'RETURN'}},{id:'fin-delivery-redelivery',orderId:'fin-paid-looking',status:'DELIVERED',extensions:{x_rotamoto_delivery_type:'REDELIVERY'}}]},{now,period:'all',timeZone:'America/Sao_Paulo',includeExportRows:true});
assert.deepEqual(financialFixture.financial.totals.BRL,{grossMinor:11500,discountMinor:1000,orderTotalMinor:10500,count:1},'gross, discount, and recorded order total are exact integer cents');
assert.deepEqual(financialFixture.financial.coverage,{available:1,total:2,cancelled:1,missing:1},'partial and cancelled orders do not become sales totals');
assert.equal(financialFixture.financial.dailyByCurrency.BRL[0].date,'2026-10-05','financial cohort uses company civil date');
assert.equal(financialFixture.financial.dailyByCurrency.BRL[0].count,1,'redelivery does not duplicate a single Order financial amount');
assert.equal(financialFixture.financial.received.available,false,'unvalidated Order.payments are not treated as receipts');
assert.equal(financialFixture.exportRows.find(row=>row.num==='').grossRecordedMinor,11500);
const noLedgerEvents=Analytics.aggregate({orders:financialFixtureOrders,financialEvents:[]},{now,period:'all',timeZone:'America/Sao_Paulo'});
assert.equal(noLedgerEvents.financial.received.available,false,'an empty confirmed event list does not become zero received');
assert.match(noLedgerEvents.financial.received.reason,/ausência de eventos não prova ausência/u);
const paymentEvent={event_id:'a1',order_id:'fin-paid-looking',event_kind:'PAYMENT_CONFIRMED',amount_minor:'7000',currency:'BRL',source_kind:'operator_declaration',occurred_at:'2026-10-06T03:00:00.000Z'};
const refundEvent={event_id:'a2',order_id:'fin-paid-looking',related_event_id:'a1',event_kind:'REFUND',amount_minor:'1000',currency:'BRL',source_kind:'operator_declaration',occurred_at:'2026-10-06T03:30:00.000Z'};
const adjustmentEvent={event_id:'a3',order_id:'fin-paid-looking',related_event_id:'a1',event_kind:'ADJUSTMENT',amount_minor:'-100',currency:'BRL',source_kind:'operator_declaration',occurred_at:'2026-10-06T03:45:00.000Z'};
const ledgerFixture=Analytics.aggregate({orders:financialFixtureOrders,financialEvents:[paymentEvent,refundEvent,adjustmentEvent]},{now,period:'all',timeZone:'America/Sao_Paulo'});
assert.equal(ledgerFixture.financial.received.available,true);
assert.equal(ledgerFixture.financial.refunds.available,true);
assert.equal(ledgerFixture.financialLedger.totals.BRL.netReceivedMinor,6000);
assert.equal(ledgerFixture.financialLedger.totals.BRL.adjustmentMinor,-100,'adjustments stay separate from received cash');
const financialHtml=View.render({report:financialFixture,filters:{period:'all',bike:'',status:'',type:'',source:''},statusLabel:value=>value,typeLabel:value=>value,sources:{},bikes:[],types:[],freshNote:'fixture financeira'});
assert.match(financialHtml,/Faturamento bruto registrado[\s\S]*R\$ 115,00/u,'the Executive presents the known gross order amount without labeling it received');
assert.match(financialHtml,/Registros financeiros ainda não consultados/u,'settlement is unavailable until a server ledger is loaded');

const timezone = Analytics.aggregate({ orders: [
  { id: 'before', createdAt: Date.parse('2026-10-06T02:59:59Z') },
  { id: 'after', createdAt: Date.parse('2026-10-06T03:00:00Z') },
] }, { now, period: 'all', timeZone: 'America/Sao_Paulo' });
assert.equal(timezone.timeZone, 'America/Sao_Paulo');
assert.equal(timezone.hourlyVolume[23], 1);
assert.equal(timezone.hourlyVolume[0], 1);
assert.equal(timezone.weekdayVolume[1], 1);
assert.equal(timezone.weekdayVolume[2], 1);
assert.deepEqual(timezone.dailyVolume, [{ date: '2026-10-05', count: 1 }, { date: '2026-10-06', count: 1 }]);
const invalidZone = Analytics.aggregate({ orders: [{ id: 'x', createdAt: now }] }, { now, period: 'all', timeZone: 'not-a-zone' });
assert.equal(invalidZone.hourlyVolume, null);
assert.deepEqual(invalidZone.dailyVolume, [{ date: new Date(now).toISOString().slice(0, 10), count: 1 }], 'daily dates use UTC when the company has no valid timezone');
assert.equal(Analytics.validTimezone('UTC'), true);
assert.equal(Analytics.validTimezone('America/Manaus'), true);
assert.equal(Analytics.validTimezone('+03:00'), false);
assert.equal(Analytics.validTimezone('Etc/GMT+3'), false, 'fixed-offset aliases are not operational zones');
const dstSpring = Analytics.aggregate({ orders: [{ id: 'dst1', createdAt: Date.parse('2026-03-08T06:30:00Z') }, { id: 'dst2', createdAt: Date.parse('2026-03-08T07:30:00Z') }] }, { now: Date.parse('2026-03-09T12:00:00Z'), period: 'all', timeZone: 'America/New_York' });
assert.equal(dstSpring.hourlyVolume[1], 1);
assert.equal(dstSpring.hourlyVolume[2], 0, 'DST spring-forward civil hour is absent');
assert.equal(dstSpring.hourlyVolume[3], 1);
assert.deepEqual(dstSpring.dailyVolume, [{ date: '2026-03-08', count: 2 }]);
const civilWindow = Analytics.aggregate({ orders: [
  { id: 'before-civil-window', createdAt: Date.parse('2026-03-08T04:30:00Z') },
  { id: 'first-civil-day', createdAt: Date.parse('2026-03-08T05:30:00Z') },
  { id: 'second-civil-day', createdAt: Date.parse('2026-03-09T04:30:00Z') },
] }, { now: Date.parse('2026-03-09T04:30:00Z'), period: '2', timeZone: 'America/New_York' });
assert.equal(civilWindow.total, 2, 'periods use local dates across the DST-shortened day');
assert.deepEqual(civilWindow.dailyVolume, [{ date: '2026-03-08', count: 1 }, { date: '2026-03-09', count: 1 }]);
const explicitRange = Analytics.aggregate({ orders: [
  { id: 'range-before', createdAt: Date.parse('2026-10-05T23:59:59Z') },
  { id: 'range-first', createdAt: Date.parse('2026-10-06T03:00:00Z') },
  { id: 'range-last', createdAt: Date.parse('2026-10-07T02:59:59Z') },
  { id: 'range-after', createdAt: Date.parse('2026-10-07T03:00:00Z') },
] }, { now: Date.parse('2026-10-08T12:00:00Z'), fromDate: '2026-10-06', toDate: '2026-10-06', timeZone: 'America/Sao_Paulo' });
assert.equal(explicitRange.total, 2, 'explicit date ranges use inclusive company civil dates');
assert.deepEqual(explicitRange.dailyVolume, [{ date: '2026-10-06', count: 2 }]);
assert.equal(explicitRange.dateRange.timeZone, 'America/Sao_Paulo');
const invalidRange = Analytics.aggregate({ orders: [{ id: 'range-invalid', createdAt: now }] }, { now, fromDate: '2026-10-07', toDate: '2026-10-06' });
assert.equal(invalidRange.invalidDateRange, true);
assert.equal(invalidRange.total, 0, 'reversed date ranges do not silently fall back');
const dstFall = Analytics.aggregate({ orders: [{ id: 'fold1', createdAt: Date.parse('2026-11-01T05:30:00Z') }, { id: 'fold2', createdAt: Date.parse('2026-11-01T06:30:00Z') }] }, { now: Date.parse('2026-11-02T12:00:00Z'), period: 'all', timeZone: 'America/New_York' });
assert.equal(dstFall.hourlyVolume[1], 2, 'repeated civil hour combines both valid instants');
assert.deepEqual(dstFall.dailyVolume, [{ date: '2026-11-01', count: 2 }]);
const yearEdge = Analytics.aggregate({ orders: [{ id: 'year', createdAt: Date.parse('2026-01-01T01:00:00Z') }] }, { now: Date.parse('2026-01-02T12:00:00Z'), period: 'all', timeZone: 'America/Sao_Paulo' });
assert.deepEqual(yearEdge.dailyVolume, [{ date: '2025-12-31', count: 1 }]);

const partial = Analytics.aggregate({ orders: [{ id: 'partial', deliveryId: 'partial-delivery', createdAt: now, status: 'FINALIZADA' }], deliveries: [{ id: 'partial-delivery', orderId: 'partial', status: 'DELIVERED', assignedAt: now, completedAt: now - 1 }] }, { now, period: 'all' });
assert.equal(partial.durations.assignedToCompleted.count, 0);
assert.equal(partial.durations.assignedToCompleted.missing, 1);
assert.equal(partial.estimatedDistance.average, null);
assert.equal(Analytics.aggregate({}, { now, period: 'all' }).completionRate, null);
const multiDeliveryCohort = Analytics.aggregate({
  orders: [{ id: 'cohort-order', createdAt: '2026-10-06T09:00:00Z', status: 'FINALIZADA' }],
  deliveries: [
    { id: 'cohort-primary', orderId: 'cohort-order', status: 'DELIVERED' },
    { id: 'cohort-return', orderId: 'cohort-order', status: 'RETURNED', extensions: { x_rotamoto_delivery_type: 'RETURN' } },
  ],
}, { now, fromDate: '2026-10-06', toDate: '2026-10-06', timeZone: 'America/Sao_Paulo' });
assert.equal(multiDeliveryCohort.total, 1, 'order cohort remains distinct');
assert.equal(multiDeliveryCohort.deliveryTotal, 2, 'return remains a separate delivery operation');
assert.equal(multiDeliveryCohort.dailyVolume.reduce((sum, row) => sum + row.count, 0), 1, 'legacy daily order series remains order based');
assert.equal(multiDeliveryCohort.deliveryDailyVolume.reduce((sum, row) => sum + row.count, 0), multiDeliveryCohort.deliveryTotal, 'delivery chart reconciles with delivery KPI');
assert.equal(multiDeliveryCohort.deliveryHourlyVolume.reduce((sum, count) => sum + count, 0), multiDeliveryCohort.deliveryTotal, 'hourly delivery chart reconciles with delivery KPI');
const unknown = Analytics.aggregate({ orders: [{ id: 'u', createdAt: now, status: '<unknown>', sourceId: '__proto__' }] }, { now, period: 'all' });
assert.equal(unknown.openCount, 0);
assert.equal(unknown.completionRate, null);
assert.equal(unknown.sourceCounts['__proto__'], 1);
assert.equal(unknown.statusCounts.UNKNOWN, 1);
const futureAndInvalid = Analytics.aggregate({ orders: [{ id: 'future', createdAt: now + 1, status: 'CREATED' }, { id: 'boolean-distance', createdAt: now, status: 'CREATED', km: false }] }, { now, period: 'all' });
assert.equal(futureAndInvalid.total, 1);
assert.equal(futureAndInvalid.invalidCreatedAt, 1);
assert.equal(futureAndInvalid.estimatedDistance.count, 0);

assert.match(Analytics.csvRow(['=1+1', ' +SUM(A1:A2)', '@cmd', '-2', 'plain,"text']), /^"'=1\+1","' \+SUM\(A1:A2\)","'@cmd","'-2","plain,""text"$/);
assert.match(Analytics.csvCell('=1+1'), /^"'=1\+1"$/);
assert.match(Analytics.csvCell(' +SUM(A1:A2)'), /^"' \+SUM/);
assert.match(Analytics.csvCell('plain,"text'), /^"plain,""text"$/);
assert.equal(Object.hasOwn(report, 'exportRows'), false);
assert.doesNotMatch(JSON.stringify(report), /11999990000/);
const exportReport = Analytics.aggregate({ orders, deliveries, earnings, bikes: [{ id: 'driver-2', name: 'Bia' }] }, { now, period: '30', includeExportRows: true });
assert.equal(exportReport.exportRows.length, 4);
assert.equal(exportReport.exportRows[0].customer, 'Cliente QA');
assert.equal(Object.hasOwn(exportReport.exportRows[0], 'phone'), false);
assert.equal(Object.hasOwn(exportReport.exportRows[0], 'address'), false);

const statusPt = value => ({ DELIVERED: 'Concluída', CANCELLED: 'Cancelada', FAILED: 'Com falha', RETURNED: 'Devolvida' })[value] || 'Em andamento';
const typePt = value => value === 'RETORNO' ? 'Devolução' : 'Entrega';
const html = View.render({ report, filters: { period: '30', bike: '', status: '', type: '', source: '' }, statusLabel: statusPt, typeLabel: typePt, sources: { ifood: 'iFood', manual: 'Manual', keeta: 'Keeta', unknown: 'Sem origem' }, bikes: [], types: ['NORMAL', 'RETORNO'], freshNote: '<sem freshness>' });
assert.match(html, /report-dashboard/u, 'report renders the redesigned dashboard');
assert.match(html, /id="report-main-tab-executive"[^>]*aria-selected="true"/u, 'executive report opens by default');
assert.match(html, /data-report-main-panel="operational"[^>]*hidden/u, 'operational details are not visible in the executive view');
assert.match(html, /data-report-operational-panel="report-overview-details"[^>]*>/u, 'the selected operational section is available for direct navigation');
for (const id of ['report-deliveries','report-fleet','report-costs','report-intelligence','report-quality','report-territory','report-export']) assert.match(html, new RegExp(`data-report-operational-panel="${id}"[^>]*hidden`), `${id} is collapsed while another operational section is selected`);
assert.equal((html.match(/data-report-operational-panel=/gu)||[]).length,8,'the detailed tab contains each existing analytical section exactly once');
assert.equal((html.match(/id="rfrom"/gu)||[]).length,1,'both report tabs share one start date control');
assert.equal((html.match(/id="rb"/gu)||[]).length,1,'both report tabs share one driver filter');
const operationalHtml = View.render({ report, filters: { period: '30', fromDate: '2026-10-01', toDate: '2026-10-06', bike: 'driver-1', status: '', type: '', source: '', mainView: 'operational', operationalSection: 'report-costs' }, statusLabel: statusPt, typeLabel: typePt, sources: {}, bikes: [], types: [], freshNote: 'dados locais' });
assert.match(operationalHtml, /id="report-main-tab-operational"[^>]*aria-selected="true"/u, 'the requested primary tab is reflected in the renderer');
assert.match(operationalHtml, /id="report-costs"[^>]*data-report-operational-panel="report-costs"(?! hidden)/u, 'the requested detailed section opens directly');
assert.match(operationalHtml, /id="report-main-panel-executive"[^>]*hidden/u, 'the inactive executive panel is hidden from display and accessibility');
for (const id of ['report-overview','report-overview-details','report-deliveries','report-fleet','report-costs','report-intelligence','report-quality','report-territory','report-export']) assert.match(html, new RegExp(`id="${id}"`), `${id} section exists`);
assert.match(html, /Pedidos no período[\s\S]*report-metric-value/u);
assert.match(html, /Status das entregas/u);
assert.match(html, /Pedidos por origem/u);
assert.match(html, /Custos e repasses/u);
assert.match(html, /Taxas de entrega/u);
assert.match(html, /Entregas por horário/u);
assert.match(html, /fulfillment-analytics/u, 'canonical logistics report is embedded once');
assert.match(html, /territorial-heatmap/u, 'canonical territory report is embedded once');
assert.match(html, /capacity-analytics/u, 'capacity data is placed in the fleet section');
assert.match(html, /logistics-cost-analytics/u, 'own fleet and external costs are placed in the cost section');
assert.match(html, /decision-quality-analytics/u, 'recommendation and ETA quality data is placed in the quality section');
assert.match(html, /route-settings-report/u, 'route start and return configuration is placed in the logistics section');
assert.equal((html.match(/id="fulfillment-analytics"/gu)||[]).length,1);
assert.equal((html.match(/id="territorial-heatmap"/gu)||[]).length,1);
assert.match(fs.readFileSync(path.join(__dirname,'..','logistics-ui.js'),'utf8'), /if \(targets\.decisions&&decisionQuality\) targets\.decisions\.innerHTML = historyNote\+decisionQualityMarkup\(decisionQuality\)/u, 'canonical decision-quality renderer is mounted in its dedicated report section');
assert.match(html, /Endereços diferentes/u);
assert.match(html, /data-export-report/u);
assert.match(html, /id="rfrom"[\s\S]*id="rto"[\s\S]*id="rb"/u, 'date and driver filters are present');
assert.match(html, /&lt;sem freshness&gt;/u, 'dynamic freshness is escaped');
const timezoneHtml = View.render({ report: timezone, filters: { period: '30', bike: '', status: '', type: '', source: '' }, statusLabel: statusPt, typeLabel: typePt, sources: { unknown: 'Sem origem registrada' }, bikes: [], types: [], freshNote: 'dados locais' });
assert.match(timezoneHtml, /Pedidos por dia|Entregas por dia/u);
assert.match(timezoneHtml, /fuso horário/u);
assert.match(timezoneHtml, /class="analytics-bars"/u, 'time charts use responsive semantic bars');
assert.doesNotMatch(timezoneHtml, /unknown: 2/u);
assert.match(html, /Clientes recorrentes/u);
assert.match(html, /Endereços mais recorrentes/u);
const emptyReport = Analytics.aggregate({ orders: [], deliveries: [] }, { now, period: '30' });
const emptyRenderer = (title, description, icon, variant) => `<div class="emptyState emptyState--${variant}"><span>${icon}</span><strong>${title}</strong><small>${description}</small></div>`;
const emptyHtml = View.render({ report: emptyReport, filters: { period: '30', bike: '', status: '', type: '', source: '' }, statusLabel: statusPt, typeLabel: typePt, sources: {}, bikes: [], types: [], freshNote: 'dados locais', emptyState: emptyRenderer });
assert.match(emptyHtml, /Nenhum pedido no período selecionado/u);
assert.match(emptyHtml, /emptyState--compact/u);
assert.match(emptyHtml, /Nenhum motoboy neste período/u);
assert.doesNotMatch(emptyHtml, /R\$ 0,00/u, 'absence of financial data is not presented as zero');
assert.doesNotMatch(emptyHtml, /Defina o fuso horário/u);
const unavailableTimezoneHtml = View.render({ report: invalidZone, filters: { period: '30', bike: '', status: '', type: '', source: '' }, statusLabel: statusPt, typeLabel: typePt, sources: {}, bikes: [], types: [], freshNote: 'dados locais', emptyState: emptyRenderer });
assert.match(unavailableTimezoneHtml, /report-unavailable[\s\S]*fuso horário da empresa/u, 'missing timezone is presented as unavailable, not as no data');
const reportCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.match(reportCss, /\.report-kpi-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/u, 'KPI cards use a balanced desktop grid');
assert.match(reportCss, /\.report-kpi-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}\.report-metric-grid/u, 'metrics adapt at tablet widths');
assert.match(reportCss, /\.report-filter-grid\{grid-template-columns:minmax\(0,1fr\)\}/u, 'filters stack on narrow mobile screens');
assert.match(reportCss, /\.report-logistics-panel \.report-row\{display:grid;gap:6px/u, 'server logistics rows separate labels, values and details');
assert.match(html, /Total de repasses/);
assert.match(html, /&lt;sem freshness&gt;/);
assert.match(html, /Visão geral operacional/);
assert.doesNotMatch(html.replace(/<[^>]*>/gu, ' '), /Order\.|Earning|Driver|Company|Route|DELIVERED|CANCELLED|FAILED|RETURNED|0\/0|estado reconhecido/u, 'relatório não expõe nomes internos nem estados técnicos ao operador');
assert.doesNotMatch(html, /\bBRL\b/u, 'relatório apresenta nomes de moeda, não códigos internos');
assert.match(html, /Tipos de entrega/);
assert.match(html, /Endereços mais recorrentes/);
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert.match(appSource, /function activateReportMainView\([\s\S]*?state\.report\.mainView=selected/u, 'main tabs retain their selection in the shared report state');
assert.match(appSource, /function activateReportOperationalSection\([\s\S]*?state\.report\.operationalSection=id/u, 'the selected operational section survives rerendering');
assert.match(appSource, /function bindReportNavigation\([\s\S]*?ArrowLeft[\s\S]*?ArrowRight/u, 'report tabs support keyboard navigation');
assert.match(appSource, /function dashboardV2Model\(\)[\s\S]*?RotaMotoAnalytics\.aggregate/u, 'Command Center reuses canonical analytics aggregation');
assert.match(appSource, /function dashboardV2Model\(\)[\s\S]*?analytics\.driverPayout/u, 'Command Center reports canonical payout coverage');
assert.doesNotMatch(appSource, /kpi\('Faturamento hoje'/);
assert.match(appSource, /Taxa de entrega conhecida \(BRL\)/, 'CSV names the known fee semantics explicitly');
assert.match(appSource,/Valor bruto registrado \(minor units\)[\s\S]*Recebimentos confirmados no razão \(minor units\)[\s\S]*Estornos registrados \(minor units\)[\s\S]*Ajustes auditáveis \(minor units\)/u,'financial export separates commercial value, server-confirmed receipts, refunds and adjustments');
assert.match(appSource,/financialEvents:ledgerAvailable\?state\.financialEvents:undefined/u,'CSV includes only events loaded from the confirmed server ledger');
assert.match(appSource,/row\.paymentConfirmedMinor\?\?"Indisponível"/u,'CSV keeps unavailable payment evidence distinct from zero');
assert.match(appSource,/function openFinancialOperation\([\s\S]*?RotaMotoDialog\.confirm\([\s\S]*?flushFinanceOutbox/u,'sensitive financial actions require a custom explicit confirmation and server synchronization');
assert.match(appSource,/data-record-finance-payout[\s\S]*?PAYOUT_SETTLED/u,'payout settlement UI references the canonical Earning and settlement event');
assert.match(appSource,/saved\?\.status==='rejected'[\s\S]*?financeErrorMessage/u,'server rejections preserve the financial form and show an operation-specific error');
assert.match(appSource, /function exportCSV\(\)\{[\s\S]*?RotaMotoAnalytics\.csvRow[\s\S]*?catch\(_\)[\s\S]*?Não foi possível exportar o relatório/u, 'CSV export reports a sanitized user-facing failure and still uses the safe canonical serializer');
assert.doesNotMatch(appSource, /earning BRL|Route\.deliveryIds|Status canônico da entrega|Fulfillment logístico|QR seguro da Delivery/u, 'telas operacionais não expõem propriedades internas de entidades');
assert.match(appSource, /const syncOperationLabel=value=>/u, 'delivery detail translates local and server sync states before showing them');

console.log('Analytics baseline tests passed');
