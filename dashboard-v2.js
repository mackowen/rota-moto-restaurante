'use strict';
(() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icons = {route:'↗',waiting:'◷',done:'✓',cancel:'×',bell:'♧',plus:'+',home:'⌂',bag:'▣',bike:'♧',more:'☰',print:'▤',qr:'▦',online:'●'};
  const icon = name => `<span class="dv2-icon" aria-hidden="true">${icons[name] || '•'}</span>`;
  const fmtDate = value => {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Data indisponível';
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date) : 'Data indisponível';
  };
  const fee = value => value == null || !Number.isFinite(Number(value)) ? 'Não informada' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value));
  const kpi = (item) => `<article class="dv2-kpi dv2-kpi-${escapeHtml(item.tone)}"><span class="dv2-kpi-icon">${icon(item.icon)}</span><span class="dv2-kpi-label">${escapeHtml(item.label)}</span><strong>${item.value == null ? '—' : escapeHtml(item.value)}</strong><small>${escapeHtml(item.detail || 'Indisponível')}</small></article>`;
  const actions = order => `<div class="dv2-actions"><button class="dv2-button dv2-primary" type="button" data-detail="${escapeHtml(order.id)}">Abrir corrida</button><button class="dv2-button dv2-icon-button" type="button" disabled aria-label="Impressão disponível no fluxo atual, fora da prévia" title="Ação desabilitada na prévia">${icon('print')}</button><button class="dv2-button dv2-icon-button" type="button" disabled aria-label="QR seguro disponível no fluxo atual, fora da prévia" title="Ação desabilitada na prévia">${icon('qr')}</button></div>`;
  const card = order => `<article class="dv2-delivery-card"><div class="dv2-card-top"><strong>Pedido #${escapeHtml(order.number)}</strong><span class="dv2-status ${escapeHtml(order.statusTone)}">${escapeHtml(order.status)}</span><time>${escapeHtml(fmtDate(order.createdAt))}</time></div><div class="dv2-customer"><strong>${escapeHtml(order.customer || 'Cliente não informado')}</strong><span>${escapeHtml(order.address || 'Endereço não informado')}</span></div><div class="dv2-delivery-meta"><span><small>Motoboy</small><strong>${escapeHtml(order.driver || 'Não atribuído')}</strong></span><span><small>Taxa</small><strong>${escapeHtml(order.fee)}</strong></span></div>${actions(order)}</article>`;
  const table = orders => `<div class="dv2-table-wrap"><table class="dv2-table"><thead><tr><th>Pedido</th><th>Cliente e endereço</th><th>Status</th><th>Motoboy</th><th>Taxa</th><th>Ações</th></tr></thead><tbody>${orders.map(order=>`<tr><td><strong>#${escapeHtml(order.number)}</strong><small>${escapeHtml(fmtDate(order.createdAt))}</small></td><td><strong>${escapeHtml(order.customer || 'Cliente não informado')}</strong><small>${escapeHtml(order.address || 'Endereço não informado')}</small></td><td><span class="dv2-status ${escapeHtml(order.statusTone)}">${escapeHtml(order.status)}</span></td><td>${escapeHtml(order.driver || 'Não atribuído')}</td><td>${escapeHtml(order.fee)}</td><td>${actions(order)}</td></tr>`).join('')}</tbody></table></div>`;
  const chart = model => {
    const rows = Array.isArray(model.dailyVolume) ? model.dailyVolume.slice(-7) : [];
    if (!rows.length) return `<div class="dv2-empty dv2-chart-empty"><strong>Sem dados para o gráfico</strong><span>Os pedidos registrados aparecerão aqui.</span></div>`;
    const max = Math.max(1,...rows.map(row=>Number(row.count)||0));
    return `<div class="dv2-chart" role="img" aria-label="Pedidos por dia">${rows.map(row=>`<div class="dv2-chart-day"><span style="--bar:${Math.max(4,Math.round((Number(row.count)||0)/max*100))}%" title="${escapeHtml(row.count)} pedidos"></span><small>${escapeHtml(String(row.date||'').slice(5))}</small></div>`).join('')}</div>`;
  };
  function render(model = {}) {
    const kpis = Array.isArray(model.kpis) ? model.kpis : [];
    const orders = Array.isArray(model.orders) ? model.orders : [];
    const sources = Array.isArray(model.sources) ? model.sources : [];
    const hasAnalytics = !!model.analyticsAvailable;
    const sourceList = sources.length ? `<ul class="dv2-source-list">${sources.map(row=>`<li><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.count)}</strong></li>`).join('')}</ul>` : `<div class="dv2-empty"><strong>Sem origens registradas</strong><span>Os canais aparecerão quando houver dados.</span></div>`;
    return `<div class="dashboard-v2" data-dashboard-v2>
      <div class="dv2-preview-banner"><span>Prévia visual · leitura</span><button type="button" class="dv2-preview-exit" data-dv2-exit>Voltar ao Início atual</button></div>
      <header class="dv2-header"><div class="dv2-brand"><img src="favicon.svg" alt="" width="36" height="36"><span><strong>RotaMoto</strong><small>Restaurante</small></span></div><div class="dv2-header-actions"><button class="dv2-button dv2-icon-button" type="button" disabled aria-label="Notificações indisponíveis na prévia">${icon('bell')}</button>${model.canCreate ? '<button class="dv2-button dv2-primary dv2-new-race" data-new type="button"><span aria-hidden="true">+</span><span>Nova corrida</span></button>' : ''}</div></header>
      <section class="dv2-greeting"><div><p class="dv2-eyebrow">OPERAÇÃO</p><h1>Olá, ${escapeHtml(model.restaurantName || 'Restaurante')}!</h1><p>Acompanhe as entregas e a operação do dia.</p></div><span class="dv2-connection ${model.connected ? 'is-online' : 'is-pending'}">${icon('online')} ${model.connected ? 'Online' : 'Estado da conexão indisponível'}</span></section>
      <section class="dv2-kpis" aria-label="Indicadores operacionais">${kpis.map(kpi).join('')}</section>
      <div class="dv2-workspace"><section class="dv2-review"><div class="dv2-section-heading"><div><p class="dv2-eyebrow">OPERAÇÃO</p><h2>Entregas para revisar</h2><p>${orders.length ? `${escapeHtml(model.reviewDescription || `${orders.length} entrega(s) aguardam atenção.`)}` : 'Entregas que precisarem de atenção aparecerão aqui.'}</p></div><button type="button" class="dv2-button dv2-all" data-tab="orders">Ver todas <span aria-hidden="true">→</span></button></div>
        ${orders.length ? `<div class="dv2-cards">${orders.map(card).join('')}</div>${table(orders)}` : `<div class="dv2-empty dv2-review-empty"><span class="dv2-empty-mark">✓</span><strong>Nenhuma entrega para revisar</strong><span>Não há entregas que precisem de atenção agora.</span><button type="button" class="dv2-button" data-tab="orders">Abrir pedidos e entregas</button></div>`}
      </section><aside class="dv2-insights"><section class="dv2-panel"><div class="dv2-panel-heading"><div><p class="dv2-eyebrow">VOLUME</p><h2>Pedidos por dia</h2></div><button class="dv2-text-button" data-tab="reports" type="button">Relatórios</button></div>${chart(model)}</section><section class="dv2-panel"><div class="dv2-panel-heading"><div><p class="dv2-eyebrow">CANAIS</p><h2>Origem dos pedidos</h2></div></div>${sourceList}</section><section class="dv2-panel dv2-coverage"><p class="dv2-eyebrow">INDICADORES</p><div><span>Distância real média</span><strong>${hasAnalytics && model.distance != null ? `${escapeHtml(model.distance)} km` : 'Indisponível'}</strong></div><div><span>Repasse registrado</span><strong>${hasAnalytics && model.payout ? escapeHtml(model.payout) : 'Indisponível'}</strong></div></section></aside></div>
      <p class="dv2-footnote">Prévia em modo de leitura. Ações de operação continuam no fluxo atual do aplicativo.</p>
    </div>`;
  }
  window.RotaMotoDashboardV2 = Object.freeze({render});
})();
