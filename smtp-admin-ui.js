(() => {
  'use strict';
  const API = String(window.ROTA_MOTO_API_BASE || '/api').replace(/\/$/u, '');
  const escape = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  async function request(path, method = 'GET', body = null) {
    const response = await fetch(`${API}${path}`, { method, credentials: 'include', cache: 'no-store',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': window.RotaMotoSessionGuard?.getCsrfToken?.() || '' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let result = {}; try { result = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(result.error?.message || 'Não foi possível atualizar o SMTP.');
    return result;
  }
  function mount(root) {
    if (!root || root.dataset.loading === 'true' || root.dataset.loaded === 'true') return;
    root.dataset.loading = 'true'; root.innerHTML = '<article class="setting-card" role="status">Carregando a configuração protegida…</article>';
    request('/admin/smtp/config').then(config => { root.dataset.loaded = 'true'; render(root, config); })
      .catch(error => { root.dataset.loaded = 'true'; root.innerHTML = `<article class="setting-card" role="alert"><h2>SMTP indisponível</h2><p>${escape(error.message)}</p></article>`; })
      .finally(() => { root.dataset.loading = 'false'; });
  }
  function render(root, config, notice = '') {
    const active = config?.configured === true;
    const transportActive = config?.transportConfigured === true;
    const invitationLinksActive = config?.invitationLinksConfigured === true;
    const reusable = config?.credentialStored === true || config?.existingCredentialAvailable === true;
    root.innerHTML = `<article class="setting-card smtp-admin-card"><div class="setting-heading"><h2>E-mail e notificações</h2><p>Transporte SMTP do servidor e disponibilidade separada dos links externos de convite. Alterações exigem Super ADM Global e sessão autenticada com MFA.</p></div><p class="setting-note" data-state>${transportActive ? `Transporte SMTP testado · ${escape(config.provider)} · ${escape(config.host)}:${Number(config.port)} · ${escape(config.lastTestStatus || 'sem teste')}.` : config?.disabled ? 'Transporte SMTP desativado.' : reusable ? `Credencial SMTP existente disponível · ${escape(config.provider)} · ${escape(config.host)}:${Number(config.port)}. Faça um teste para habilitar o transporte.` : 'Nenhum transporte SMTP testado e configurado.'} ${invitationLinksActive ? 'Convites externos habilitados por URL HTTPS.' : 'Envios de convite externo permanecem bloqueados até informar uma URL HTTPS pública.'} A credencial está protegida e nunca é exibida. ${escape(notice)}</p><form data-smtp-form><label>Provedor<select class="select" name="provider"><option value="gmail">Gmail</option><option value="microsoft365">Outlook / Microsoft 365</option><option value="custom">SMTP personalizado</option></select></label>${reusable ? '<div class="setting-note"><label><input type="checkbox" name="reuseStoredCredential" checked> Reutilizar a credencial SMTP protegida existente</label><small>A senha permanece no keystore e não é exibida.</small></div>' : ''}<div class="setting-grid"><label>E-mail do remetente<input class="input" name="senderEmail" type="email" autocomplete="email" maxlength="254" required value="${escape(config?.senderEmail || '')}"></label><label>Nome de exibição<input class="input" name="senderName" maxlength="120" required value="${escape(config?.senderName || 'RotaMoto')}"></label><label>Host SMTP<input class="input" name="host" autocapitalize="none" spellcheck="false" required value="${escape(config?.host || 'smtp.gmail.com')}"></label><label>Porta<input class="input" name="port" type="number" min="1" max="65535" required value="${Number(config?.port) || 465}"></label><label>TLS<select class="select" name="tlsMode"><option value="tls">TLS implícito</option><option value="starttls">STARTTLS</option></select></label><label>Autenticação<select class="select" name="authMethod"><option value="password">Usuário e senha SMTP</option><option value="oauth" disabled>OAuth indisponível</option></select></label><label>Usuário SMTP<input class="input" name="username" autocomplete="username" ${reusable ? 'disabled' : 'required'} value="" placeholder="${reusable ? 'Credencial protegida será reutilizada' : ''}"></label><label>Senha SMTP / senha de app<input class="input" name="password" type="password" autocomplete="new-password" maxlength="4096" ${reusable ? 'disabled' : 'required'}></label><label>Destinatário do teste<input class="input" name="testRecipient" type="email" autocomplete="email" required value="${escape(config?.testRecipient || config?.senderEmail || '')}"></label><label>URL HTTPS pública dos convites (opcional)<input class="input" name="publicBaseUrl" type="url" autocomplete="url" value="${escape(config?.publicBaseUrl || '')}"><small>Sem esta URL o SMTP pode ser testado e salvo, mas convites externos continuam bloqueados. Adicione-a depois sem reinstalar.</small></label></div><p class="setting-note" data-provider-note>Gmail exige senha de app com verificação em duas etapas ativa. OAuth não está implementado.</p><div class="actions"><button class="btn" type="button" data-smtp-validate>Validar parâmetros</button><button class="btn primary" type="button" data-smtp-test>Testar e salvar</button>${active ? '<button class="btn danger" type="button" data-smtp-disable>Desativar transporte</button>' : ''}</div><p class="save-status" data-result role="status" aria-live="polite">${transportActive ? 'O servidor SMTP aceitou o último teste; isso não confirma a entrega na caixa de entrada.' : 'A senha não é salva neste aparelho. Só será persistida no keystore após o servidor aceitar o envio de teste.'}</p></form></article>`;
    const form = root.querySelector('[data-smtp-form]'), result = root.querySelector('[data-result]');
    form.elements.provider.value = config?.provider || 'gmail'; form.elements.tlsMode.value = config?.tlsMode || 'tls';
    const setStatus = (message, state = '') => { result.textContent = message; result.dataset.state = state; };
    const setBusy = value => root.querySelectorAll('button').forEach(button => { button.disabled = value; });
    const settings = () => ({ ...Object.fromEntries(new FormData(form).entries()), reuseStoredCredential: form.elements.reuseStoredCredential?.checked === true });
    const credentialToggle = form.elements.reuseStoredCredential;
    const syncCredentialMode = () => { const reuse = credentialToggle?.checked === true; for (const name of ['username','password']) { form.elements[name].disabled = reuse; form.elements[name].required = !reuse; } };
    credentialToggle?.addEventListener('change', syncCredentialMode); syncCredentialMode();
    form.elements.provider.addEventListener('change', () => {
      if (credentialToggle) credentialToggle.checked = false; syncCredentialMode();
      const microsoft = form.elements.provider.value === 'microsoft365';
      if (form.elements.provider.value !== 'custom') {
        form.elements.host.value = microsoft ? 'smtp.office365.com' : 'smtp.gmail.com';
        form.elements.port.value = microsoft ? '587' : '465'; form.elements.tlsMode.value = microsoft ? 'starttls' : 'tls';
      }
      root.querySelector('[data-provider-note]').textContent = microsoft
        ? 'Microsoft 365 requer SMTP AUTH habilitado para a caixa. Este fluxo não oferece OAuth.'
        : form.elements.provider.value === 'gmail'
          ? 'Gmail exige senha de app com verificação em duas etapas ativa. OAuth não está implementado.'
          : 'SMTP personalizado aceita apenas host público, TLS/STARTTLS e autenticação por senha.';
    });
    root.querySelector('[data-smtp-validate]').addEventListener('click', async () => {
      if (!form.reportValidity()) return; setBusy(true); setStatus('Validando parâmetros…', 'working');
      try { const value = await request('/admin/smtp/validate', 'POST', settings()); setStatus(`Parâmetros válidos: ${value.host}:${value.port} (${value.tlsMode}). Teste o envio para habilitar o transporte.`, 'success'); }
      catch (error) { setStatus(error.message, 'error'); } finally { setBusy(false); }
    });
    root.querySelector('[data-smtp-test]').addEventListener('click', async () => {
      if (!form.reportValidity()) return; setBusy(true); setStatus('Conectando, autenticando e enviando a mensagem de teste…', 'working');
      try { const value = await request('/admin/smtp/test', 'POST', { requestId: crypto.randomUUID(), settings: settings() });
        form.elements.password.value = ''; const latest = await request('/admin/smtp/config'); render(root, latest, value.notice || 'Aceito pelo SMTP; entrega final não confirmada.');
      } catch (error) { setStatus(error.message, 'error'); } finally { setBusy(false); }
    });
    root.querySelector('[data-smtp-disable]')?.addEventListener('click', async () => {
      if (!window.confirm('Desativar SMTP impedirá convites, verificações de e-mail e recuperações de acesso. Continuar?')) return;
      setBusy(true); setStatus('Desativando o transporte…', 'working');
      try { await request('/admin/smtp/disable', 'POST', {}); render(root, { configured: false }, 'Transporte desativado.'); }
      catch (error) { setStatus(error.message, 'error'); } finally { setBusy(false); }
    });
  }
  window.RotaMotoSmtpAdmin = Object.freeze({ mount });
})();
