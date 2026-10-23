'use strict';
(() => {
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icons = {
    route:'<svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 17c5 0 1-7 8-9"/></svg>',
    waiting:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    done:'<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
    cancel:'<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
    bell:'<svg viewBox="0 0 24 24"><path d="M6 17h12l-1.5-2V10a4.5 4.5 0 0 0-9 0v5L6 17Z"/><path d="M10 20h4"/></svg>',
    plus:'<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    print:'<svg viewBox="0 0 24 24"><path d="M7 8V3h10v5M6 17H4V9h16v8h-2M7 14h10v7H7z"/></svg>',
    qr:'<svg viewBox="0 0 24 24"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM19 14v2M14 19h2M19 19h2v2h-2z"/></svg>',
    online:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>',
    arrow:'<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>'
  };
  const icon = name => `<span class="dv2-icon" aria-hidden="true">${icons[name] || ''}</span>`;
  const fmtDate = value => {
    const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Data indisponível';
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date) : 'Data indisponível';
  };
  const fee = value => value == null || !Number.isFinite(Number(value)) ? 'Não informada' : new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value));
  const distance = value => value == null || !Number.isFinite(Number(value)) || Number(value) < 0 ? 'Não informada' : `${Number(value).toLocaleString('pt-BR',{maximumFractionDigits:1})} km`;
  const kpi = item => `<article class="dv2-kpi dv2-kpi-${escapeHtml(item.tone)}"><span class="dv2-kpi-icon">${icon(item.icon)}</span><span class="dv2-kpi-label">${escapeHtml(item.label)}</span><strong>${item.value == null ? '—' : escapeHtml(item.value)}</strong><small>${escapeHtml(item.detail || 'Indisponível')}</small></article>`;
  const actions = order => {
    const open = order.canOpen ? `<button class="dv2-button dv2-primary" type="button" data-detail="${escapeHtml(order.id)}">Abrir corrida</button>` : `<button class="dv2-button dv2-primary" type="button" disabled title="Seu perfil não tem acesso a pedidos">Abrir corrida</button>`;
    const printLabel = order.printUnavailable || 'Imprimir';
    const print = order.canPrint ? `<button class="dv2-button dv2-icon-button" type="button" data-print-order="${escapeHtml(order.id)}" aria-label="Imprimir pedido #${escapeHtml(order.number)}" title="Imprimir">${icon('print')}</button>` : `<button class="dv2-button dv2-icon-button" type="button" disabled aria-label="${escapeHtml(printLabel)}" title="${escapeHtml(printLabel)}">${icon('print')}</button>`;
    const qr = order.qrEligible ? (order.canQr ? `<button class="dv2-button dv2-icon-button" type="button" data-qr-open="${escapeHtml(order.id)}" aria-label="QR seguro do pedido #${escapeHtml(order.number)}" title="QR seguro">${icon('qr')}</button>` : `<button class="dv2-button dv2-icon-button" type="button" disabled aria-label="Seu perfil não tem acesso a pedidos" title="Seu perfil não tem acesso a pedidos">${icon('qr')}</button>`) : '';
    return `<div class="dv2-actions">${open}${print}${qr}</div>`;
  };
  function renderHeader({variant = 'page', title = '', eyebrow = '', subtitle = '', actions = '', compactTitle = ''} = {}) {
    const brand = `<div class="dv2-brand mobile-brand rm-header-brand"><img class="brand-logo" src="favicon.svg" alt="" width="36" height="36"><span><strong>RotaMoto</strong><small>Restaurante</small></span></div>`;
    if (variant === 'dashboard') return `<header class="rm-global-header topbar rm-page-header dv2-header">${brand}<div class="dv2-header-actions top-actions">${actions}</div></header>`;
    return `<header class="rm-global-header topbar rm-page-header">${brand}<div class="topbar-main"><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1 aria-label="${escapeHtml(title)}"><span class="topbar-title-full">${escapeHtml(title)}</span><span class="topbar-title-compact" aria-hidden="true">${escapeHtml(compactTitle || title)}</span></h1><p>${subtitle}</p></div><div class="top-actions">${actions}</div></header>`;
  }
  function renderNotificationAction({available = true, showUnavailable = false} = {}) {
    if (!available && !showUnavailable) return '';
    const label = available ? 'Abrir eventos e notificações' : 'Seu perfil não tem acesso a eventos';
    return `<button type="button" class="btn rm-notifications-action"${available ? ' data-tab="events"' : ' disabled'} aria-label="${label}" title="${label}">${icon('bell')}</button>`;
  }
  const card = order => `<article class="dv2-delivery-card"><div class="dv2-card-top"><strong>Pedido #${escapeHtml(order.number)}</strong><span class="dv2-status ${escapeHtml(order.statusTone)}">${escapeHtml(order.status)}</span><time>${escapeHtml(fmtDate(order.createdAt))}</time></div><div class="dv2-customer"><strong>${escapeHtml(order.customer || 'Cliente não informado')}</strong><span>${escapeHtml(order.address || 'Endereço não informado')}</span></div><div class="dv2-delivery-meta"><span><small>Origem</small><strong>${escapeHtml(order.source || 'Não informada')}</strong></span><span><small>Motoboy</small><strong>${escapeHtml(order.driver || 'Não atribuído')}</strong></span><span><small>Taxa</small><strong>${escapeHtml(order.fee)}</strong></span><span><small>Distância estimada</small><strong>${escapeHtml(order.distance)}</strong></span></div>${actions(order)}</article>`;
  const table = orders => `<div class="dv2-table-wrap"><table class="dv2-table"><thead><tr><th>Pedido</th><th>Cliente e endereço</th><th>Status</th><th>Origem / motoboy</th><th>Taxa / distância</th><th>Ações</th></tr></thead><tbody>${orders.map(order=>`<tr><td><strong>#${escapeHtml(order.number)}</strong><small>${escapeHtml(fmtDate(order.createdAt))}</small></td><td><strong>${escapeHtml(order.customer || 'Cliente não informado')}</strong><small>${escapeHtml(order.address || 'Endereço não informado')}</small></td><td><span class="dv2-status ${escapeHtml(order.statusTone)}">${escapeHtml(order.status)}</span></td><td><strong>${escapeHtml(order.source || 'Não informada')}</strong><small>${escapeHtml(order.driver || 'Não atribuído')}</small></td><td><strong>${escapeHtml(order.fee)}</strong><small>${escapeHtml(order.distance)}</small></td><td>${actions(order)}</td></tr>`).join('')}</tbody></table></div>`;
  const chart = model => {
    const rows = Array.isArray(model.dailyVolume) ? model.dailyVolume.slice(-7) : [];
    if (!rows.length) return `<div class="dv2-empty dv2-chart-empty"><strong>${escapeHtml(model.analyticsMessage || 'Sem dados para o gráfico')}</strong><span>${escapeHtml(model.analyticsDetail || 'Os pedidos registrados aparecerão aqui.')}</span></div>`;
    const max = Math.max(1,...rows.map(row=>Number(row.count)||0));
    return `<div class="dv2-chart" role="img" aria-label="Pedidos por dia">${rows.map(row=>`<div class="dv2-chart-day"><span style="--bar:${Math.max(4,Math.round((Number(row.count)||0)/max*100))}%" title="${escapeHtml(row.count)} pedidos"></span><small>${escapeHtml(String(row.date||'').slice(5))}</small></div>`).join('')}</div>`;
  };
  function render(model = {}) {
    const kpis = Array.isArray(model.kpis) ? model.kpis : [];
    const orders = Array.isArray(model.orders) ? model.orders : [];
    const sources = Array.isArray(model.sources) ? model.sources : [];
    const hasAnalytics = !!model.analyticsAvailable;
    const sourceList = sources.length ? `<ul class="dv2-source-list">${sources.map(row=>`<li><span>${escapeHtml(row.label)}</span><strong>${escapeHtml(row.count)}</strong></li>`).join('')}</ul>` : `<div class="dv2-empty"><strong>Sem origens registradas</strong><span>Os canais aparecerão quando houver dados.</span></div>`;
    const eventsAction = renderNotificationAction({available:model.canEvents,showUnavailable:true});
    const createAction = model.canCreate ? `<button class="dv2-button dv2-primary dv2-new-race" data-new type="button" aria-label="Nova corrida"><span aria-hidden="true">${icon('plus')}</span><span>Nova corrida</span></button>` : '';
    const allAction = model.canOrders ? `<button type="button" class="dv2-button dv2-all" data-tab="orders">Ver todas <span aria-hidden="true">${icon('arrow')}</span></button>` : `<button type="button" class="dv2-button dv2-all" disabled title="Seu perfil não tem acesso a pedidos">Ver todas</button>`;
    const reportAction = model.canReports ? `<button class="dv2-text-button" data-tab="reports" type="button">Relatórios</button>` : '';
    return `<div class="dashboard-v2" data-dashboard-v2>
      ${renderHeader({variant:'dashboard',actions:`${eventsAction}${createAction}`})}
      <section class="dv2-greeting"><div><p class="dv2-eyebrow">OPERAÇÃO</p><h1>Olá, ${escapeHtml(model.restaurantName || 'Restaurante')}!</h1><p>Acompanhe as entregas e a operação do dia.</p></div><section id="syncStatusPanel" class="dv2-connection-panel" data-state="local" aria-live="polite"><span class="dv2-connection-dot" aria-hidden="true"></span><div><strong data-sync-label>Verificando conexão…</strong><small data-sync-detail>O estado será atualizado após confirmar a sessão e a sincronização.</small></div><button class="dv2-sync-action" type="button" data-sync-now>Atualizar</button></section></section>
      <section class="dv2-kpis" aria-label="Indicadores operacionais">${kpis.map(kpi).join('')}</section>
      <div class="dv2-workspace"><section class="dv2-review"><div class="dv2-section-heading"><div><p class="dv2-eyebrow">OPERAÇÃO</p><h2>Entregas para revisar</h2><p>${orders.length ? escapeHtml(model.reviewDescription || `${orders.length} entrega(s) aguardam atenção.`) : 'Entregas que precisarem de atenção aparecerão aqui.'}</p></div>${allAction}</div>
        ${orders.length ? `<div class="dv2-cards">${orders.map(card).join('')}</div>${table(orders)}` : `<div class="dv2-empty dv2-review-empty"><span class="dv2-empty-mark">✓</span><strong>Nenhuma entrega para revisar</strong><span>Não há entregas que precisem de atenção agora.</span>${model.canOrders ? '<button type="button" class="dv2-button" data-tab="orders">Abrir pedidos e entregas</button>' : ''}</div>`}
      </section><aside class="dv2-insights"><section class="dv2-panel"><div class="dv2-panel-heading"><div><p class="dv2-eyebrow">VOLUME</p><h2>Pedidos por dia</h2></div>${reportAction}</div>${chart(model)}</section><section class="dv2-panel"><div class="dv2-panel-heading"><div><p class="dv2-eyebrow">CANAIS</p><h2>Origem dos pedidos</h2></div></div>${sourceList}</section><section class="dv2-panel dv2-coverage"><p class="dv2-eyebrow">INDICADORES</p><div><span>Distância real média</span><strong>${hasAnalytics && model.distance != null ? `${escapeHtml(model.distance)} km` : 'Indisponível'}</strong></div><small>${hasAnalytics ? escapeHtml(model.distanceCoverage || '') : 'Sem confirmação analítica para a empresa ativa.'}</small><div><span>Repasse registrado</span><strong>${hasAnalytics && model.payout != null ? escapeHtml(model.payout) : 'Indisponível'}</strong></div><small>${hasAnalytics ? escapeHtml(model.payoutCoverage || '') : 'Sem confirmação analítica para a empresa ativa.'}</small></section></aside></div>
    </div>`;
  }
  window.RotaMotoDashboardV2 = Object.freeze({render,renderHeader,renderNotificationAction});
})();
