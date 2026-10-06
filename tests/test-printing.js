'use strict';

const assert = require('node:assert/strict');
require('../order-money');
const Ticket = require('../ticket-renderer');
const Printer = require('../browser-printer-provider');

const order = {
  id: 'order-1', companyId: 'company-1', num: '42', customer: '<script>alert(1)</script>',
  phone: '11999990000', address: 'Rua A & <b>Casa</b>', obs: 'Portão "azul"',
  sourceId: 'manual', channel: 'manual', createdAt: '2026-10-06T12:30:00.000Z',
  value: 99.99, deliveryFee: 8.5, qrPayload: 'rota-moto-order-qr PII_LEGACY_PAYLOAD',
  items: [{ name: '<img src=x onerror=alert(1)>', quantity: 2, price: 12345 }],
  payments: [{ method: 'PIX', value: 1000 }],
  money: { currency: 'BRL', completeness: 'partial', provenance: { kind: 'manual' }, components: { deliveryFeeMinor: 850 } }
};

const snapshot = Ticket.createSnapshot(order, { timeZone: 'America/Sao_Paulo', origin: 'Entrada manual' });
assert.match(snapshot.createdAt, /06\/10\/2026/);
assert.match(snapshot.createdAt, /09:30/);
assert.equal(snapshot.money.length, 1);
assert.equal(snapshot.money[0].label, 'Taxa de entrega');
assert.equal(snapshot.money[0].value, 'R$ 8,50');
assert.equal(snapshot.items[0].name, '<img src=x onerror=alert(1)>');
assert.match(Ticket.dateTime(order.createdAt, null), /UTC \(fuso da empresa não configurado\)/);

const html = Ticket.render(snapshot, { restaurant: '<Loja>' });
assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(html, /Rua A &amp; &lt;b&gt;Casa&lt;\/b&gt;/);
assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
assert.doesNotMatch(html, /PII_LEGACY_PAYLOAD/);
assert.doesNotMatch(html, /R\$ 99,99/);
assert.doesNotMatch(html, /R\$ 123,45/);

const complete = Ticket.createSnapshot({ ...order, money: {
  currency: 'BRL', completeness: 'complete', provenance: { kind: 'manual' },
  components: { itemsSubtotalMinor: 10000, discountMinor: 500, deliveryFeeMinor: 850, serviceFeeMinor: 200, otherFeeMinor: 100, totalMinor: 10650 }
} }, { timeZone: 'UTC' });
assert.equal(complete.money.find(row => row.total)?.value, 'R$ 106,50');
assert.equal(Ticket.render(complete).includes('Total do pedido'), true);

const qrSnapshot = Ticket.createSnapshot(order, { timeZone: 'UTC', qrDataUrl: 'data:image/png;base64,U0FGRV9RUl9JTUFHRQ==', includeQr: true });
const qrHtml = Ticket.render(qrSnapshot);
const qrSrc = qrHtml.match(/<img alt="QR seguro da entrega" src="([^"]+)"/)[1];
assert.match(qrSrc, /^data:image\/png;base64,/);
assert.doesNotMatch(qrSrc, /Cliente|11999990000|Rua|PII/);
assert.equal(Ticket.shouldRequestQr({ includeQr: true, online: false, deliveryId: 'delivery-1' }), false);
assert.equal(Ticket.shouldRequestQr({ includeQr: true, online: true, deliveryId: 'delivery-1' }), true);
assert.equal(Ticket.shouldRequestQr({ includeQr: true, online: true, deliveryId: '' }), false);

const automatic = { enabled: true, mode: 'automatic', preparedOrderIds: ['old'], pendingOrderIds: [] };
const prepared = Ticket.prepareAutomaticJobs([{ id: 'old' }, { id: 'new' }, { id: 'new' }], automatic);
assert.deepEqual(prepared.added, ['new']);
assert.deepEqual(prepared.settings.pendingOrderIds, ['new']);
assert.deepEqual(Ticket.prepareAutomaticJobs([{ id: 'new' }], prepared.settings).added, []);
assert.deepEqual(Ticket.prepareAutomaticJobs([{ id: 'later' }], { ...prepared.settings, mode: 'manual' }).added, []);
assert.equal(Ticket.jobKey({ id: 'order-1', version: 3 }), 'order-1:3');
assert.equal(Ticket.normalizeSettings({ mode: 'bad', provider: 'custom', copies: 5 }).provider, 'browser');
assert.equal(Ticket.normalizeSettings({ copies: 5 }).copies, undefined);

const root = { innerHTML: '', replaceChildren() { this.innerHTML = ''; }, setAttribute() {} };
const body = { appendChild(node) { this.child = node; } };
const doc = { body, getElementById(id) { return id === 'printRoot' ? root : null; }, createElement() { return root; } };
let prints = 0;
assert.deepEqual(Printer.print('<article>ticket</article>', doc, { print() { prints += 1; } }), { ok: true });
assert.equal(root.innerHTML, '<article>ticket</article>');
assert.equal(prints, 1);
assert.deepEqual(Printer.print('x', doc, { print() { throw new Error('browser blocked'); } }), { ok: false, reason: 'blocked' });
assert.equal(root.innerHTML, '');
Printer.clear(doc);
assert.equal(root.innerHTML, '');
assert.deepEqual(Printer.print('x', {}, {}), { ok: false, reason: 'unsupported' });

let afterPrint;
let clearedTimer = false;
const browserWindow = {
  print() {},
  setTimeout(fn) { this.cleanup = fn; return 7; },
  clearTimeout(id) { clearedTimer = id === 7; },
  addEventListener(name, fn) { if (name === 'afterprint') afterPrint = fn; }
};
assert.deepEqual(Printer.print('<article>private ticket</article>', doc, browserWindow), { ok: true });
afterPrint();
assert.equal(clearedTimer, true);
assert.equal(root.innerHTML, '');

console.log('printing tests passed');
