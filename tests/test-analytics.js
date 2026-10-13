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
assert.equal(report.distinctCustomerCount, 1);
assert.equal(report.customerGroups[0].count, 2);
assert.equal(report.distinctAddressCount, 1);
assert.equal(report.addressGroups[0].count, 2);

const badMoney = Analytics.aggregate({ orders: [{ id: 'x', createdAt: now, status: 'FINALIZADA', sourceId: 'manual', value: 8, amountMinor: 1200, currency: 'BRL' }, { id: 'y', createdAt: now, status: 'FINALIZADA', deliveryFee: 'NaN', amountMinor: 200, currency: 'USD' }, { id: 'jpy', createdAt: now, status: 'CANCELADA', amountMinor: 500, currency: 'JPY' }, { id: 'kwd', createdAt: now, status: 'CANCELADA', amountMinor: 1234, currency: 'KWD' }, { id: 'bad-currency', createdAt: now, status: 'CANCELADA', amountMinor: 900, currency: 'ZZZ' }], deliveries: [{ id: 'x', orderId: 'x', status: 'DELIVERED' }, { id: 'y', orderId: 'y', status: 'DELIVERED' }, { id: 'jpy', orderId: 'jpy', status: 'CANCELLED' }, { id: 'kwd', orderId: 'kwd', status: 'CANCELLED' }, { id: 'bad-currency', orderId: 'bad-currency', status: 'CANCELLED' }] }, { now, period: 'all' });
assert.equal(badMoney.deliveryFees.total, 8); // Legacy value is a delivery fee, not product revenue.
assert.equal(badMoney.coverage.deliveryFee.available, 1);
assert.equal(badMoney.coverage.deliveryFee.missing, 1);
assert.deepEqual(Object.keys(badMoney.orderTicket), [], 'ambiguous legacy amountMinor is excluded from ticket analytics');
assert.equal(badMoney.coverage.orderAmount.available, 0);
assert.equal(badMoney.coverage.orderAmount.missing, 5);
assert.deepEqual({ ...badMoney.coverage.orderAmount.kinds }, { legacy_delivery_fee: 1, legacy_ambiguous_total: 4 });

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
assert.equal(invalidZone.dailyVolume, null);
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
assert.match(html, /sem data válida ou fora do período/);
assert.match(html, /Vendas/);
assert.match(html, /class="card report-kpi-panel"[\s\S]*class="grid kpis report-kpis"/u, 'period indicators are grouped in a section card');
assert.equal((html.match(/class="metric"/gu)||[]).length >= 6, true, 'all six operational indicators use the shared metric component');
assert.match(html, /Taxas/);
assert.match(html, /Repasses/);
const timezoneHtml = View.render({ report: timezone, filters: { period: '30', bike: '', status: '', type: '', source: '' }, statusLabel: statusPt, typeLabel: typePt, sources: { unknown: 'Sem origem registrada' }, bikes: [], types: [], freshNote: 'dados locais' });
assert.match(timezoneHtml, /Pedidos por dia/);
assert.match(timezoneHtml, /horário local da empresa/u);
assert.match(timezoneHtml, /class="card report-time-panel"[\s\S]*class="analysis-grid"[\s\S]*Pedidos por dia/u, 'time charts are grouped in one report section panel');
assert.equal((timezoneHtml.match(/class="analysis-box"/gu) || []).length, 3, 'hour, weekday and daily charts use consistent inner panels');
assert.doesNotMatch(timezoneHtml, /America\/Sao_Paulo|unknown: 2/);
assert.match(html, /class="card report-recurrence-summary"[\s\S]*Clientes diferentes \(pelo nome\)/u, 'recurrence KPIs have a section card and heading');
assert.match(html, /class="report-sections report-finance"[\s\S]*<section class="card">[\s\S]*Vendas[\s\S]*<section class="card">[\s\S]*Taxas[\s\S]*<section class="card">[\s\S]*Repasses/u);
const emptyReport = Analytics.aggregate({ orders: [], deliveries: [] }, { now, period: '30' });
const emptyRenderer = (title, description, icon, variant) => `<div class=\"emptyState emptyState--${variant}\"><span>${icon}</span><strong>${title}</strong><small>${description}</small></div>`;
const emptyHtml = View.render({ report: emptyReport, filters: { period: '30', bike: '', status: '', type: '', source: '' }, statusLabel: statusPt, typeLabel: typePt, sources: {}, bikes: [], types: [], freshNote: 'dados locais', emptyState: emptyRenderer });
assert.match(emptyHtml, /Sem pedidos neste período/);
assert.match(emptyHtml, /class=\"emptyState emptyState--compact\"/);
assert.match(emptyHtml, /Nenhum motoboy neste período/);
assert.match(emptyHtml, /class="card report-time-panel"[\s\S]*class="emptyState emptyState--compact"/u, 'empty time analysis remains inside its report section');
assert.doesNotMatch(emptyHtml, /R\$ 0,00/, 'absence of financial data is not presented as zero');
assert.doesNotMatch(emptyHtml, /Defina o fuso horário/);
const unavailableTimezoneHtml = View.render({ report: invalidZone, filters: { period: '30', bike: '', status: '', type: '', source: '' }, statusLabel: statusPt, typeLabel: typePt, sources: {}, bikes: [], types: [], freshNote: 'dados locais', emptyState: emptyRenderer });
assert.match(unavailableTimezoneHtml, /class="card report-time-panel"[\s\S]*class="report-unavailable" role="status"[\s\S]*O horário da empresa ainda não foi configurado/u, 'missing timezone is presented as unavailable, inside a card, not as no data');
const timePanelStart = unavailableTimezoneHtml.indexOf('class="card report-time-panel"');
const timePanelEnd = unavailableTimezoneHtml.indexOf('class="card"><div class="section-head"><div><h2>Atualização dos dados', timePanelStart);
assert.ok(timePanelStart >= 0 && timePanelEnd > timePanelStart);
assert.doesNotMatch(unavailableTimezoneHtml.slice(timePanelStart, timePanelEnd), /emptyState--compact/u, 'unavailable analysis is not presented as an empty-data state');
const reportCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.match(reportCss, /\.report-sections\.report-finance\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}/u, 'financial panels use three balanced columns on wide screens');
assert.match(reportCss, /\.report-sections\.report-finance\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/u, 'financial panels adapt to two columns at tablet widths');
assert.match(reportCss, /\.report-sections\.report-finance\{grid-template-columns:1fr\}/u, 'financial panels stack on mobile');
assert.match(reportCss, /\.report-finance \.metric\{grid-template-columns:minmax\(0,1fr\);gap:5px;align-items:start\}/u, 'finance metric labels and values stack instead of compressing in narrow columns');
assert.match(html, /Total de repasses/);
assert.match(html, /&lt;sem freshness&gt;/);
assert.match(html, /Gráficos por horário indisponíveis/);
assert.doesNotMatch(html.replace(/<[^>]*>/gu, ' '), /Order\.|Earning|Driver|Company|Route|DELIVERED|CANCELLED|FAILED|RETURNED|0\/0|estado reconhecido/u, 'relatório não expõe nomes internos nem estados técnicos ao operador');
assert.doesNotMatch(html, /\bBRL\b/u, 'relatório apresenta nomes de moeda, não códigos internos');
assert.match(html, /Tipos de entrega/);
assert.match(html, /Endereços mais recorrentes/);
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert.match(appSource, /function dashboard\(\)[\s\S]*?RotaMotoAnalytics\.aggregate/u, 'Command Center reuses canonical analytics aggregation');
assert.match(appSource, /function dashboard\(\)[\s\S]*?report\.driverPayout/u, 'Command Center reports canonical payout coverage');
assert.doesNotMatch(appSource, /kpi\('Faturamento hoje'/);
assert.match(appSource, /Taxa de entrega conhecida \(BRL\)/, 'CSV names the known fee semantics explicitly');
assert.doesNotMatch(appSource, /earning BRL|Route\.deliveryIds|Status canônico da entrega|Fulfillment logístico|QR seguro da Delivery/u, 'telas operacionais não expõem propriedades internas de entidades');
assert.match(appSource, /const syncOperationLabel=value=>/u, 'delivery detail translates local and server sync states before showing them');

console.log('Analytics baseline tests passed');
