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
  function settingsPanel() {
    return card('<div class="setting-heading"><h2>Providers logísticos</h2><p>Cadastre providers para atribuição manual. Nesta versão somente manual_assignment está implementado; nenhuma plataforma é chamada.</p></div><div class="actions"><button class="btn primary" type="button" data-logistics-add>Cadastrar parceiro</button><button class="btn" type="button" data-logistics-refresh>Atualizar</button></div><div id="logistics-provider-list"><span class="muted">Carregando…</span></div>');
  }
  function providerList(root, data) {
    root.innerHTML = (data.providers || []).map(p => `<article class="logistics-provider-card"><div><b>${esc(p.displayName)}</b><small>${p.class === 'internal_fleet' ? 'Frota própria' : p.class === 'marketplace' ? 'Marketplace' : 'Parceiro'} · ${p.enabled ? 'Ativo' : 'Desativado'}</small><small>Capabilities: ${esc((p.capabilities || []).join(', ') || 'nenhuma')}</small><small>${esc(p.code)}</small></div>${p.class === 'internal_fleet' ? '' : `<div class="actions"><button class="btn small" data-logistics-edit="${esc(p.id)}" data-version="${Number(p.version)}" data-name="${esc(p.displayName)}" data-instructions="${esc(p.configuration?.dispatchInstructions || '')}" data-portal="${esc(p.configuration?.portalUrl || '')}">Editar</button><button class="btn small" data-logistics-toggle="${esc(p.id)}" data-version="${Number(p.version)}" data-enabled="${p.enabled}">${p.enabled ? 'Desativar' : 'Ativar'}</button></div>`}</article>`).join('') || '<div class="empty">Nenhum provider cadastrado.</div>';
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
    window.RotaMotoApp?.modal?.('<h2>Novo provider logístico</h2><form id="logistics-provider-form" class="formgrid"><label>Nome<input class="input" name="displayName" maxlength="120" required></label><label>Código estável<input class="input" name="code" pattern="[a-z][a-z0-9_-]{1,63}" required></label><label>Classe<select class="select" name="class"><option value="partner">Parceiro</option><option value="marketplace">Marketplace</option></select></label><label>Estado<select class="select" name="enabled"><option value="true">Ativo</option><option value="false">Desativado</option></select></label><p class="full">Capability: manual_assignment. Quote, tracking, cancelamento remoto e prova externa ainda não estão disponíveis.</p><div class="actions full"><button class="btn" type="button" data-logistics-close>Cancelar</button><button class="btn primary">Cadastrar</button></div></form>');
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
      const data = await api('/logistics/analytics');
      root.innerHTML = `<h3>Alocações logísticas</h3>${data.providers.length ? data.providers.map(p => `<div class="report-row"><b>${esc(p.displayName)}</b><span>${p.class === 'internal_fleet' ? 'Frota própria' : 'Externo'} · ${p.allocations} alocações · ${p.completed} concluídas · ${p.reconciledCostCount} custos reconciliados</span></div>`).join('') : '<p class="muted">Sem alocações registradas.</p>'}<small>Custos são parciais e representam somente valores reconciliados.</small>`;
    } catch (_) { root.textContent = 'Resumo de fulfillment disponível para sessão administrativa autorizada.'; }
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
      root.innerHTML = `<div class="detail-state-field"><span>Estado</span><strong>${esc(data.delivery.status)} · ${active ? `${active.mode === 'internal' ? 'Frota própria' : 'Terceiro'} · ${esc((providers.providers.find(p => p.id === active.providerId) || {}).displayName || '')} · ${esc(active.status)}` : 'Sem provider selecionado'}</strong><small>Driver: ${esc(data.delivery.driverId || 'nenhum')}</small></div><form id="fulfillment-select" class="formgrid"><label>Execução<select class="select" name="mode"><option value="internal" ${active?.mode === 'internal' ? 'selected' : ''}>Frota própria</option><option value="external" ${active?.mode === 'external' ? 'selected' : ''}>Terceiro</option></select></label><label>Provider<select class="select" name="providerId">${providers.providers.filter(p => p.enabled).map(p => `<option value="${esc(p.id)}" ${active?.providerId === p.id ? 'selected' : ''}>${esc(p.displayName)} (${esc(p.class)})</option>`).join('')}</select></label><label data-driver-wrap>Motoboy<select class="select" name="driverId"><option value="">Selecione</option>${drivers.map(b => `<option value="${esc(b.sync?.canonicalId || b.canonicalId || b.id)}" ${active?.driverId === (b.sync?.canonicalId || b.canonicalId || b.id) ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label><label>Referência externa<input class="input" maxlength="160" name="externalReference" value="${esc(active?.externalReference || '')}"></label><label>ETA conhecido<input class="input" type="datetime-local" name="etaAt" value="${active?.etaAt ? esc(new Date(active.etaAt).toISOString().slice(0,16)) : ''}"></label><label>Custo estimado (centavos)<input class="input" type="number" min="0" step="1" name="estimatedCostMinor" value="${active?.estimatedCost?.amountMinor ?? ''}"></label><label>Moeda<input class="input" maxlength="3" name="estimatedCostCurrency" value="${esc(active?.estimatedCost?.currency || 'BRL')}"></label><div class="actions full"><button class="btn primary" ${active?.status === 'completed' ? 'disabled' : ''}>${active ? 'Reatribuir provider' : 'Selecionar provider'}</button></div></form>${active?.mode === 'external' ? `<div class="actions"><button class="btn" type="button" data-dispatch-request ${active.status === 'completed' ? 'disabled' : ''}>Registrar despacho manual</button></div><form id="fulfillment-progress" class="formgrid"><label>Estado externo confirmado<select class="select" name="status">${nextStatuses.map(status => `<option value="${status}" ${active.status === status ? 'selected' : ''} ${active.status === 'completed' ? 'disabled' : ''}>${status}</option>`).join('')}</select></label><label>Custo final (centavos)<input class="input" type="number" min="0" step="1" name="finalCostMinor"></label><label>Moeda<input class="input" maxlength="3" name="finalCostCurrency" value="${esc(active.finalCost?.currency || 'BRL')}"></label><div class="actions full"><button class="btn">Salvar estado/reconciliação</button></div></form>` : ''}<div class="actions"><button class="btn" type="button" data-logistics-close>Fechar</button></div>`;
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
