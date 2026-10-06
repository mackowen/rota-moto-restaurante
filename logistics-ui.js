(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const api = async (path, method = 'GET', body) => {
    const headers = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = window.RotaMotoSessionGuard?.getCsrfToken?.() || window.__rotamotoCsrfToken || '';
    }
    const base = String(window.ROTA_MOTO_API_BASE || '/api').replace(/\/$/u, '');
    const response = await fetch(`${base}${path}`, { method, credentials: 'include', cache: 'no-store', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let result = {};
    try { result = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(result.error?.code || 'LOGISTICS_REQUEST_FAILED');
    return result;
  };
  const card = html => `<div class="card">${html}</div>`;
  const moneyByCurrency = rows => {
    const totals = new Map();
    for (const row of rows || []) totals.set(row.currency, (totals.get(row.currency) || 0) + Number(row.amountMinor));
    return [...totals].map(([currency, minor]) => {
      const scale = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
      return `${esc(currency)} ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(minor / (10 ** scale))}`;
    }).join(' · ') || 'Desconhecido';
  };
  const formatCost = cost => {
    const scale = new Intl.NumberFormat('en', { style: 'currency', currency: cost.currency }).resolvedOptions().maximumFractionDigits;
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cost.currency }).format(cost.amountMinor / (10 ** scale));
  };
  let currentState = null;
  let currentContext = null;
  function settingsPanel() {
    return card('<div class="setting-heading"><h2>Providers logísticos</h2><p>Cadastre providers para atribuição manual. O modo operacional desta tela é MANUAL; nenhuma plataforma é chamada. O adapter iFood isolado ainda não está ligado ao fluxo de despacho.</p></div><div class="actions"><button class="btn primary" type="button" data-logistics-add>Cadastrar parceiro</button><button class="btn" type="button" data-logistics-refresh>Atualizar</button></div><div id="logistics-provider-list"><span class="muted">Carregando…</span></div>');
  }
  function providerList(root, data) {
    root.innerHTML = (data.providers || []).map(p => {
      const apiState = p.code === 'ifood' ? 'API NÃO CONFIGURADA · adapter isolado, sem worker/credencial/homologação' :
        ['99food', 'keeta'].includes(p.code) ? 'API BLOQUEADA · capability logística não documentada' : 'API INDISPONÍVEL · sem adapter validado';
      return `<article class="logistics-provider-card"><div><b>${esc(p.displayName)}</b><small>${p.class === 'internal_fleet' ? 'Frota própria' : p.class === 'marketplace' ? 'Marketplace' : 'Parceiro'} · ${p.enabled ? 'Ativo' : 'Desativado'}</small><small>Modo operacional: MANUAL · capabilities: ${esc((p.capabilities || []).join(', ') || 'nenhuma')}</small><small>${esc(apiState)}</small><small>${esc(p.code)}</small></div>${p.class === 'internal_fleet' ? '' : `<div class="actions"><button class="btn small" data-logistics-edit="${esc(p.id)}" data-version="${Number(p.version)}" data-name="${esc(p.displayName)}" data-instructions="${esc(p.configuration?.dispatchInstructions || '')}" data-portal="${esc(p.configuration?.portalUrl || '')}">Editar</button><button class="btn small" data-logistics-toggle="${esc(p.id)}" data-version="${Number(p.version)}" data-enabled="${p.enabled}">${p.enabled ? 'Desativar' : 'Ativar'}</button></div>`}</article>`;
    }).join('') || '<div class="empty">Nenhum provider cadastrado.</div>';
    root.querySelectorAll('[data-logistics-toggle]').forEach(button => button.addEventListener('click', async () => {
      try { await api(`/logistics/providers/${encodeURIComponent(button.dataset.logisticsToggle)}`, 'PATCH', { expectedVersion: Number(button.dataset.version), enabled: button.dataset.enabled !== 'true' }); loadProviders(); }
      catch (_) { window.RotaMotoApp?.toast?.('Provider alterado por outra sessão ou operação não autorizada.','error'); }
    }));
    root.querySelectorAll('[data-logistics-edit]').forEach(button => button.addEventListener('click', () => editProvider(button)));
  }
  function editProvider(button) {
    window.RotaMotoApp?.modal?.(`<h2>Editar provider</h2><form id="logistics-edit-form" class="formgrid"><label>Nome<input class="input" name="displayName" maxlength="120" required value="${esc(button.dataset.name)}"></label><label>Portal HTTPS<input class="input" name="portalUrl" type="url" maxlength="512" value="${esc(button.dataset.portal)}"></label><label class="full">Instruções de despacho manual<textarea class="input" name="dispatchInstructions" maxlength="500">${esc(button.dataset.instructions)}</textarea></label><p class="full">Segredos e credenciais não podem ser informados aqui.</p><div class="actions full"><button class="btn" type="button" data-logistics-close>Cancelar</button><button class="btn primary">Salvar</button></div></form>`);
    const form = document.querySelector('#logistics-edit-form');
    if (!form) return;
    form.onsubmit = async event => { event.preventDefault(); const fields = new FormData(form); try {
      await api(`/logistics/providers/${encodeURIComponent(button.dataset.logisticsEdit)}`, 'PATCH', {
        expectedVersion: Number(button.dataset.version), displayName: fields.get('displayName'),
        configuration: { dispatchInstructions: fields.get('dispatchInstructions'), portalUrl: fields.get('portalUrl') }
      }); window.RotaMotoApp?.closeModal?.(); loadProviders();
    } catch (_) { window.RotaMotoApp?.toast?.('Não foi possível salvar. Verifique a revisão e a URL HTTPS.','error'); } };
    document.querySelector('[data-logistics-close]')?.addEventListener('click', () => window.RotaMotoApp?.closeModal?.());
  }
  async function loadProviders() {
    const root = document.querySelector('#logistics-provider-list'); if (!root) return;
    root.textContent = 'Carregando…';
    try { await api('/logistics/internal-provider', 'POST', {}); providerList(root, await api('/logistics/providers')); }
    catch (_) { root.textContent = 'Requer sessão administrativa autorizada e migration 0017 aplicada.'; }
  }
  function newProvider() {
    window.RotaMotoApp?.modal?.('<h2>Novo provider logístico</h2><form id="logistics-provider-form" class="formgrid"><label>Nome<input class="input" name="displayName" maxlength="120" required></label><label>Código estável<input class="input" name="code" pattern="[a-z][a-z0-9_-]{1,63}" required></label><label>Classe<select class="select" name="class"><option value="partner">Parceiro</option><option value="marketplace">Marketplace</option></select></label><label>Estado<select class="select" name="enabled"><option value="true">Ativo</option><option value="false">Desativado</option></select></label><p class="full">Modo MANUAL: manual_assignment. O adapter iFood está isolado e coberto por mocks, mas não foi ligado ao despacho operacional. Quote, tracking e cancelamento remoto ainda não estão disponíveis nesta tela.</p><div class="actions full"><button class="btn" type="button" data-logistics-close>Cancelar</button><button class="btn primary">Cadastrar</button></div></form>');
    if (!document.querySelector('#logistics-provider-form')) return;
    document.querySelector('#logistics-provider-form').onsubmit = async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      try { await api('/logistics/providers', 'POST', { displayName: form.get('displayName'), code: String(form.get('code')).toLowerCase(), class: form.get('class'), enabled: form.get('enabled') === 'true', configuration: {} }); window.RotaMotoApp?.closeModal?.(); window.RotaMotoApp?.render?.(); loadProviders(); }
      catch (_) { window.RotaMotoApp?.toast?.('Não foi possível cadastrar; confirme a permissão administrativa e o código.','error'); }
    };
    document.querySelector('[data-logistics-close]')?.addEventListener('click', () => window.RotaMotoApp?.closeModal?.());
  }
  async function toggleProvider(button) {
    try { await api(`/logistics/providers/${encodeURIComponent(button.dataset.logisticsToggle)}`, 'PATCH', { expectedVersion: Number(button.dataset.version), enabled: button.dataset.enabled !== 'true' }); await loadProviders(); }
    catch (_) { window.RotaMotoApp?.toast?.('Provider alterado por outra sessão ou operação não autorizada.','error'); }
  }
  async function renderReport() {
    const root = document.querySelector('#fulfillment-analytics'); if (!root) return;
    try {
      const [data] = await Promise.all([api('/logistics/analytics')]);
      root.innerHTML = `<h3>Operação logística</h3>${data.providers.length ? data.providers.map(p => `<div class="report-row"><b>${esc(p.displayName)}</b><span>${p.class === 'internal_fleet' ? 'Frota própria' : p.class === 'marketplace' ? 'Marketplace externo' : 'Parceiro externo'} · ${p.allocations} alocações (${p.internal} internas, ${p.external} externas) · ${p.completed} concluídas</span><small>Custo estimado conhecido: ${moneyByCurrency(p.estimatedCosts)} · cobertura ${p.estimatedCostCount}/${p.allocations}</small><small>Custo reconciliado conhecido: ${moneyByCurrency(p.reconciledCosts)} · cobertura ${p.reconciledCostCount}/${p.allocations}</small></div>`).join('') : '<p class="muted">Sem alocações registradas.</p>'}<small>Valores conhecidos por moeda, sem conversão. São custos informados da logística; não representam custo total do negócio. Origem comercial do pedido é uma dimensão separada.</small>`;
    } catch (_) { root.textContent = 'Resumo de fulfillment disponível para sessão administrativa autorizada.'; }
    loadTerritorialReport();
  }
  function reportQuery() {
    const state = currentState || {}, q = state.report || {};
    const params = new URLSearchParams({ period: String(q.period || 30), metric: q.territorialMetric || 'volume' });
    for (const [key, value] of Object.entries({ status:q.status, source:q.source, type:q.type, mode:q.fulfillmentMode, providerId:q.providerId })) if (value) params.set(key, value);
    const selectedBike=(currentState?.bikes||[]).find(row=>row.name===q.bike || row.id===q.bike || row.canonicalId===q.bike);
    const driver = String(selectedBike?.sync?.canonicalId||selectedBike?.canonicalId||selectedBike?.id||'');
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(driver)) params.set('driverId', driver);
    return params.toString();
  }
  function hasUnresolvedDriverFilter() {
    const selected=String(currentState?.report?.bike||'');
    if(!selected)return false;
    const bike=(currentState?.bikes||[]).find(row=>row.name===selected||row.id===selected||row.canonicalId===selected);
    const id=String(bike?.sync?.canonicalId||bike?.canonicalId||bike?.id||'');
    return !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
  }
  function heatmapMarkup(data) {
    const cells = data.cells || [];
    const view = cells.length ? (() => {
      const lats=cells.map(c=>c.latitude), lons=cells.map(c=>c.longitude), minLat=Math.min(...lats),maxLat=Math.max(...lats),minLon=Math.min(...lons),maxLon=Math.max(...lons);
      const x=v=>maxLon===minLon?50:8+(v-minLon)/(maxLon-minLon)*84, y=v=>maxLat===minLat?50:92-(v-minLat)/(maxLat-minLat)*84;
      return `<svg class="territorial-map" viewBox="0 0 100 100" role="img" aria-label="Mapa agregado por células geográficas">${cells.map(c=>`<circle cx="${x(c.longitude).toFixed(2)}" cy="${y(c.latitude).toFixed(2)}" r="${c.intensity===3?5:c.intensity===2?3.8:2.8}" class="territorial-cell intensity-${c.intensity}"><title>Célula ${esc(c.cell)} · ${esc(c.countBand)} entregas</title></circle>`).join('')}</svg>`;
    })() : '<div class="territorial-empty">Sem células com amostra mínima neste recorte.</div>';
    const rows = cells.map(c => `<tr><td>${esc(c.cell)}</td><td>${esc(c.countBand)}</td><td>${c.completed == null ? '—' : c.completed}</td><td>${c.cancelled == null ? '—' : c.cancelled}</td><td>${c.failed == null ? '—' : c.failed}</td><td>${c.averageDurationMinutes == null ? '—' : `${c.averageDurationMinutes.toFixed(1)} min`}</td><td>${c.averageActualDistanceKm == null ? '—' : `${c.averageActualDistanceKm.toFixed(2)} km`}</td><td>${c.averageEstimatedDistanceKm == null ? '—' : `${c.averageEstimatedDistanceKm.toFixed(2)} km`}</td><td>${c.averageDeliveryFeeBRL == null ? '—' : `R$ ${c.averageDeliveryFeeBRL.toFixed(2)}`}</td><td>${c.internalFleet == null ? '—' : c.internalFleet}/${c.external == null ? '—' : c.external}</td><td>${(c.providers||[]).map(p=>`${esc(p.code)} (${esc(p.countBand)})`).join(', ')||'—'}</td></tr>`).join('');
    const percent = data.coverage == null ? 'indisponível' : `${(data.coverage*100).toFixed(1)}%`;
    const q=currentState?.report||{};
    return `<div class="section-head"><div><span class="eyebrow">Território</span><h2>Heatmap histórico de entregas</h2><p>Somente destinos confirmados; célula geográfica de aproximadamente 5 km e limiar mínimo de cinco entregas. Período: últimos ${Number(data.period)} dias${data.timeZone?` (${esc(data.timeZone)})`:''}.</p></div><button class="btn small" data-territorial-refresh>Atualizar</button></div><div class="territorial-filterbar"><label>Intensidade<select class="select" data-territorial-metric><option value="volume" ${data.metric==='volume'?'selected':''}>Volume</option><option value="delivery_fee" ${data.metric==='delivery_fee'?'selected':''}>Taxa média BRL</option><option value="duration" ${data.metric==='duration'?'selected':''}>Tempo médio</option><option value="actual_distance" ${data.metric==='actual_distance'?'selected':''}>Distância real média</option><option value="estimated_distance" ${data.metric==='estimated_distance'?'selected':''}>Distância estimada média</option></select></label><label>Execução<select class="select" data-territorial-mode><option value="" ${!q.fulfillmentMode?'selected':''}>Frota própria e terceiros</option><option value="internal" ${q.fulfillmentMode==='internal'?'selected':''}>Frota própria</option><option value="external" ${q.fulfillmentMode==='external'?'selected':''}>Terceiros</option></select></label><label>Provider<select class="select" data-territorial-provider><option value="" ${!q.providerId?'selected':''}>Todos</option>${(data.providerFilters||[]).map(p=>`<option value="${esc(p.id)}" ${q.providerId===p.id?'selected':''}>${esc(p.code)}</option>`).join('')}</select></label></div><div class="territorial-coverage"><b>${data.withLocation}/${data.totalEligible} com destino (${percent})</b><span>${data.withoutLocation} sem localização utilizável (${data.lowPrecision} com precisão acima de ${data.maximumMapAccuracyM} m) · ${data.suppressedCells} célula(s) suprimida(s) por amostra baixa</span></div>${view}<div class="territorial-legend"><span><i class="intensity-1"></i> menor</span><span><i class="intensity-2"></i> intermediária</span><span><i class="intensity-3"></i> maior</span><span>Em volume: bandas 5–9, 10–24 e 25+. Métricas por célula abaixo de cinco amostras são ocultadas.</span></div><div class="table-scroll"><table class="territorial-table"><thead><tr><th>Célula</th><th>Volume</th><th>Concluídas</th><th>Canceladas</th><th>Falhas</th><th>Tempo médio</th><th>Distância real</th><th>Distância estimada</th><th>Taxa média</th><th>Própria/terceiro</th><th>Provider</th></tr></thead><tbody>${rows||'<tr><td colspan="11">Sem dados agregados.</td></tr>'}</tbody></table></div><small>Mapa server-side agregado. Endereço, cliente, GPS individual e conteúdo de pedidos não são retornados. Geohash ${esc(data.algorithm)}; leitura local/offline não apresenta pontos geográficos crus.</small>${destinationEntryMarkup()}`;
  }
  function destinationEntryMarkup() {
    if (!currentContext?.session?.permissions?.includes('company.manage')) return '';
    const orders = currentState.orders || [], deliveries = currentState.deliveries || [];
    const options = orders.filter(order=>!order.deleted&&!order.deletedAt).map(order=>{
      const delivery=deliveries.find(row=>row.orderId===order.id || row.id===order.deliveryId);
      const id=delivery?.sync?.canonicalId||delivery?.canonicalId||delivery?.id;
      return id ? `<option value="${esc(id)}">#${esc(order.num||order.id)} · ${esc(order.status||'')}</option>` : '';
    }).filter(Boolean).join('');
    return `<details class="territorial-location-entry"><summary>Registrar destino manualmente confirmado</summary><p>Use coordenadas obtidas e conferidas por operador autorizado. Não use GPS do motorista nem geocodifique endereço durante o relatório.</p><form data-destination-form class="formgrid"><label class="full">Entrega<select name="deliveryId" class="select" required>${options||'<option value="">Nenhuma Delivery canônica local</option>'}</select></label><input type="hidden" name="expectedVersion" value="0"><label>Latitude<input class="input" name="latitude" type="number" step="any" min="-90" max="90" required></label><label>Longitude<input class="input" name="longitude" type="number" step="any" min="-180" max="180" required></label><label>Precisão conhecida (m)<input class="input" name="accuracyM" type="number" min="0" max="100000" step="any"></label><label class="full"><span><input type="checkbox" name="confirmDestination" required> Confirmo que o ponto representa o destino desta entrega.</span></label><div class="actions full"><button class="btn primary" ${options?'':'disabled'}>Salvar snapshot de destino</button><span data-destination-status role="status"></span></div></form></details>`;
  }
  async function loadTerritorialReport() {
    const root=document.querySelector('#territorial-heatmap'); if(!root)return;
    if(hasUnresolvedDriverFilter()) { root.innerHTML='<h2>Heatmap histórico</h2><p class="muted">O filtro de motoboy ainda não tem identificador canônico. Sincronize os dados e tente novamente; nenhum agregado sem filtro foi consultado.</p>'; return; }
    root.textContent='Carregando agregados territoriais…';
    try { const data=await api(`/analytics/territorial?${reportQuery()}`); if(!document.querySelector('#territorial-heatmap'))return; root.innerHTML=heatmapMarkup(data); bindTerritorial(root); }
    catch(error){ root.innerHTML=`<h2>Heatmap histórico</h2><p class="muted">${error.message==='RECORTE_LIMIT_EXCEEDED'?'Reduza o período ou aplique filtros.':'Agregados territoriais indisponíveis. Verifique sessão, permissão e migration 0018.'}</p>${destinationEntryMarkup()}`; bindTerritorial(root); }
  }
  function bindTerritorial(root) {
    root.querySelector('[data-territorial-refresh]')?.addEventListener('click',loadTerritorialReport);
    const updateFilter=()=>{currentState.report={...(currentState.report||{}),territorialMetric:root.querySelector('[data-territorial-metric]')?.value||'volume',fulfillmentMode:root.querySelector('[data-territorial-mode]')?.value||'',providerId:root.querySelector('[data-territorial-provider]')?.value||''};loadTerritorialReport();};
    root.querySelector('[data-territorial-metric]')?.addEventListener('change',updateFilter);
    root.querySelector('[data-territorial-mode]')?.addEventListener('change',updateFilter);
    root.querySelector('[data-territorial-provider]')?.addEventListener('change',updateFilter);
    const form=root.querySelector('[data-destination-form]');
    const updateVersion=async()=>{const deliveryId=form?.elements.deliveryId?.value;if(!deliveryId)return;try{const value=await api(`/analytics/territorial/deliveries/${encodeURIComponent(deliveryId)}/destination`);form.elements.expectedVersion.value=String(value.version||0);}catch(_){form.elements.expectedVersion.value='-1';}};
    form?.elements.deliveryId?.addEventListener('change',()=>{if(form.elements.latitude)form.elements.latitude.value='';if(form.elements.longitude)form.elements.longitude.value='';if(form.elements.accuracyM)form.elements.accuracyM.value='';if(form.elements.confirmDestination)form.elements.confirmDestination.checked=false;updateVersion()});if(form)updateVersion();
    root.querySelector('[data-destination-form]')?.addEventListener('submit',async event=>{
      event.preventDefault(); const form=event.currentTarget,fields=new FormData(form),status=form.querySelector('[data-destination-status]');
      if(status)status.textContent='Salvando…';
      try { await api(`/analytics/territorial/deliveries/${encodeURIComponent(fields.get('deliveryId'))}/destination`,'PUT',{latitude:Number(fields.get('latitude')),longitude:Number(fields.get('longitude')),accuracyM:fields.get('accuracyM')===''?null:Number(fields.get('accuracyM')),confirmDestination:fields.get('confirmDestination')==='on',expectedVersion:Number(fields.get('expectedVersion'))}); if(status)status.textContent='Destino confirmado e salvo.'; await loadTerritorialReport(); }
      catch(_){ if(status)status.textContent='Não foi possível salvar. Confirme permissão administrativa e Delivery canônica.'; }
    });
  }
  function openDelivery(deliveryId, context) {
    if (!deliveryId) return window.RotaMotoApp?.toast?.('Sincronize a entrega antes de configurar fulfillment.','error');
    window.RotaMotoApp?.modal?.('<h2>Fulfillment logístico</h2><div id="logistics-fulfillment">Carregando estado canônico…</div>');
    loadDelivery(deliveryId, context);
  }
  async function loadDelivery(deliveryId, context) {
    const root = document.querySelector('#logistics-fulfillment'); if (!root) return;
    try {
      await api('/logistics/internal-provider', 'POST', {});
      const [providers, data] = await Promise.all([api('/logistics/providers'), api(`/logistics/deliveries/${encodeURIComponent(deliveryId)}/fulfillment`)]);
      if (!document.querySelector('#logistics-fulfillment')) return;
      const active = data.fulfillments.find(item => ['selected','dispatch_requested','accepted','in_progress','arrived','completed'].includes(item.status));
      const nextStatuses = ({ selected: ['failed','cancelled'], dispatch_requested: ['accepted','in_progress','failed','cancelled'],
        accepted: ['in_progress','arrived','completed','failed','cancelled'], in_progress: ['arrived','completed','failed'],
        arrived: ['completed','failed'], completed: [] })[active?.status] || [];
      const eligible = providers.providers.filter(p => p.enabled && (active?.mode === 'internal' ? p.class === 'internal_fleet' : active?.mode === 'external' ? p.class !== 'internal_fleet' : true));
      const drivers = (context.state.bikes || []).filter(b => !b.deleted && !b.deletedAt);
      const providerName = item => (providers.providers.find(p => p.id === item.providerId) || {}).displayName || 'Provider indisponível';
      const fulfillmentHistory = data.fulfillments.map(item => `<li>${item.mode === 'internal' ? 'Frota própria' : 'Externo'} · ${esc(providerName(item))} · ${esc(item.status)} · revisão ${item.revision}${item.etaAt ? ` · ETA ${esc(new Date(item.etaAt).toLocaleString())}` : ''}${item.estimatedCost ? ` · estimado ${esc(formatCost(item.estimatedCost))}` : ''}${item.finalCost ? ` · reconciliado ${esc(formatCost(item.finalCost))}` : ''}${item.mode === 'internal' && item.driverId ? ` · Driver ${esc(item.driverId)}` : ''}${item.mode === 'external' && item.externalReference ? ` · ref. ${esc(item.externalReference)}` : ''}</li>`).join('');
      const attemptHistory = data.attempts.map(item => `<li>Registro manual ${esc(item.status)} · ${esc(providerName({ providerId: item.providerId }))} · ${esc(new Date(item.requestedAt).toLocaleString())}${item.externalReference ? ` · ref. ${esc(item.externalReference)}` : ''}</li>`).join('');
      root.innerHTML = `<div class="detail-state-field"><span>Origem comercial</span><strong>${esc(data.delivery.orderSource || 'Desconhecida')}</strong><small>A origem comercial identifica o canal do pedido; não define o responsável logístico.</small></div><div class="detail-state-field"><span>Responsável logístico</span><strong>${esc(data.delivery.status)} · ${active ? `${active.mode === 'internal' ? 'Interno · frota própria' : 'Externo'} · ${esc(providerName(active))} · ${esc(active.status)}` : 'Sem provider selecionado'}</strong><small>${active?.mode === 'internal' ? `Driver: ${esc(data.delivery.driverId || 'não atribuído')}` : active?.mode === 'external' ? 'Provider externo; não há Driver interno associado.' : 'Driver não aplicável até selecionar frota própria.'}</small></div>${fulfillmentHistory ? `<details><summary>Histórico de alocações</summary><ul>${fulfillmentHistory}</ul></details>` : ''}${attemptHistory ? `<details><summary>Registros de despacho manual</summary><ul>${attemptHistory}</ul></details>` : ''}<form id="fulfillment-select" class="formgrid"><label>Execução<select class="select" name="mode"><option value="internal" ${active?.mode === 'internal' ? 'selected' : ''}>Frota própria</option><option value="external" ${active?.mode === 'external' ? 'selected' : ''}>Responsável externo</option></select></label><label>Provider<select class="select" name="providerId">${providers.providers.filter(p => p.enabled).map(p => `<option value="${esc(p.id)}" ${active?.providerId === p.id ? 'selected' : ''}>${esc(p.displayName)} (${esc(p.class)})</option>`).join('')}</select></label><label data-driver-wrap>Motoboy<select class="select" name="driverId"><option value="">Selecione</option>${drivers.map(b => `<option value="${esc(b.sync?.canonicalId || b.canonicalId || b.id)}" ${active?.driverId === (b.sync?.canonicalId || b.canonicalId || b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label><label>Referência externa<input class="input" maxlength="160" name="externalReference" value="${esc(active?.externalReference || '')}"></label><label>ETA conhecido<input class="input" type="datetime-local" name="etaAt" value="${active?.etaAt ? esc(new Date(active.etaAt).toISOString().slice(0,16)) : ''}"></label><label>Custo estimado (centavos)<input class="input" type="number" min="0" step="1" name="estimatedCostMinor" value="${active?.estimatedCost?.amountMinor ?? ''}"></label><label>Moeda<input class="input" maxlength="3" name="estimatedCostCurrency" value="${esc(active?.estimatedCost?.currency || '')}" placeholder="BRL"></label><div class="actions full"><button class="btn primary" ${active?.status === 'completed' ? 'disabled' : ''}>${active ? 'Trocar responsável logístico' : 'Selecionar responsável'}</button></div></form>${active?.mode === 'external' ? `<p>Registro manual somente. Nenhuma API externa será chamada.</p><div class="actions"><button class="btn" type="button" data-dispatch-request ${active.status === 'completed' ? 'disabled' : ''}>Registrar despacho manual</button></div><form id="fulfillment-progress" class="formgrid"><label>Estado externo confirmado<select class="select" name="status">${nextStatuses.map(status => `<option value="${status}" ${active.status === status ? 'selected' : ''} ${active.status === 'completed' ? 'disabled' : ''}>${status}</option>`).join('')}</select></label><label>Custo final reconciliado (centavos)<input class="input" type="number" min="0" step="1" name="finalCostMinor"></label><label>Moeda<input class="input" maxlength="3" name="finalCostCurrency" value="${esc(active.finalCost?.currency || '')}" placeholder="BRL"></label><div class="actions full"><button class="btn">Salvar estado/reconciliação</button></div></form>` : ''}<div class="actions"><button class="btn" type="button" data-logistics-close>Fechar</button></div>`;
      const form = document.querySelector('#fulfillment-select'), mode = form.elements.mode;
      const filterProviders = () => { const internal = mode.value === 'internal'; form.querySelector('[data-driver-wrap]').hidden = !internal; form.elements.driverId.required = internal; const allowed = providers.providers.filter(p => p.enabled && (internal ? p.class === 'internal_fleet' : p.class !== 'internal_fleet')); form.elements.providerId.innerHTML = allowed.map(p => `<option value="${esc(p.id)}" ${active?.providerId === p.id ? 'selected' : ''}>${esc(p.displayName)}</option>`).join(''); };
      mode.onchange = filterProviders; filterProviders();
      form.onsubmit = async event => { event.preventDefault(); const fields = new FormData(form); const minor = String(fields.get('estimatedCostMinor') || ''); try { await api(`/logistics/deliveries/${encodeURIComponent(deliveryId)}/fulfillment`, 'PUT', { providerId: fields.get('providerId'), mode: fields.get('mode'), driverId: fields.get('mode') === 'internal' ? fields.get('driverId') : null, fulfillmentId: crypto.randomUUID(), expectedRevision: data.fulfillments[0]?.revision || 0, externalReference: fields.get('externalReference') || null, etaAt: fields.get('etaAt') ? new Date(fields.get('etaAt')).toISOString() : null, ...(minor ? { estimatedCostMinor: Number(minor), estimatedCostCurrency: String(fields.get('estimatedCostCurrency')).toUpperCase() } : {}) }); loadDelivery(deliveryId, context); } catch (_) { window.RotaMotoApp?.toast?.('Não foi possível selecionar o provider. Verifique estado, atribuição e rota ativa.','error'); } };
      document.querySelector('[data-dispatch-request]')?.addEventListener('click', async () => { try { await api(`/logistics/deliveries/${encodeURIComponent(deliveryId)}/dispatch-attempts`, 'POST', { idempotencyKey: crypto.randomUUID() }); loadDelivery(deliveryId, context); } catch (_) { window.RotaMotoApp?.toast?.('Não foi possível registrar a solicitação manual.','error'); } });
      document.querySelector('#fulfillment-progress')?.addEventListener('submit', async event => { event.preventDefault(); const fields = new FormData(event.currentTarget), body = { expectedRevision: active.revision, ...(active.status === 'completed' ? {} : { status: fields.get('status') }) }, amount = String(fields.get('finalCostMinor') || ''); if (amount) { body.finalCostMinor = Number(amount); body.finalCostCurrency = String(fields.get('finalCostCurrency')).toUpperCase(); } try { await api(`/logistics/deliveries/${encodeURIComponent(deliveryId)}/fulfillment`, 'PATCH', body); loadDelivery(deliveryId, context); } catch (_) { window.RotaMotoApp?.toast?.('Transição inválida ou atualização concorrente.','error'); } });
      document.querySelector('[data-logistics-close]')?.addEventListener('click', () => window.RotaMotoApp?.closeModal?.());
    } catch (_) { if (root) root.textContent = 'Fulfillment exige sessão administrativa autorizada e API disponível.'; }
  }
  function bind(context) {
    currentContext = context || currentContext; currentState = context?.state || currentState;
    document.querySelector('[data-logistics-refresh]')?.addEventListener('click', loadProviders);
    document.querySelector('[data-logistics-add]')?.addEventListener('click', newProvider);
    document.querySelectorAll('[data-logistics-toggle]').forEach(button => button.addEventListener('click', async () => {
      try { await api(`/logistics/providers/${encodeURIComponent(button.dataset.logisticsToggle)}`, 'PATCH', { expectedVersion: Number(button.dataset.version), enabled: button.dataset.enabled !== 'true' }); loadProviders(); }
      catch (_) { window.RotaMotoApp?.toast?.('Provider alterado por outra sessão ou operação não autorizada.','error'); }
    }));
    if (document.querySelector('#logistics-provider-list')) loadProviders();
    if (document.querySelector('#fulfillment-analytics')) renderReport();
  }
  window.RotaMotoLogisticsUI = Object.freeze({ settingsPanel, bind, openDelivery });
})();
