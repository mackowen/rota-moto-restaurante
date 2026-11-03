(() => {
  'use strict';

  const host = document.querySelector('[data-bootstrap-app]');
  if (!host) return;
  const $ = (selector, root = host) => root.querySelector(selector);
  const stage = $('[data-stage]');
  const actions = $('[data-actions]');
  const live = $('[data-live]');
  const stepCount = $('[data-step-count]');
  const storageKey = 'rotamoto.bootstrap.draft.v1';
  const idempotencyKey = 'rotamoto.bootstrap.operation.v1';
  const api = '/api';
  const steps = ['Diagnóstico', 'Administrador', 'Restaurante', 'Operação', 'Entregas', 'E-mail e notificações', 'Revisão', 'Finalização'];
  const template = {
    email: '', companyName: '', supportPhone: '', address: '', latitude: '', longitude: '', locationConfirmed: false,
    timeZone: '', routeGroupingPolicy: '', configurePricing: false, pricingModel: '', minFee: '', perKm: '', fixedFee: '',
    round: false, roundTo: '0.01', ranges: [{ from: '0', to: '', value: '' }], repasseMode: '', repassePercent: ''
  };
  let data = { ...template };
  let diagnostics = { state: 'checking', health: false, checks: {}, error: '' };
  let capability = '';
  let smtpDraft = { provider: 'gmail', senderEmail: '', senderName: 'RotaMoto', host: 'smtp.gmail.com', port: '465',
    tlsMode: 'tls', authMethod: 'password', username: '', password: '', testRecipient: '', publicBaseUrl: '', reuseStoredCredential: false };
  let smtpStatus = { state: 'idle', message: '' };
  let smtpSetupStatusLoaded = false;
  let smtpCredentialAvailable = false;
  let smtpConfigurationSaved = false;
  let operationKey = '';
  let busy = false;
  let finished = null;
  let currentStep = 0;

  try {
    const draft = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (draft && typeof draft === 'object') data = { ...template, ...draft,
      ranges: Array.isArray(draft.ranges) ? draft.ranges : template.ranges };
    const savedKey = sessionStorage.getItem(idempotencyKey);
    if (typeof savedKey === 'string' && /^bootstrap-[0-9a-f-]{36}$/u.test(savedKey)) operationKey = savedKey;
  } catch (_) { /* Private browsing may disable session storage; the wizard remains usable in memory. */ }

  function saveDraft() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(data)); } catch (_) { /* In-memory navigation still preserves the current draft. */ }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function setMessage(message = '', kind = '') {
    live.textContent = message;
    live.dataset.kind = kind;
    live.hidden = !message;
  }

  async function fetchJson(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${api}${path}`, { credentials: 'same-origin', cache: 'no-store',
        ...options, signal: controller.signal, headers: { Accept: 'application/json', ...(options.headers || {}) } });
      let body = {};
      try { body = await response.json(); } catch (_) { throw Object.assign(new Error('O servidor enviou uma resposta inesperada.'), { code: 'INVALID_RESPONSE' }); }
      if (!response.ok) throw Object.assign(new Error(body?.error?.message || 'Não foi possível concluir esta etapa.'),
        { code: body?.error?.code || 'REQUEST_FAILED', status: response.status });
      return body;
    } finally { window.clearTimeout(timer); }
  }

  async function fetchBounded(path, options = {}) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try { return await fetch(path, { ...options, signal: controller.signal }); }
    finally { window.clearTimeout(timer); }
  }

  async function diagnose() {
    diagnostics = { state: 'checking', health: false, checks: {}, error: '' };
    render();
    try {
      const [health, bootstrap] = await Promise.all([
        fetchBounded('/health/ready', { cache: 'no-store', headers: { Accept: 'application/json' } }).then(async response => {
          let body = {}; try { body = await response.json(); } catch (_) {}
          return { ok: response.ok && body.status === 'ready', body };
        }),
        fetchJson('/identity/bootstrap/status')
      ]);
      diagnostics = { state: bootstrap.state || 'not_ready', health: health.ok,
        checks: bootstrap.checks || {}, error: health.ok ? '' : 'A API ainda não confirmou a conexão e o schema necessários.' };
      smtpConfigurationSaved = diagnostics.checks.invitationDeliveryConfigured === true;
    } catch (error) {
      diagnostics = { state: 'error', health: false, checks: {},
        error: error.name === 'AbortError' ? 'A API demorou demais para responder. Confira o serviço e tente novamente.' : 'Não foi possível consultar o serviço de instalação. Verifique a API e tente novamente.' };
    }
    render();
  }

  function canBeginSetupFlow() {
    return diagnostics.health && diagnostics.state === 'ready' &&
      diagnostics.checks.databaseAndMigrations === true && diagnostics.checks.mfaKeystoreConfigured === true;
  }

  function canSubmitBootstrap() {
    return canBeginSetupFlow() && diagnostics.checks.invitationDeliveryConfigured === true;
  }

  function checkRow(label, value, detail = '') {
    const text = value === true ? 'Pronto' : value === false ? 'Pendente' : 'Verificando';
    return `<li class="bootstrap-check" data-result="${value === true ? 'pass' : value === false ? 'pending' : 'checking'}"><span class="bootstrap-check-mark" aria-hidden="true">${value === true ? '✓' : value === false ? '!' : '…'}</span><span><strong>${label}</strong>${detail ? `<small>${detail}</small>` : ''}</span><b>${text}</b></li>`;
  }

  function diagnosticView() {
    if (diagnostics.state === 'complete') return `<section class="bootstrap-notice bootstrap-notice--success"><h2>Instalação já concluída</h2><p>O assistente de primeira instalação está bloqueado. Entre pela tela normal para acessar o sistema.</p><a class="bootstrap-link-button" href="/">Ir para o acesso</a></section>`;
    if (diagnostics.state === 'pending_owner_activation' || diagnostics.state === 'pending_owner_mfa') return `<section class="bootstrap-notice"><h2>Ativação do titular em andamento</h2><p>${diagnostics.state === 'pending_owner_activation' ? 'A empresa e o convite inicial foram registrados. O titular precisa aceitar o convite recebido por e-mail, definir a senha e depois entrar para configurar o MFA obrigatório.' : 'O convite já foi aceito. O titular precisa entrar e confirmar o novo autenticador para concluir o primeiro acesso privilegiado.'}</p><a class="bootstrap-link-button" href="/">Abrir o acesso</a></section>`;
    if (diagnostics.state === 'unavailable') return `<section class="bootstrap-notice bootstrap-notice--warning"><h2>Primeira instalação indisponível</h2><p>Este ambiente já tem uma instalação, uma reserva ou dados de identidade. O assistente não pode iniciar outra instalação.</p><a class="bootstrap-link-button" href="/">Voltar ao acesso</a></section>`;
    return `<section class="bootstrap-diagnostic"><div><h2>Antes de começar</h2><p>O assistente verifica o serviço e os requisitos. Com o schema vazio e o keystore de MFA pronto, você pode preencher os dados e configurar o e-mail na etapa seguinte.</p></div>
      <ul class="bootstrap-checks">${checkRow('API e PostgreSQL', diagnostics.health)}${checkRow('Schema e migrations', diagnostics.checks.databaseAndMigrations)}${checkRow('Keystore de MFA', diagnostics.checks.mfaKeystoreConfigured, 'Necessário para guardar o fator sem expor o segredo no banco ou na interface.')}${checkRow('Envio de convites', diagnostics.checks.invitationDeliveryConfigured, 'Será configurado e testado neste assistente, sob autorização temporária.')}</ul>
      ${diagnostics.error ? `<p class="bootstrap-inline-error" role="alert">${escapeHtml(diagnostics.error)}</p>` : ''}
      ${diagnostics.state === 'unavailable' || diagnostics.state === 'not_ready' || diagnostics.error
        ? '<button class="bootstrap-secondary-button" type="button" data-diagnose>Verificar novamente</button>' : ''}
      <p class="bootstrap-note">A autorização temporária é emitida pelo operador local. A ausência de empresas, sozinha, nunca libera um novo bootstrap.</p>
      ${diagnostics.state === 'not_ready' ? '<p class="bootstrap-inline-error" role="alert">O schema de primeira instalação ainda não está disponível neste serviço. Nenhum dado foi alterado.</p>' : ''}</section>`;
  }

  function formField(label, name, value, type = 'text', extra = '') {
    return `<label class="bootstrap-field">${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}></label>`;
  }

  function stageMarkup(index) {
    if (index === 0) return diagnosticView();
    if (index === 1) return `<section class="bootstrap-form-step"><div><h2>Administrador fundador</h2><p>O serviço enviará um convite para este endereço. O titular criará a senha no link e configurará o autenticador antes de receber privilégios globais.</p></div>
      ${formField('E-mail do titular', 'email', data.email, 'email', 'autocomplete="email" required maxlength="320"')}
      <label class="bootstrap-field">Autorização local de uso único<input name="capability" type="password" inputmode="text" autocomplete="off" spellcheck="false" value="${escapeHtml(capability)}" required minlength="43" maxlength="43" aria-describedby="bootstrap-capability-help"></label>
      <small id="bootstrap-capability-help" class="bootstrap-help">Gere a autorização no terminal local autorizado e cole-a somente nesta tela. Ela expira em poucos minutos e não será salva no navegador.</small>
      <div class="bootstrap-callout"><strong>Não informe uma senha aqui.</strong><span>A senha é definida pelo próprio titular no convite. Nenhum privilégio fundador será aplicado antes da confirmação do MFA.</span></div></section>`;
    if (index === 2) return `<section class="bootstrap-form-step"><div><h2>Dados do restaurante</h2><p>Informe apenas os dados que serão gravados na configuração canônica da empresa.</p></div>
      ${formField('Nome da empresa', 'companyName', data.companyName, 'text', 'autocomplete="organization" required maxlength="160"')}
      ${formField('Telefone de contato (opcional)', 'supportPhone', data.supportPhone, 'tel', 'autocomplete="tel" maxlength="40"')}
      <fieldset class="bootstrap-location"><legend>Endereço e localização (opcionais)</legend><p>Não usamos localização automática. Informe os dados e confirme que representam o endereço operacional.</p>
      ${formField('Endereço', 'address', data.address, 'text', 'autocomplete="street-address" maxlength="500"')}
      <div class="bootstrap-grid-2">${formField('Latitude confirmada', 'latitude', data.latitude, 'number', 'inputmode="decimal" min="-90" max="90" step="any"')}${formField('Longitude confirmada', 'longitude', data.longitude, 'number', 'inputmode="decimal" min="-180" max="180" step="any"')}</div>
      <label class="bootstrap-check-label"><input name="locationConfirmed" type="checkbox" ${data.locationConfirmed ? 'checked' : ''}><span>Confirmo que o endereço e as coordenadas informadas estão corretos.</span></label></fieldset></section>`;
    if (index === 3) return `<section class="bootstrap-form-step"><div><h2>Operação</h2><p>Estas são as opções operacionais que já possuem armazenamento canônico. As sugestões não ativam serviços externos.</p></div>
      <label class="bootstrap-field">Fuso horário<select name="timeZone" required><option value="">Escolha o fuso da empresa</option><option value="America/Sao_Paulo" ${data.timeZone === 'America/Sao_Paulo' ? 'selected' : ''}>Brasília e região · America/Sao_Paulo</option><option value="America/Fortaleza" ${data.timeZone === 'America/Fortaleza' ? 'selected' : ''}>Fortaleza e região · America/Fortaleza</option><option value="America/Manaus" ${data.timeZone === 'America/Manaus' ? 'selected' : ''}>Manaus e região · America/Manaus</option><option value="America/Rio_Branco" ${data.timeZone === 'America/Rio_Branco' ? 'selected' : ''}>Rio Branco e região · America/Rio_Branco</option><option value="UTC" ${data.timeZone === 'UTC' ? 'selected' : ''}>UTC</option></select><small>Escolha o fuso que corresponde à operação. A sugestão não é aplicada automaticamente.</small></label>
      <label class="bootstrap-field">Agrupamento de rotas<select name="routeGroupingPolicy" required><option value="">Escolha uma política</option><option value="nearest_extension" ${data.routeGroupingPolicy === 'nearest_extension' ? 'selected' : ''}>Agrupar pela rota mais próxima</option><option value="nearest_origin_round_robin" ${data.routeGroupingPolicy === 'nearest_origin_round_robin' ? 'selected' : ''}>Alternar entre origens próximas</option></select><small>É uma preferência de organização de rota; não ativa distribuição automática.</small></label>
      <div class="bootstrap-pending"><strong>Configurações posteriores</strong><span>Horários de funcionamento e modalidades de atendimento não têm gravação canônica neste assistente. Permanecerão pendentes e não serão ativados.</span></div></section>`;
    if (index === 4) return pricingMarkup();
    if (index === 5) return smtpMarkup();
    if (index === 6) return reviewMarkup();
    if (finished) return finishedMarkup();
    return `<section class="bootstrap-form-step"><h2>Pronto para iniciar</h2><p>Revise os dados e confirme para criar a empresa inicial e enviar o convite ao titular.</p>${diagnostics.checks.invitationDeliveryConfigured !== true ? '<p class="bootstrap-inline-error" role="status">O envio está bloqueado até o teste SMTP ser aceito e a URL HTTPS pública dos convites estar configurada. Nenhum dado será enviado enquanto esse requisito estiver pendente.</p>' : ''}</section>`;
  }

  function rangeMarkup(item, index) {
    return `<div class="bootstrap-range-row" data-range-row="${index}"><span class="bootstrap-range-title">Faixa ${index + 1}</span><div class="bootstrap-grid-3">${formField('De (km)', 'rangeFrom', item.from, 'number', 'min="0" max="10000" step="0.1"')}${formField('Até (km)', 'rangeTo', item.to, 'number', 'min="0.1" max="10000" step="0.1" placeholder="Sem limite"')}${formField('Taxa (R$)', 'rangeValue', item.value, 'number', 'min="0" max="1000000" step="0.01"')}</div>${index > 0 ? '<button class="bootstrap-text-button" type="button" data-remove-range>Remover faixa</button>' : ''}</div>`;
  }

  function pricingMarkup() {
    if (!data.configurePricing) return `<section class="bootstrap-form-step"><div><h2>Entregas e logística</h2><p>Não existe uma taxa universal. Deixe a cobrança sem configurar agora ou informe os valores definidos pelo restaurante.</p></div>
      <label class="bootstrap-check-label bootstrap-check-label--card"><input name="configurePricing" type="checkbox"><span><strong>Configurar a cobrança de entrega agora</strong><small>Os valores serão gravados no servidor junto com a primeira empresa. Não são remuneração do motoboy nem custo operacional.</small></span></label>
      <div class="bootstrap-pending"><strong>Outros itens ficam pendentes</strong><span>Raio de atendimento, tempo de preparo, entrega própria e distribuição automática não têm configuração inicial persistível neste fluxo. Nenhum deles será ativado.</span></div></section>`;
    const model = data.pricingModel;
    return `<section class="bootstrap-form-step"><div><h2>Entregas e logística</h2><p>Informe valores aprovados pelo restaurante. O assistente não sugere preços nem confunde cobrança do cliente com repasse ao motoboy.</p></div>
      <label class="bootstrap-check-label bootstrap-check-label--card"><input name="configurePricing" type="checkbox" checked><span><strong>Configurar a cobrança de entrega agora</strong><small>Os valores serão gravados no servidor junto com a primeira empresa.</small></span></label>
      <label class="bootstrap-field">Modelo<select name="pricingModel" required><option value="">Escolha o modelo</option><option value="perKm" ${model === 'perKm' ? 'selected' : ''}>Por quilômetro</option><option value="range" ${model === 'range' ? 'selected' : ''}>Por faixas de distância</option><option value="perDelivery" ${model === 'perDelivery' ? 'selected' : ''}>Valor fixo por entrega</option></select></label>
      <div class="bootstrap-grid-2">${formField('Taxa mínima cobrada do cliente (R$)', 'minFee', data.minFee, 'number', 'min="0" max="1000000" step="0.01" required')}${model === 'perKm' ? formField('Valor por km (R$)', 'perKm', data.perKm, 'number', 'min="0.01" max="1000000" step="0.01" required') : model === 'perDelivery' ? formField('Valor fixo por entrega (R$)', 'fixedFee', data.fixedFee, 'number', 'min="0.01" max="1000000" step="0.01" required') : '<div class="bootstrap-pending bootstrap-pending--inline">Valores de modelos inativos serão zero nesta configuração inicial; nenhum cálculo de modelo inativo será aplicado.</div>'}</div>
      ${model === 'range' ? `<fieldset class="bootstrap-ranges"><legend>Faixas de cobrança</legend>${data.ranges.map(rangeMarkup).join('')}<button type="button" class="bootstrap-secondary-button" data-add-range>Adicionar faixa</button></fieldset>` : ''}
      <label class="bootstrap-field">Repasse ao motoboy<select name="repasseMode" required><option value="">Escolha a regra</option><option value="full" ${data.repasseMode === 'full' ? 'selected' : ''}>Repasse integral da taxa definida</option><option value="percentage" ${data.repasseMode === 'percentage' ? 'selected' : ''}>Repasse de um percentual</option></select></label>
      ${data.repasseMode === 'percentage' ? formField('Percentual de repasse', 'repassePercent', data.repassePercent, 'number', 'min="0" max="100" step="0.01" required') : ''}
      <label class="bootstrap-check-label"><input name="round" type="checkbox" ${data.round ? 'checked' : ''}><span>Arredondar a taxa calculada</span></label>
      ${data.round ? formField('Arredondamento (R$)', 'roundTo', data.roundTo, 'number', 'min="0.01" max="1000000" step="0.01" required') : ''}
      <p class="bootstrap-note">Os valores das regras não escolhidas não serão aplicados. A configuração pode ser alterada depois em Operação.</p></section>`;
  }

  function smtpMarkup() {
    const note = smtpDraft.provider === 'gmail'
      ? 'Use uma senha de app gerada na Conta Google com a verificação em duas etapas ativa. Não use a senha normal da conta.'
      : smtpDraft.provider === 'microsoft365'
        ? 'O SMTP AUTH precisa estar habilitado para a caixa no Microsoft 365. Este fluxo usa usuário e senha SMTP; OAuth não está implementado.'
        : 'Use o host oficial do seu provedor, com STARTTLS ou TLS implícito. Endereços IP, redes locais e SMTP sem TLS são bloqueados.';
    const statusKind = smtpStatus.state === 'success' ? 'success' : smtpStatus.state === 'working' ? 'working' : smtpStatus.state === 'error' ? 'error' : '';
    return `<section class="bootstrap-form-step bootstrap-smtp-step"><div><h2>E-mail e notificações</h2><p>Configure e envie uma mensagem de teste antes de usar o SMTP para convites e recuperação de acesso.</p></div>
      <label class="bootstrap-field">Provedor<select name="smtpProvider" data-smtp-provider><option value="gmail" ${smtpDraft.provider==='gmail'?'selected':''}>Gmail</option><option value="microsoft365" ${smtpDraft.provider==='microsoft365'?'selected':''}>Outlook / Microsoft 365</option><option value="custom" ${smtpDraft.provider==='custom'?'selected':''}>SMTP personalizado</option></select></label>
      <div class="bootstrap-grid-2">${formField('E-mail do remetente','smtpSenderEmail',smtpDraft.senderEmail,'email','autocomplete="email" maxlength="254" required')}${formField('Nome de exibição','smtpSenderName',smtpDraft.senderName,'text','autocomplete="organization" maxlength="120" required')}</div>
      <div class="bootstrap-grid-2">${formField('Host SMTP','smtpHost',smtpDraft.host,'text','autocomplete="url" maxlength="253" autocapitalize="none" spellcheck="false" required')}${formField('Porta','smtpPort',smtpDraft.port,'number','min="1" max="65535" step="1" inputmode="numeric" required')}</div>
      <div class="bootstrap-grid-2"><label class="bootstrap-field">Segurança de transporte<select name="smtpTls"><option value="starttls" ${smtpDraft.tlsMode==='starttls'?'selected':''}>STARTTLS · recomendado na porta 587</option><option value="tls" ${smtpDraft.tlsMode==='tls'?'selected':''}>TLS implícito · normalmente porta 465</option></select></label><label class="bootstrap-field">Autenticação<select name="smtpAuth"><option value="password" selected>Usuário e senha SMTP</option><option value="oauth" disabled>OAuth · indisponível</option></select></label></div>
      ${smtpCredentialAvailable ? `<label class="bootstrap-check-label bootstrap-check-label--card"><input name="smtpReuseCredential" type="checkbox" ${smtpDraft.reuseStoredCredential?'checked':''}><span><strong>Reutilizar a credencial SMTP protegida já existente</strong><small>O usuário e a senha permanecem no keystore e não são enviados de volta ao navegador.</small></span></label>` : ''}
      <div class="bootstrap-grid-2">${formField('Usuário SMTP','smtpUsername',smtpDraft.username,'text',`autocomplete="username" maxlength="320" ${smtpDraft.reuseStoredCredential?'disabled':'required'}`)}${formField('Senha SMTP / senha de app','smtpPassword','', 'password',`autocomplete="new-password" maxlength="4096" ${smtpDraft.reuseStoredCredential?'disabled':'required'}`)}</div>
      <p class="bootstrap-help bootstrap-smtp-provider-note">${escapeHtml(note)}</p>
      <div class="bootstrap-grid-2">${formField('Enviar teste para','smtpTestRecipient',smtpDraft.testRecipient,'email','autocomplete="email" maxlength="254" required')}${formField('URL HTTPS pública dos convites','smtpPublicBaseUrl',smtpDraft.publicBaseUrl,'url','inputmode="url" autocomplete="url" maxlength="2048" required placeholder="https://seu-dominio.example"')}</div>
      <p class="bootstrap-help">A URL precisa ser alcançável pelas pessoas convidadas. Um endereço local 127.0.0.1 não funciona para destinatários externos.</p>
      <div class="bootstrap-smtp-actions"><button class="bootstrap-secondary-button" type="button" data-smtp-validate ${busy?'disabled':''}>Validar parâmetros</button><button class="bootstrap-primary-button" type="button" data-smtp-test ${busy?'disabled':''}>${busy?'Testando…':'Testar e-mail'}</button></div>
      <p class="bootstrap-smtp-status" data-smtp-status data-kind="${statusKind}" role="status" aria-live="polite">${escapeHtml(smtpStatus.message || (smtpConfigurationSaved ? 'Configuração de e-mail testada e protegida.' : 'O SMTP ainda não foi testado.'))}</p>
      ${smtpConfigurationSaved ? '<p class="bootstrap-note">O servidor SMTP aceitou a mensagem de teste. Isso não confirma a chegada à caixa de entrada.</p>' : ''}
      <div class="bootstrap-callout"><strong>Segredos e instalação</strong><span>A credencial nunca é devolvida pela API nem salva no rascunho do navegador. Ela será criptografada no keystore local somente depois que o servidor aceitar a mensagem de teste.</span></div></section>`;
  }

  function readSmtpForm() {
    const value = name => stage.querySelector(`[name="${name}"]`)?.value ?? '';
    smtpDraft = { ...smtpDraft, provider: value('smtpProvider'), senderEmail: value('smtpSenderEmail').trim(),
      senderName: value('smtpSenderName').trim(), host: value('smtpHost').trim(), port: value('smtpPort'),
      tlsMode: value('smtpTls'), authMethod: value('smtpAuth'), username: value('smtpUsername').trim(),
      password: value('smtpPassword'), reuseStoredCredential: stage.querySelector('[name="smtpReuseCredential"]')?.checked === true,
      testRecipient: value('smtpTestRecipient').trim(), publicBaseUrl: value('smtpPublicBaseUrl').trim() };
    return { ...smtpDraft, port: Number(smtpDraft.port) };
  }

  function bootstrapHeaders() {
    capability = stage.querySelector('[name="capability"]')?.value.trim() || capability;
    return { 'Content-Type': 'application/json', 'X-RotaMoto-Bootstrap-Authorization': capability };
  }

  async function loadBootstrapSmtpStatus() {
    if (smtpSetupStatusLoaded || currentStep !== 5 || !capability) return;
    smtpSetupStatusLoaded = true;
    try {
      const value = await fetchJson('/identity/bootstrap/smtp/status', { method: 'POST', headers: bootstrapHeaders(), body: '{}' });
      smtpCredentialAvailable = value.credentialStored === true || value.existingCredentialAvailable === true;
      for (const key of ['provider', 'senderEmail', 'senderName', 'host', 'port', 'tlsMode', 'testRecipient', 'publicBaseUrl'])
        if (value[key] !== null && value[key] !== undefined && value[key] !== '') smtpDraft[key] = String(value[key]);
      if (smtpCredentialAvailable) { smtpDraft.reuseStoredCredential = true; smtpDraft.username = ''; smtpDraft.password = ''; }
    } catch (_) { /* Manual SMTP entry remains available if protected status cannot be read. */ }
    render();
  }

  async function validateSmtpFromForm() {
    if (busy) return;
    const settings = readSmtpForm();
    if (!capability) { setMessage('Informe a autorização local antes de validar o SMTP.', 'error'); return; }
    busy = true; smtpStatus = { state: 'working', message: 'Validando host, porta, TLS e parâmetros…' }; render();
    try {
      const result = await fetchJson('/identity/bootstrap/smtp/validate', { method: 'POST', headers: bootstrapHeaders(), body: JSON.stringify(settings) });
      smtpStatus = { state: 'success', message: `Parâmetros válidos para ${result.host}:${result.port} com ${result.tlsMode === 'tls' ? 'TLS' : 'STARTTLS'}.` };
    } catch (error) { smtpStatus = { state: 'error', message: error.message || 'Não foi possível validar o SMTP.' }; }
    finally { busy = false; render(); }
  }

  async function testSmtpFromForm() {
    if (busy) return;
    const settings = readSmtpForm();
    if (!capability) { smtpStatus = { state: 'error', message: 'Informe a autorização local antes de testar o SMTP.' }; render(); return; }
    if (!stage.querySelector('form')?.reportValidity()) return;
    busy = true; smtpStatus = { state: 'working', message: 'Conectando, autenticando e enviando uma mensagem de teste…' }; render();
    try {
      const result = await fetchJson('/identity/bootstrap/smtp/test', { method: 'POST', headers: bootstrapHeaders(),
        body: JSON.stringify({ requestId: crypto.randomUUID(), settings }) });
      smtpConfigurationSaved = result.configurationSaved === true;
      diagnostics.checks.invitationDeliveryConfigured = smtpConfigurationSaved;
      if (smtpConfigurationSaved) {
        smtpCredentialAvailable = true;
        smtpDraft = { ...smtpDraft, username: '', password: '', reuseStoredCredential: true };
        try {
          const saved = await fetchJson('/identity/bootstrap/smtp/status', { method: 'POST', headers: bootstrapHeaders(), body: '{}' });
          smtpDraft = { ...smtpDraft, ...Object.fromEntries(['provider', 'senderEmail', 'senderName', 'host', 'port', 'tlsMode', 'testRecipient', 'publicBaseUrl']
            .filter(key => saved[key] !== null && saved[key] !== undefined).map(key => [key, String(saved[key])])) };
        } catch (_) { /* Save succeeded; the secret remains cleared from browser memory. */ }
      }
      smtpStatus = { state: 'success', message: result.notice || 'Servidor SMTP aceitou a mensagem; entrega final não confirmada.' };
    } catch (error) { smtpStatus = { state: 'error', message: error.message || 'Falha ao testar o serviço SMTP.' }; }
    finally { busy = false; render(); }
  }

  function applySmtpPreset(provider) {
    if (!['gmail', 'microsoft365'].includes(provider)) return;
    smtpDraft = { ...smtpDraft, provider, host: provider === 'gmail' ? 'smtp.gmail.com' : 'smtp.office365.com',
      port: provider === 'gmail' ? '465' : '587', tlsMode: provider === 'gmail' ? 'tls' : 'starttls', reuseStoredCredential: false };
  }

  function reviewMarkup() {
    const location = data.address || data.latitude || data.longitude ? [data.address || 'Endereço não informado', data.latitude && data.longitude ? `${data.latitude}, ${data.longitude}` : 'Sem coordenadas'].join(' · ') : 'Não configurada';
    const pricing = data.configurePricing ? `Modelo ${data.pricingModel || 'não escolhido'}; taxa mínima R$ ${data.minFee || '—'}` : 'Pendente de definição pelo restaurante';
    const rows = [
      ['Titular', data.email || '—'], ['Empresa', data.companyName || '—'], ['Telefone', data.supportPhone || 'Não informado'],
      ['Endereço operacional', location], ['Fuso horário', data.timeZone || 'Pendente'],
      ['Agrupamento de rotas', data.routeGroupingPolicy === 'nearest_extension' ? 'Rota próxima' : data.routeGroupingPolicy === 'nearest_origin_round_robin' ? 'Alternância entre origens próximas' : 'Pendente'],
      ['Cobrança de entrega', pricing], ['MFA do titular', 'Obrigatório após aceitar o convite']
    ];
    return `<section class="bootstrap-form-step"><div><h2>Revise antes de iniciar</h2><p>O assistente gravará os campos abaixo. Horários, modalidades e outros recursos sem contrato de instalação ficarão pendentes.</p></div><dl class="bootstrap-review">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl><div class="bootstrap-callout"><strong>Esta ação cria a primeira empresa e envia um convite.</strong><span>A confirmação do MFA pelo titular conclui o bootstrap e libera o privilégio fundador. A instalação não será concluída nesta tela.</span></div></section>`;
  }

  function finishedMarkup() {
    if (finished?.delivery === 'sent') return `<section class="bootstrap-form-step bootstrap-finished"><div class="bootstrap-finished-icon" aria-hidden="true">✓</div><h2>Cadastro inicial registrado</h2><p>A empresa e as configurações foram confirmadas pelo servidor. O serviço de e-mail aceitou o convite; a entrega na caixa de entrada depende do provedor.</p><ol><li>O titular abre o convite e define uma senha forte.</li><li>Depois, entra no RotaMoto e configura o autenticador e os códigos de recuperação.</li><li>O privilégio fundador só é registrado após a confirmação do MFA.</li></ol><a class="bootstrap-link-button" href="/">Ir para o acesso</a></section>`;
    if (finished?.delivery === 'pending') return `<section class="bootstrap-form-step"><h2>Envio ainda em processamento</h2><p>O cadastro foi gravado, mas o serviço ainda não confirmou o convite. Aguarde alguns minutos e tente verificar novamente com a mesma autorização.</p></section>`;
    return `<section class="bootstrap-form-step"><h2>Não foi possível confirmar o envio</h2><p>O cadastro e o rascunho foram preservados. Corrija o serviço de e-mail e tente novamente; a mesma chave impede criar uma segunda empresa.</p></section>`;
  }

  function renderProgress() {
    $('[data-progress]').innerHTML = steps.map((label, index) => {
      const state = index === currentStep ? 'atual' : index < currentStep ? 'concluída' : 'pendente';
      return `<li class="bootstrap-progress-step ${index === currentStep ? 'is-current' : index < currentStep ? 'is-done' : ''}" aria-label="${label}, etapa ${index + 1} de ${steps.length}, ${state}" ${index === currentStep ? 'aria-current="step"' : ''}><span aria-hidden="true">${index < currentStep ? '✓' : index + 1}</span><small aria-hidden="true">${label}</small></li>`;
    }).join('');
    stepCount.textContent = `${steps[currentStep]} · Etapa ${currentStep + 1} de ${steps.length}`;
  }

  function renderActions() {
    if (diagnostics.state === 'complete' || diagnostics.state === 'unavailable' ||
        diagnostics.state === 'pending_owner_activation' || diagnostics.state === 'pending_owner_mfa') {
      actions.replaceChildren(); return;
    }
    if (finished) {
      actions.innerHTML = finished.delivery === 'sent' ? '' : `<button type="button" class="bootstrap-secondary-button" data-retry ${busy ? 'disabled' : ''}>${busy ? 'Verificando…' : 'Tentar novamente'}</button>`;
      $('[data-retry]', actions)?.addEventListener('click', submitProvision);
      return;
    }
    const nextLabel = currentStep === 6 ? 'Continuar para finalização' : currentStep === 7 ? 'Iniciar instalação' : 'Continuar';
    const blocked = currentStep === 0 ? !canBeginSetupFlow() : currentStep === 5 && !smtpConfigurationSaved || currentStep === 7 && !canSubmitBootstrap();
    actions.innerHTML = `${currentStep > 0 ? '<button type="button" class="bootstrap-secondary-button" data-back>Voltar</button>' : ''}<button type="button" class="bootstrap-primary-button" data-next ${busy || blocked ? 'disabled' : ''}>${busy ? 'Verificando…' : nextLabel}</button>`;
    $('[data-back]', actions)?.addEventListener('click', () => { syncForm(); currentStep = Math.max(0, currentStep - 1); setMessage(); render(); });
    $('[data-next]', actions)?.addEventListener('click', async () => {
      syncForm();
      if (currentStep === 0) {
        if (!canBeginSetupFlow()) return setMessage('Corrija os requisitos de banco, schema e MFA antes de avançar.', 'error');
        currentStep = 1; render(); return;
      }
      if (!validateStep(currentStep)) return;
      if (currentStep === 6) { currentStep = 7; render(); return; }
      if (currentStep === 7) { await submitProvision(); return; }
      currentStep += 1; setMessage(); render();
    });
  }

  function render() {
    renderProgress();
    const content = stageMarkup(currentStep);
    stage.innerHTML = currentStep > 0 && !finished ? `<form class="bootstrap-wizard-form" novalidate>${content}</form>` : content;
    renderActions();
    stage.querySelector('form')?.addEventListener('submit', event => { event.preventDefault(); $('[data-next]', actions)?.click(); });
    $('[data-theme-toggle]').textContent = document.documentElement.dataset.resolvedTheme === 'dark' ? 'Tema claro' : 'Tema escuro';
    if (currentStep === 5) void loadBootstrapSmtpStatus();
  }

  function onInput(event) {
    if (event.target.name === 'smtpReuseCredential') {
      readSmtpForm();
      for (const name of ['smtpUsername', 'smtpPassword']) {
        const field = stage.querySelector(`[name="${name}"]`);
        if (field) { field.disabled = smtpDraft.reuseStoredCredential; field.required = !smtpDraft.reuseStoredCredential; }
      }
      smtpConfigurationSaved = false;
      if (diagnostics.checks) diagnostics.checks.invitationDeliveryConfigured = false;
      smtpStatus = { state: 'idle', message: '' }; return;
    }
    if (event.target.name === 'smtpProvider') {
      readSmtpForm(); applySmtpPreset(event.target.value); smtpConfigurationSaved = false;
      if (diagnostics.checks) diagnostics.checks.invitationDeliveryConfigured = false;
      smtpStatus = { state: 'idle', message: '' }; render(); return;
    }
    if (event.target.name?.startsWith('smtp')) {
      readSmtpForm(); smtpConfigurationSaved = false;
      if (diagnostics.checks) diagnostics.checks.invitationDeliveryConfigured = false;
      smtpStatus = { state: 'idle', message: 'A configuração mudou. Teste o SMTP novamente antes de continuar.' }; return;
    }
    if (event.target.name === 'configurePricing') { syncForm(); saveDraft(); render(); return; }
    if (event.target.name === 'pricingModel' || event.target.name === 'repasseMode' || event.target.name === 'round') {
      syncForm(); saveDraft(); render(); return;
    }
    syncForm(); saveDraft();
  }

  function syncForm() {
    const form = stage.querySelector('form');
    const values = form ? new FormData(form) : null;
    if (values) {
      for (const name of ['email', 'companyName', 'supportPhone', 'address', 'latitude', 'longitude', 'timeZone', 'routeGroupingPolicy', 'pricingModel', 'minFee', 'perKm', 'fixedFee', 'roundTo', 'repasseMode', 'repassePercent']) {
        if (values.has(name)) data[name] = values.get(name);
      }
    }
    const named = name => stage.querySelector(`[name="${name}"]`);
    if (named('locationConfirmed')) data.locationConfirmed = named('locationConfirmed').checked;
    if (named('configurePricing')) data.configurePricing = named('configurePricing').checked;
    if (named('round')) data.round = named('round').checked;
    const rangeRows = [...stage.querySelectorAll('[data-range-row]')];
    if (rangeRows.length) data.ranges = rangeRows.map(row => ({ from: row.querySelector('[name="rangeFrom"]').value,
      to: row.querySelector('[name="rangeTo"]').value, value: row.querySelector('[name="rangeValue"]').value }));
  }

  function validateStep(index) {
    const form = stage.querySelector('form');
    if (form && !form.reportValidity()) return false;
    if (index === 1) {
      const email = data.email.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) return setMessage('Informe um e-mail válido para o titular.', 'error'), false;
      const nextCapability = stage.querySelector('[name="capability"]')?.value.trim() || capability;
      if (nextCapability !== capability) smtpSetupStatusLoaded = false;
      capability = nextCapability;
      if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) return setMessage('Confira a autorização local de uso único.', 'error'), false;
    }
    if (index === 2) {
      if (!data.companyName.trim()) return setMessage('Informe o nome do restaurante.', 'error'), false;
      if ((data.latitude.trim() || data.longitude.trim()) && (!data.latitude.trim() || !data.longitude.trim())) return setMessage('Informe as duas coordenadas ou deixe ambas vazias.', 'error'), false;
      if ((data.address.trim() || data.latitude.trim()) && !data.locationConfirmed) return setMessage('Confirme o endereço e a localização informados.', 'error'), false;
    }
    if (index === 3 && (!data.timeZone || !data.routeGroupingPolicy)) return setMessage('Escolha o fuso horário e o agrupamento de rotas.', 'error'), false;
    if (index === 4 && data.configurePricing) {
      if (!data.pricingModel) return setMessage('Escolha o modelo de cobrança.', 'error'), false;
      const number = value => value !== '' && Number.isFinite(Number(value));
      if (!number(data.minFee) || Number(data.minFee) < 0) return setMessage('Informe uma taxa mínima válida ou deixe a cobrança pendente.', 'error'), false;
      if (data.pricingModel === 'perKm' && (!number(data.perKm) || Number(data.perKm) <= 0)) return setMessage('Informe um valor por quilômetro maior que zero.', 'error'), false;
      if (data.pricingModel === 'perDelivery' && (!number(data.fixedFee) || Number(data.fixedFee) <= 0)) return setMessage('Informe um valor fixo por entrega maior que zero.', 'error'), false;
      if (data.pricingModel === 'range' && (!data.ranges.length || data.ranges.some((range, i) => !number(range.from) || !number(range.value) || i < data.ranges.length - 1 && !number(range.to)))) return setMessage('Complete todas as faixas de distância e seus valores.', 'error'), false;
      if (!data.repasseMode || data.repasseMode === 'percentage' && (!number(data.repassePercent) || Number(data.repassePercent) < 0 || Number(data.repassePercent) > 100)) return setMessage('Informe a regra de repasse ao motoboy.', 'error'), false;
    }
    if (index === 5 && !smtpConfigurationSaved) return setMessage('Teste o SMTP e confirme a aceitação da mensagem antes de continuar.', 'error'), false;
    setMessage(); return true;
  }

  function makeInitialSetup() {
    let location = null;
    if (data.address.trim() || data.latitude.trim() || data.longitude.trim()) {
      location = { address: data.address.trim() || null, latitude: data.latitude.trim() ? Number(data.latitude) : null,
        longitude: data.longitude.trim() ? Number(data.longitude) : null, confirmed: data.locationConfirmed };
    }
    let deliveryPricing = null;
    if (data.configurePricing) {
      const model = data.pricingModel;
      deliveryPricing = { model, minFee: Number(data.minFee), perKm: model === 'perKm' ? Number(data.perKm) : 0,
        fixedFee: model === 'perDelivery' ? Number(data.fixedFee) : 0, round: Boolean(data.round),
        roundTo: data.round ? Number(data.roundTo) : 0.01,
        ranges: model === 'range' ? data.ranges.map(range => ({ from: Number(range.from), to: range.to === '' ? null : Number(range.to), value: Number(range.value) })) : [],
        repasseMode: data.repasseMode, repassePercent: data.repasseMode === 'percentage' ? Number(data.repassePercent) : 100 };
    }
    return { company: { supportPhone: data.supportPhone.trim() || null, timeZone: data.timeZone,
      routeGroupingPolicy: data.routeGroupingPolicy, operationalLocation: location }, deliveryPricing };
  }

  async function submitProvision() {
    if (busy) return;
    busy = true; setMessage('Gravando a empresa e solicitando o envio do convite…', 'working'); renderActions();
    if (!operationKey) operationKey = `bootstrap-${crypto.randomUUID()}`;
    try { sessionStorage.setItem(idempotencyKey, operationKey); } catch (_) {}
    const request = { companyName: data.companyName.trim(), email: data.email.trim().toLowerCase(),
      idempotencyKey: operationKey, initialSetup: makeInitialSetup() };
    try {
      const result = await fetchJson('/admin/tenants/provision', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'X-RotaMoto-Bootstrap-Authorization': capability }, body: JSON.stringify(request) });
      if (result.setupState !== 'awaiting_owner_activation_and_mfa' || result.setupReadback !== true ||
          !['sent', 'failed', 'pending'].includes(result.delivery))
        throw Object.assign(new Error('O servidor não confirmou o estado esperado da instalação.'), { code: 'INVALID_RESPONSE' });
      finished = { ...result, message: result.delivery === 'failed' ? 'O envio do convite não foi confirmado.' : '' };
      if (result.delivery === 'sent') {
        capability = '';
        const codeInput = stage.querySelector('[name="capability"]'); if (codeInput) codeInput.value = '';
        try { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(idempotencyKey); } catch (_) {}
      }
      setMessage(result.delivery === 'sent' ? 'A configuração inicial foi gravada e o serviço aceitou o envio do convite.' : 'O cadastro foi preservado, mas o envio ainda não foi confirmado.', result.delivery === 'sent' ? 'success' : 'error');
    } catch (error) {
      finished = { delivery: 'failed', message: error.name === 'AbortError' ? 'A resposta demorou. A operação pode ter sido registrada; use a mesma autorização para tentar novamente.' : error.message || 'Não foi possível confirmar a operação.' };
      setMessage(finished.message, 'error');
    } finally { busy = false; render(); }
  }

  function setupTheme() {
    const root = document.documentElement;
    const saved = (() => { try { return sessionStorage.getItem('rotamoto.bootstrap.theme'); } catch (_) { return null; } })();
    let dark = saved === 'dark' || saved !== 'light' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    const apply = () => { root.dataset.resolvedTheme = dark ? 'dark' : 'light'; root.dataset.theme = dark ? 'dark' : 'light'; root.style.colorScheme = dark ? 'dark' : 'light'; $('[data-theme-toggle]').textContent = dark ? 'Tema claro' : 'Tema escuro'; };
    $('[data-theme-toggle]').addEventListener('click', () => { dark = !dark; apply(); try { sessionStorage.setItem('rotamoto.bootstrap.theme', dark ? 'dark' : 'light'); } catch (_) {} });
    apply();
  }

  stage.addEventListener('input', onInput);
  stage.addEventListener('change', onInput);
  stage.addEventListener('click', event => {
    if (event.target.closest('[data-smtp-validate]')) { void validateSmtpFromForm(); return; }
    if (event.target.closest('[data-smtp-test]')) { void testSmtpFromForm(); return; }
    const add = event.target.closest('[data-add-range]');
    if (add) {
      syncForm(); data.ranges.push({ from: data.ranges.at(-1)?.to || '', to: '', value: '' }); saveDraft(); render(); return;
    }
    const remove = event.target.closest('[data-remove-range]');
    if (remove) {
      syncForm(); const index = Number(remove.closest('[data-range-row]')?.dataset.rangeRow);
      if (Number.isInteger(index) && data.ranges.length > 1) data.ranges.splice(index, 1);
      saveDraft(); render();
    }
  });
  setupTheme();
  render();
  diagnose();
})();
