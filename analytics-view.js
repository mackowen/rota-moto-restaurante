(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RotaMotoAnalyticsView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const brl = value => value == null ? 'Indisponível' : new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
  const currencyName = code => {
    if (code === 'BRL') return 'reais';
    try { return new Intl.DisplayNames('pt-BR', { type: 'currency' }).of(code)?.toLocaleLowerCase('pt-BR') || 'moeda registrada'; }
    catch { return 'moeda registrada'; }
  };
  const metric = (label, value, note = '') => `<div class="metric"><span>${esc(label)}</span><b>${esc(value)}</b>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  function barChart(rows, { label, format = value => String(value), filter = null, cap = 12, emptyState = null } = {}) {
    const visible = rows.filter(row => Number.isFinite(Number(row.value)) && Number(row.value) >= 0).slice(0, cap);
    if (!visible.length) return emptyState?.('Nenhum dado para mostrar', 'Os resultados aparecerão aqui quando houver pedidos no período.', 'chart', 'compact') || '<div class="chart-empty">Não há pedidos para mostrar neste período.</div>';
    const max = Math.max(1, ...visible.map(row => Number(row.value)));
    return `<div class="analytics-bars" role="img" aria-label="${esc(label)}">${visible.map(row => `<button class="analytics-bar-row" ${filter ? `data-${filter}="${esc(row.key)}"` : 'type="button" disabled'} aria-label="${esc(row.label)}: ${esc(format(row.value))}"><span class="analytics-bar-label">${esc(row.label)}</span><span class="analytics-bar-track"><i style="--bar-ratio:${Number(row.value) / max}"></i></span><b>${esc(format(row.value))}</b></button>`).join('')}</div>`;
  }
  const coverageText = (available, total, subject) => total
    ? `${available} de ${total} ${subject} com informação válida (${Math.round(available / total * 100)}%)`
    : `Sem ${subject} neste período`;
  function recurrenceMarkup(report, emptyState) {
    const customerRows = report.customerGroups.map(group => `<div class="analysis-line"><span>${esc(group.label)}</span><b>${group.count} pedido(s)</b></div>`).join('') || emptyState?.('Nenhum cliente neste período', 'Os clientes recorrentes aparecem após o registro de pedidos.', 'bike', 'compact') || '<span class="muted">Nenhum cliente aparece neste período.</span>';
    const addressRows = group => `<div class="analysis-line"><span>${esc(group.label)}</span><b>${group.count} pedido(s) • ${group.drivers.length} motoboy(s)</b></div>`;
    const mainAddresses = report.addressGroups.slice(0, 5).map(addressRows).join('') || emptyState?.('Nenhum endereço neste período', 'Os endereços recorrentes aparecem após o registro de pedidos.', 'route', 'compact') || '<span class="muted">Nenhum endereço aparece neste período.</span>';
    const otherAddresses = report.addressGroups.slice(5).map(addressRows).join('');
    return `<div class="report-detail"><div class="detail-kpi-grid"><div><small>Clientes diferentes (pelo nome)</small><b>${report.distinctCustomerCount}</b></div><div><small>Endereços diferentes</small><b>${report.distinctAddressCount}</b></div></div><div class="report-sections"><section class="card"><h2>Clientes recorrentes</h2><p>Pedidos agrupados pelo nome informado; pessoas com o mesmo nome podem ser diferentes.</p>${customerRows}</section><section class="card"><h2>Endereços mais recorrentes</h2><p>Endereços reunidos pela forma como foram escritos; a lista não representa proximidade no mapa.</p>${mainAddresses}${otherAddresses ? `<details><summary>Ver demais endereços (${report.addressGroups.length - 5})</summary>${otherAddresses}</details>` : ''}</section></div></div>`;
  }

  function render({ report, filters, statusLabel, typeLabel, sources, bikes, types, freshNote, emptyState = null }) {
    const q = filters;
    const ticket = Object.entries(report.orderTicket).map(([currency, value]) => `${new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value.average)} • ${value.count} pedido(s), em ${currencyName(currency)}`).join('; ') || 'Sem pedidos com valor total e moeda confirmados';
    const componentLabels = { itemsSubtotalMinor: 'Subtotal dos itens', discountMinor: 'Descontos', deliveryFeeMinor: 'Taxa de entrega do pedido', serviceFeeMinor: 'Taxa de serviço', otherFeeMinor: 'Outras taxas' };
    const moneyRows = Object.entries(report.moneyComponents || {}).map(([key, value]) => { const [component, currency] = key.split(':'); return metric(`${componentLabels[component] || 'Outro valor registrado'} — ${currencyName(currency)}`, new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(value.total), `${value.count} pedido(s) com esse valor confirmado`); }).join('');
    const typeRows = Object.entries(report.typeCounts).sort((a, b) => b[1] - a[1]).map(([type, count]) => `<div class=\"analysis-line\"><span>${esc(typeLabel(type))}</span><b>${count}</b></div>`).join('') || emptyState?.('Nenhum tipo registrado', 'Os tipos aparecerão quando houver pedidos no período.', 'bag', 'compact') || '<span class=\"muted\">Sem tipos registrados.</span>';
    const sourceRows = Object.entries(report.sourceCounts).sort((a, b) => b[1] - a[1]).map(([key, count]) => `<div class="analysis-line"><span>${esc(sources[key] || 'Outra origem')}</span><b>${count}</b></div>`).join('') || emptyState?.('Nenhuma origem registrada', 'As origens aparecerão quando houver pedidos no período.', 'bag', 'compact') || '<span class="muted">Sem origem registrada.</span>';
    const drivers = Object.values(report.driverCounts).sort((a, b) => b.total - a.total).map(driver => `<div class="analysis-line"><span>${esc(driver.name)}</span><b>${driver.total} pedidos • ${driver.completed} concluídos • ${driver.cancelled} cancelados • ${driver.failed} com falha</b></div>`).join('') || emptyState?.('Nenhum motoboy neste período', 'A atividade da equipe aparecerá após o registro de entregas.', 'bike', 'compact') || '<span class="muted">Nenhum motoboy aparece neste período.</span>';
    const statusRows = Object.entries(report.statusCounts).sort((a, b) => b[1] - a[1]);
    const feeCoverage = coverageText(report.coverage.deliveryFee.available, report.coverage.deliveryFee.total, 'entregas avaliadas');
    const estimateCoverage = coverageText(report.coverage.estimatedDistance.available, report.coverage.estimatedDistance.total, 'entregas com distância estimada');
    const actualCoverage = coverageText(report.coverage.actualDistance.available, report.coverage.actualDistance.total, 'entregas com distância registrada');
    const earningCoverage = coverageText(report.coverage.earning.available, report.coverage.earning.total, 'entregas com repasse');
    const durationRows = Object.entries(report.durations).map(([key, value]) => {
      const labels = { assignedToAccepted: 'Atribuída → aceita', acceptedToPickedUp: 'Aceita → retirada', pickedUpToArrived: 'Retirada → chegada', arrivedToCompleted: 'Chegada → conclusão', assignedToCompleted: 'Atribuída → conclusão' };
      return metric(labels[key], value.average == null ? 'Indisponível' : `${value.average.toFixed(1)} min em média`, value.count ? `Média de ${value.count} etapa(s) com horários completos; ${value.missing} sem dados suficientes.` : 'Não há horários suficientes para calcular esta etapa.');
    }).join('');
    const timezoneBlock = !report.total
      ? emptyState?.('Sem pedidos neste período', 'Os gráficos por horário e dia serão preenchidos quando houver pedidos.', 'chart', 'compact') || '<div class="analysis-note"><b>Sem pedidos neste período</b><span>Os gráficos por horário e dia ficam disponíveis quando houver pedidos.</span></div>'
      : report.timeZone
      ? `<div class="analysis-grid"><section class="analysis-box"><h3>Pedidos por hora</h3><p>Horário local da empresa.</p>${barChart(report.hourlyVolume.map((value, key) => ({ key, label: `${String(key).padStart(2, '0')}:00`, value })), { label: 'Pedidos por hora', emptyState })}</section><section class="analysis-box"><h3>Pedidos por dia da semana</h3><p>Horário local da empresa.</p>${barChart(report.weekdayVolume.map((value, key) => ({ key, label: ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'][key], value })), { label: 'Pedidos por dia da semana', emptyState })}</section></div><section class="card"><h2>Pedidos por dia</h2><p>Data de criação no horário local da empresa.</p>${barChart(report.dailyVolume.map(row => ({ key: row.date, label: row.date, value: row.count })), { label: 'Pedidos por dia', cap: 31, emptyState })}</section>`
      : '<div class="analysis-note"><b>Pedidos por hora e dia indisponíveis</b><span>Defina o fuso horário da empresa em Administração para organizar os pedidos pelo horário local.</span></div>';
    const feeAverage = report.deliveryFees.average == null ? 'Indisponível' : brl(report.deliveryFees.average);
    const sourceOptions = [...new Set([...Object.keys(sources), ...Object.keys(report.sourceCounts)])];

    const estimateAverage = report.estimatedDistance.average == null ? 'Indisponível' : `${report.estimatedDistance.average.toFixed(2)} km`;
    const actualAverage = report.actualDistance.average == null ? 'Indisponível' : `${report.actualDistance.average.toFixed(2)} km`;
    const statusChart = barChart(statusRows.map(([key, value]) => ({ key, label: statusLabel(key), value })), { label: 'Entregas por status', filter: 'status-filter', emptyState });
    const sourceChart = barChart(Object.entries(report.sourceCounts).sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, label: sources[key] || key, value })), { label: 'Pedidos por origem comercial', filter: 'source-filter', emptyState });
    const statusCoverage = report.completionRate == null
      ? 'Não foi possível calcular a proporção de entregas concluídas com os dados disponíveis.'
      : `${report.completedCount} de ${report.knownStatusCount} entregas com informação suficiente foram concluídas (${Math.round(report.completionRate * 100)}%). Esta comparação não mede prazo de atendimento.`;
    const orderCoverage = report.coverage.orderAmount.total
      ? `${report.coverage.orderAmount.available} de ${report.coverage.orderAmount.total} pedidos têm valor e moeda confirmados; ${report.coverage.orderAmount.complete} têm a composição completa. Valores sem confirmação ficam fora da média.`
      : 'Sem pedidos com valores registrados neste período.';
    const periodBasis = !report.total
      ? 'Nenhum pedido foi registrado no período selecionado.'
      : report.timeZone
      ? 'As datas seguem o horário local da empresa.'
      : 'O horário local da empresa não foi definido; gráficos por hora e dia ficam indisponíveis.';
    const dateNote = report.invalidCreatedAt
      ? `${report.invalidCreatedAt} pedido(s) sem data válida ou fora do período não entraram neste recorte.`
      : 'O período considera a data de criação do pedido.';
    return `<section class="card">
      <div class="report-filter-head"><div><span class="eyebrow">Período</span><h2>Filtros do relatório</h2><p>${periodBasis} A origem indica o canal de venda.</p></div><button class="btn small" data-report-clear>Limpar filtros</button></div>
      <div class="filterbar reportfilters"><label>Período<select id="rp" class="select">${[['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['365', 'Últimos 12 meses']].map(([v, label]) => `<option value="${v}" ${q.period === v ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Motoboy<select id="rb" class="select"><option value="">Todos</option>${bikes.map(b => `<option value="${esc(b.name)}" ${q.bike === b.name ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label><label>Status<select id="rs" class="select"><option value="">Todos</option>${Object.keys(report.statusCounts).map(status => `<option value="${esc(status)}" ${q.status === status ? 'selected' : ''}>${esc(statusLabel(status))}</option>`).join('')}</select></label><label>Tipo<select id="rt" class="select"><option value="">Todos</option>${types.map(type => `<option value="${esc(type)}" ${q.type === type ? 'selected' : ''}>${esc(typeLabel(type))}</option>`).join('')}</select></label><label>Origem do pedido<select id="ro" class="select"><option value="">Todas</option>${sourceOptions.map(source => `<option value="${esc(source)}" ${q.source === source ? 'selected' : ''}>${esc(sources[source] || 'Outra origem')}</option>`).join('')}</select></label></div>
    </section>
    <section class="card report-kpi-panel" aria-label="Resumo das entregas"><div class="section-head"><div><h2>Resumo das entregas</h2><p>Quantidade de pedidos por situação no período.</p></div></div><div class="grid kpis report-kpis">${metric('Pedidos no período', String(report.total), dateNote)}${metric('Entregues', String(report.completedCount), 'Pedidos com entrega concluída')}${metric('Cancelados', String(report.cancelledCount), 'Pedidos cancelados')}${metric('Com falha', String(report.failedCount), 'Entregas que não puderam ser concluídas')}${metric('Devolvidos', String(report.returnedCount), 'Entregas retornadas')}${metric('Em andamento', String(report.openCount), 'Entregas ainda não concluídas')}</div></section>
    <div class="report-sections report-finance">
      <section class="card"><span class="eyebrow">Vendas</span><h2>Valores dos pedidos</h2>${metric('Valor médio dos pedidos com total confirmado', ticket, orderCoverage)}${moneyRows || (emptyState?.('Nenhum valor detalhado', 'Valores confirmados aparecerão aqui quando forem registrados.', 'chart', 'compact') || '<div class="analysis-note">Nenhum valor detalhado foi registrado neste período.</div>')}</section>
      <section class="card"><span class="eyebrow">Taxas</span><h2>Taxas de entrega</h2>${metric('Total de taxas em entregas concluídas (R$)', report.deliveryFees.count ? brl(report.deliveryFees.total) : 'Indisponível', feeCoverage)}${metric('Média por entrega concluída (R$)', feeAverage, 'Calculada apenas com taxas registradas em reais.')}</section>
      <section class="card"><span class="eyebrow">Repasses</span><h2>Valores registrados para motoboys</h2>${metric('Total de repasses (R$)', report.driverPayout.count ? brl(report.driverPayout.total) : 'Indisponível', earningCoverage)}${metric('Média por entrega com repasse (R$)', brl(report.driverPayout.average), 'Não inclui outros custos da operação.')}</section>
    </div>
    <div class="report-sections"><section class="card"><span class="eyebrow">Operação</span><h2>Distâncias e tempos</h2><p>Os valores ausentes não são tratados como zero.</p>${metric('Distância estimada — média', estimateAverage, estimateCoverage)}${metric('Distância estimada — total', report.estimatedDistance.total == null ? 'Indisponível' : `${report.estimatedDistance.total.toFixed(2)} km`, `${report.estimatedDistance.count} registro(s) válido(s)`)}${metric('Distância registrada — média', actualAverage, actualCoverage)}${metric('Distância registrada — total', report.actualDistance.total == null ? 'Indisponível' : `${report.actualDistance.total.toFixed(2)} km`, `${report.actualDistance.count} registro(s) válido(s)`)}${durationRows}</section><section class="card"><h2>Status das entregas</h2><p>Mostra o estado atual de cada entrega.</p>${statusChart}</section></div>
    <div class="report-sections"><section class="card"><h2>Origem dos pedidos</h2><p>Canal em que o pedido foi recebido.</p>${sourceChart}</section><section class="card"><h2>Tipos de entrega</h2><p>Classificação informada no pedido.</p>${typeRows}</section></div>
    <section class="card"><div class="section-head"><div><h2>Entregas por motoboy</h2><p>Agrupadas pelo vínculo disponível no pedido; registros antigos identificados apenas pelo nome podem reunir pessoas diferentes.</p></div></div>${drivers}</section>
    ${recurrenceMarkup(report, emptyState)}${timezoneBlock}
    <section class="card"><div class="section-head"><div><h2>Atualização dos dados</h2><p>${esc(freshNote)} Valores ausentes não são apresentados como zero.</p></div><button class="btn" data-export-report>Exportar CSV</button></div><div class="metric"><span>Conclusão das entregas</span><b>${report.completionRate == null ? 'Indisponível' : `${(report.completionRate * 100).toFixed(1)}%`}</b><small>${statusCoverage}</small></div></section>`;
  }
  return Object.freeze({ render });
});
