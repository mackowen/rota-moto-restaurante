(function (root, factory) {
  const api = factory(root?.RotaMotoOrderMoney);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoTicketRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (OrderMoney) {
  'use strict';

  const DEFAULT_PRINTING = Object.freeze({ enabled: true, mode: 'manual', provider: 'browser', includeDeliveryQr: false });
  const LABELS = Object.freeze({ itemsSubtotalMinor: 'Subtotal de produtos', discountMinor: 'Desconto', deliveryFeeMinor: 'Taxa de entrega', serviceFeeMinor: 'Taxa de serviço', otherFeeMinor: 'Outras taxas', totalMinor: 'Total do pedido' });

  function normalizeSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const ids = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200))].slice(-100000) : [];
    return { enabled: input.enabled !== false, mode: input.mode === 'automatic' ? 'automatic' : 'manual', provider: 'browser', includeDeliveryQr: input.includeDeliveryQr === true, preparedOrderIds: ids(input.preparedOrderIds), pendingOrderIds: ids(input.pendingOrderIds) };
  }

  function prepareAutomaticJobs(orders, value) {
    const settings = normalizeSettings(value);
    if (!settings.enabled || settings.mode !== 'automatic') return { settings, added: [] };
    const prepared = new Set(settings.preparedOrderIds);
    const pending = new Set(settings.pendingOrderIds);
    const added = [];
    for (const order of Array.isArray(orders) ? orders : []) {
      const id = typeof order?.id === 'string' ? order.id : '';
      if (!id || prepared.has(id)) continue;
      prepared.add(id);
      pending.add(id);
      added.push(id);
    }
    settings.preparedOrderIds = [...prepared].slice(-100000);
    settings.pendingOrderIds = [...pending].slice(-100000);
    return { settings, added };
  }

  function shouldRequestQr({ includeQr, online, deliveryId }) {
    return includeQr === true && online !== false && typeof deliveryId === 'string' && deliveryId.length > 0;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function dateTime(value, timeZone) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return 'Data não informada';
    if (typeof timeZone !== 'string' || !timeZone) return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC (fuso da empresa não configurado)`;
    const options = { dateStyle: 'short', timeStyle: 'short' };
    try {
      if (typeof timeZone === 'string' && timeZone) options.timeZone = timeZone;
      return new Intl.DateTimeFormat('pt-BR', options).format(date);
    } catch (_) { return 'Data não informada'; }
  }

  function money(value, currency, scale) {
    if (!Number.isSafeInteger(value) || !currency || !Number.isInteger(scale)) return null;
    try { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency, minimumFractionDigits: scale, maximumFractionDigits: scale }).format(value / (10 ** scale)); }
    catch (_) { return null; }
  }

  function canonicalMoney(order) {
    if (!OrderMoney || !order?.money) return [];
    const validation = OrderMoney.validateMoney(order.money);
    if (!validation.valid || order.money.completeness === 'unknown') return [];
    const components = order.money.components || {};
    return Object.entries(LABELS).filter(([key]) => Number.isSafeInteger(components[key]))
      .map(([key, label]) => ({ label, value: money(components[key], order.money.currency, validation.scale), total: key === 'totalMinor' }))
      .filter(row => row.value);
  }

  function itemLines(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 100).map(item => {
      if (!item || typeof item !== 'object') return null;
      const name = String(item.name || item.title || item.description || '').trim().slice(0, 240);
      if (!name) return null;
      const quantity = Number(item.quantity ?? item.qty ?? 1);
      const count = Number.isFinite(quantity) && quantity > 0 && quantity <= 10000 ? quantity : null;
      return { name, quantity: count, note: String(item.observations || item.notes || '').trim().slice(0, 400) };
    }).filter(Boolean);
  }

  function paymentLabels(payments) {
    if (!Array.isArray(payments)) return [];
    return payments.slice(0, 20).map(payment => {
      if (typeof payment === 'string') return payment.trim().slice(0, 80);
      if (!payment || typeof payment !== 'object') return '';
      return String(payment.method || payment.type || payment.name || payment.paymentMethod || '').trim().slice(0, 80);
    }).filter(Boolean);
  }

  function createSnapshot(order, options = {}) {
    if (!order || typeof order !== 'object' || !String(order.id || '').trim()) throw new TypeError('Pedido inválido para impressão.');
    const origin = String(options.origin || order.sourceId || order.channel || order.source?.origin || 'Não informada').slice(0, 80);
    const timestamp = order.createdAt || order.receivedAt || order.updatedAt;
    return Object.freeze({
      orderId: String(order.id), number: String(order.num || '—').slice(0, 120), origin,
      createdAt: dateTime(timestamp, options.timeZone), customer: String(order.customer || '').trim().slice(0, 240),
      phone: String(order.phone || '').trim().slice(0, 80), address: String(order.address || '').trim().slice(0, 600),
      observations: String(order.obs || '').trim().slice(0, 1000), items: itemLines(order.items), payments: paymentLabels(order.payments),
      type: String(order.type || '').slice(0, 60), status: String(options.status || order.status || '').slice(0, 60),
      timezone: String(options.timeZone || ''), money: canonicalMoney(order), qrDataUrl: options.qrDataUrl || null,
      qrUnavailable: options.includeQr === true && !options.qrDataUrl
    });
  }

  function render(snapshot, options = {}) {
    if (!snapshot || typeof snapshot !== 'object') throw new TypeError('Snapshot da comanda inválido.');
    const esc = escapeHtml;
    const rows = snapshot.money.map(row => `<div class="ticket-money-row ${row.total ? 'ticket-total' : ''}"><span>${esc(row.label)}</span><b>${esc(row.value)}</b></div>`).join('');
    const items = snapshot.items.length ? `<section class="ticket-section"><h2>Itens</h2><ul class="ticket-items">${snapshot.items.map(item => `<li><span>${item.quantity ? `${esc(item.quantity)} × ` : ''}${esc(item.name)}${item.note ? `<small>${esc(item.note)}</small>` : ''}</span></li>`).join('')}</ul></section>` : '';
    const payments = snapshot.payments.length ? `<section class="ticket-section"><h2>Pagamento</h2><p>${snapshot.payments.map(esc).join(', ')}</p></section>` : '';
    const qr = snapshot.qrDataUrl ? `<section class="ticket-qr"><img alt="QR seguro da entrega" src="${esc(snapshot.qrDataUrl)}"><small>Referência assinada da entrega. Não autoriza acesso.</small></section>` : snapshot.qrUnavailable ? '<p class="ticket-qr-unavailable">QR seguro indisponível; esta comanda não inclui código.</p>' : '';
    return `<article class="ticket ${options.sample ? 'ticket-sample' : ''}" lang="pt-BR"><header class="ticket-header"><strong>${esc(options.restaurant || 'RotaMoto')}</strong><h1>Comanda #${esc(snapshot.number)}</h1><p>${esc(snapshot.origin)} · ${esc(snapshot.createdAt)}</p></header><section class="ticket-section"><h2>Cliente</h2><p>${esc(snapshot.customer || 'Não informado')}</p>${snapshot.phone ? `<p>Telefone: ${esc(snapshot.phone)}</p>` : ''}<p class="ticket-address">${esc(snapshot.address || 'Endereço não informado')}</p></section>${items}${snapshot.observations ? `<section class="ticket-section"><h2>Observações</h2><p class="ticket-notes">${esc(snapshot.observations)}</p></section>` : ''}${payments}${rows ? `<section class="ticket-section ticket-money">${rows}</section>` : ''}<footer class="ticket-footer">${snapshot.type ? `<span>${esc(snapshot.type)}</span>` : ''}${snapshot.status ? `<span>${esc(snapshot.status)}</span>` : ''}</footer>${qr}${options.sample ? '<p class="ticket-sample-label">Prévia de teste — não é um pedido real</p>' : ''}</article>`;
  }

  function jobKey(order) {
    if (!order || typeof order.id !== 'string' || !order.id) throw new TypeError('Pedido inválido para job de impressão.');
    const revision = Number(order.version || order.sync?.version || 1);
    return `${order.id}:${Number.isSafeInteger(revision) && revision > 0 ? revision : 1}`;
  }

  return Object.freeze({ DEFAULT_PRINTING, normalizeSettings, prepareAutomaticJobs, shouldRequestQr, escapeHtml, dateTime, canonicalMoney, createSnapshot, render, jobKey });
});
