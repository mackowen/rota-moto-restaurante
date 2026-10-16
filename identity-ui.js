(() => {
  'use strict';
  const API = String(window.ROTA_MOTO_API_BASE || '/api').replace(/\/$/u, '');
  let csrf = null;
  let current = null;
  const LOCAL_MODE_KEY = 'rotamoto.restaurante.local-mode.v1';
  function readLocalMode() { try { return localStorage.getItem(LOCAL_MODE_KEY) === '1'; } catch (_) { return false; } }
  function writeLocalMode(enabled) { try { enabled ? localStorage.setItem(LOCAL_MODE_KEY, '1') : localStorage.removeItem(LOCAL_MODE_KEY); } catch (_) { /* O modo local continua disponível nesta página. */ } }
  let offlineMode = readLocalMode();
  let invitationKind = 'membership_invitation';
  const sessionReadGuard = window.RotaMotoSessionGuard.createSessionReadGuard();
  let working = false;
  let driverRows = [];
  let driverCursor = null;
  let previousFocus = null;
  let marketplaceCallback = null;
  try {
    const callbackUrl = new URL(location.href);
    const callbackState = callbackUrl.searchParams.get('state');
    const authId = callbackUrl.searchParams.get('authId');
    if (callbackUrl.searchParams.get('marketplace') === 'keeta' && callbackState && authId && callbackState.length <= 64 && authId.length <= 128) {
      marketplaceCallback = { state: callbackState, authId };
      callbackUrl.searchParams.delete('state'); callbackUrl.searchParams.delete('authId'); callbackUrl.searchParams.delete('marketplace');
      history.replaceState(null, '', callbackUrl.pathname + callbackUrl.search + callbackUrl.hash);
    }
  } catch (_) {}
  const codeMessages = {
    INVALID_CREDENTIALS: 'Email ou senha inválidos.', MFA_REQUIRED: 'Esta conta precisa de um código de verificação. Configure o aplicativo autenticador para entrar.', MFA_PROVIDER_UNAVAILABLE: 'A verificação em duas etapas está temporariamente indisponível. Tente novamente mais tarde.',
    UNAUTHENTICATED: 'Sua sessão expirou. Entre novamente.', EMAIL_PROVIDER_NOT_CONFIGURED: 'Convites e recuperação ainda dependem da configuração segura de entrega de email.',
    FORBIDDEN: 'Seu perfil não permite esta ação.', LAST_OWNER_REQUIRED: 'A empresa precisa manter ao menos um responsável principal ativo.',
    DRIVER_MEMBERSHIP_INELIGIBLE: 'A conta precisa estar ativa, confirmada e autorizada para usar o app Motoboy.',
    DRIVER_NOT_FOUND: 'Motoboy não encontrado nesta empresa.', DRIVER_ALREADY_LINKED: 'Este motorista já está associado a outra conta.',
    MEMBERSHIP_DRIVER_CONFLICT: 'Desvincule o motorista atual antes de trocar a associação.',
    INVALID_STATE_TRANSITION: 'Esta mudança de estado não é permitida.', EMAIL_DELIVERY_FAILED: 'Não foi possível entregar o convite. Nenhum link utilizável foi enviado.', AUTHENTICATION_REQUIRED: 'Entre na conta existente para aceitar este convite.', CONFLICT: 'A conta já possui um vínculo ou estado incompatível.',
    RATE_LIMITED: 'Muitas tentativas. Aguarde antes de tentar novamente.', NETWORK: 'Sem conexão com o servidor. Os dados salvos neste aparelho continuam disponíveis; ações que precisam do servidor ficam pausadas.',
    PROVIDER_CREDENTIALS_NOT_CONFIGURED: 'Peça ao administrador para concluir a configuração segura do aplicativo.',
    MARKETPLACE_ACCOUNT_LIFECYCLE_UNAVAILABLE: 'A integração ainda não está configurada. Peça ao administrador para concluir a configuração segura.',
    OAUTH_STATE_EXPIRED_OR_USED: 'Esta autorização expirou ou já foi usada. Inicie uma nova autorização.',
    AUTHORIZED_MERCHANT_NOT_VISIBLE_YET: 'A autorização foi concluída, mas as lojas ainda não apareceram. Toque em “Verificar lojas novamente” daqui a pouco. Não repita a autorização.',
    PROVIDER_BLOCKED_EXTERNAL: 'A 99Food exige acesso de onboarding e contrato oficial antes de habilitar a integração.'
  };
  const host = document.createElement('div');
  host.id = 'rmIdentityRoot';
  host.innerHTML = `<button type="button" class="rm-account-trigger" aria-label="Abrir conta e acesso" aria-controls="rmIdentityPanel" aria-expanded="false">Conta</button>
    <section id="rmIdentityPanel" class="rm-identity-panel" role="dialog" aria-modal="true" aria-labelledby="rmIdentityTitle" hidden>
      <header><div><strong id="rmIdentityTitle">Conta RotaMoto</strong><small data-identity-status>Verificando sua conta…</small></div><button type="button" data-close aria-label="Fechar painel">×</button></header>
      <div class="rm-identity-content">
        <form data-login novalidate><h2>Entrar</h2><label>Email<input name="email" type="email" autocomplete="username" required maxlength="320"></label>
          <label>Senha<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
          <label data-mfa-label hidden>Código de verificação ou recuperação<input name="mfaCode" autocomplete="one-time-code" minlength="6" maxlength="128"></label>
          <label>Código da empresa<input name="companyId" autocomplete="off" spellcheck="false" aria-describedby="companyHelp" required></label>
          <small id="companyHelp">Use o código recebido no convite. O servidor confirma o vínculo da conta.</small>
          <button class="rm-primary" type="submit">Entrar</button><p data-login-error role="alert" aria-live="polite"></p></form>
        <div data-authenticated hidden><div class="rm-account-summary"><b data-user-email></b><span data-company-name>Empresa ativa</span><span>Código: <code data-company-id></code></span></div>
          <section data-mfa hidden><h3>Verificação em duas etapas</h3><p data-mfa-status role="status"></p>
            <button type="button" data-mfa-start>Configurar verificação em duas etapas</button>
          <form data-mfa-confirm hidden><p>Escaneie o QR Code ou informe a chave manual no aplicativo autenticador. Digite o código atual para confirmar.</p><canvas data-mfa-qr width="208" height="208" role="img" aria-label="QR Code para configurar autenticação em duas etapas"></canvas><label>Chave de configuração<input data-mfa-secret readonly autocomplete="off"></label><label>Código de confirmação<input name="code" inputmode="numeric" autocomplete="one-time-code" required minlength="6" maxlength="6"></label><button type="submit">Confirmar código</button><p data-mfa-error role="alert"></p></form>
            <section data-recovery-codes hidden><h4>Códigos de recuperação</h4><p>Guarde-os fora deste navegador. Cada código só pode ser usado uma vez.</p><pre data-recovery-code-list></pre><button type="button" data-recovery-codes-dismiss>Ocultar códigos</button></section>
            <button type="button" data-mfa-regenerate hidden>Gerar novos códigos de recuperação</button>
          </section>
          <form data-accept-existing><label>Código de convite para sua conta<input name="token" required maxlength="43" autocomplete="off"></label><button type="submit">Aceitar convite</button><p role="status" data-existing-invitation-result></p></form>
          <form data-switch><label>Trocar empresa<input name="companyId" autocomplete="off" spellcheck="false" required></label><button type="submit">Confirmar troca</button><p data-switch-error role="alert"></p></form>
          <button type="button" data-sync>Atualizar dados agora</button><button type="button" data-logout class="rm-secondary">Sair</button><p data-account-error role="alert" aria-live="polite"></p>
        </div>
        <details data-recovery><summary>Recuperar acesso</summary><form data-recovery-request><label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><button type="submit">Solicitar recuperação</button><p role="status" data-recovery-status></p></form>
          <form data-recovery-consume><label>Código recebido<input name="token" autocomplete="one-time-code" required maxlength="43"></label><label>Nova senha<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><button type="submit">Alterar senha</button><p role="status" data-recovery-result></p></form></details>
        <details data-invitation><summary>Aceitar convite</summary><form data-accept-invitation><label>Código do convite<input name="token" required maxlength="43" autocomplete="off"></label><label>Crie sua senha<input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="new-password"></label><button type="submit">Aceitar convite</button><p role="status" data-invitation-result></p></form></details>
        <section data-admin hidden><h2>Administração da empresa</h2><p data-admin-error role="alert" aria-live="polite"></p><button type="button" data-refresh-admin>Atualizar usuários e perfis</button>
          <form data-invite><h3>Convidar usuário</h3><label>Email<input name="email" type="email" required maxlength="320"></label><label>Perfil<select name="roleId" required></select></label><button type="submit">Enviar convite</button><p role="status" data-invite-result></p></form>
          <section data-integrations hidden><h3>Integrações disponíveis</h3><div></div></section><div data-members aria-live="polite"></div><p data-members-note role="status" hidden>Seu perfil não permite consultar os usuários desta empresa.</p><p data-driver-access-note role="status" hidden>Para listar motoristas, sua sessão precisa da permissão de leitura de sync. A desassociação continua disponível para vínculos existentes.</p><section data-roles-list><h3>Perfis existentes</h3></section><form data-create-role><h3>Novo perfil</h3><label>Identificador<input name="key" required pattern="[a-z][a-z0-9_-]{1,63}" maxlength="64"></label><label>Nome<input name="name" required maxlength="100"></label><fieldset><legend>Permissões</legend><div data-permissions></div></fieldset><button type="submit">Criar perfil</button><p role="status" data-role-result></p></form>
        </section>
        <button type="button" data-offline class="rm-offline">Continuar somente com dados locais</button>
        <p class="rm-privacy">Em produção, sua senha e seus códigos são enviados ao servidor por uma conexão segura. Eles não ficam salvos neste aparelho.</p>
      </div>
    </section>`;
  document.body.append(host);
  const $ = (selector, root = host) => root.querySelector(selector);
  const panel = $('#rmIdentityPanel');
  const trigger = $('.rm-account-trigger');
  const appKind = document.currentScript?.dataset.app || 'restaurante';
  function updateTriggerLabel() {
    trigger.innerHTML = `<span class="rm-account-trigger-label">${offlineMode ? 'Dados locais' : 'Conta'}</span><svg class="rm-account-trigger-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/></svg>`;
    trigger.setAttribute('aria-label', offlineMode ? 'Dados locais. Abrir opções da conta; sem sessão autenticada' : 'Abrir conta e acesso');
    trigger.title = offlineMode ? 'Modo local: sem sessão autenticada' : 'Abrir conta e acesso';
  }
  if (appKind !== 'restaurante') $('[data-admin]').remove();
  function message(error) { return codeMessages[error?.code] || (error?.network ? codeMessages.NETWORK : 'Não foi possível concluir. Revise os dados e tente novamente.'); }
  async function syncAfterAuthentication() {
    try {
      await window.RotaMotoSync?.restoreSession?.({ apiBase: API });
      await window.RotaMotoSync?.syncNow?.({ apiBase: API });
    } catch (_) { /* a falha de rede mantém a sessão e os dados locais utilizáveis */ }
  }
  async function request(path, options = {}, retried = false) {
    const method = options.method || 'GET';
    const activeCsrf = window.RotaMotoSessionGuard?.getCsrfToken() || csrf;
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(activeCsrf && method !== 'GET' ? { 'X-CSRF-Token': activeCsrf } : {}), ...(options.headers || {}) };
    let response;
    try { response = await fetch(`${API}${path}`, { credentials: 'include', cache: 'no-store', ...options, headers }); }
    catch (_) { const error = new Error('NETWORK'); error.network = true; throw error; }
    let body = {}; try { body = await response.json(); } catch (_) {}
    if (response.status === 401 && path !== '/identity/session') expireSession();
    if (!response.ok && response.status === 403 && body.error?.code === 'CSRF_INVALID' && method !== 'GET' && !retried) {
      const session = await restore(); if (session) return request(path, options, true);
    }
    if (!response.ok) { const error = new Error(body.error?.code || 'REQUEST_FAILED'); error.code = body.error?.code; error.status = response.status; throw error; }
    return body;
  }
  function placeTrigger() {
    const app = document.querySelector('#app');
    const anchor = current || offlineMode ? app?.querySelector('.pilot-command-head .pilot-head-actions, .top-actions, .top') : null;
    const parent = anchor || host;
    if (trigger.parentElement !== parent) parent.append(trigger);
    trigger.classList.toggle('rm-account-trigger--inline', Boolean(anchor));
  }
  const placementRoot = document.body;
  if (placementRoot && window.MutationObserver) {
    new MutationObserver(() => placeTrigger()).observe(placementRoot, { childList: true, subtree: true });
  }
  function visibleControls() {
    return [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[href],[tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
  }
  function setOpen(open) {
    if (open && panel.hidden) previousFocus = document.activeElement;
    if (!open) clearMfaEnrollment();
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    const app = document.querySelector('#app');
    const gated = host.dataset.gated === 'true';
    if (app) { app.inert = open || gated; app.setAttribute('aria-hidden', String(open || gated)); }
    if (open) (visibleControls()[0] || panel).focus();
    else if (previousFocus?.isConnected && !panel.contains(previousFocus) && !previousFocus.closest('[inert]')) previousFocus.focus();
    else if (!gated) trigger.focus();
  }
  panel.tabIndex = -1;
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (current || offlineMode) { event.preventDefault(); setOpen(false); }
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = visibleControls();
    if (!controls.length) { event.preventDefault(); panel.focus(); return; }
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  function setStatus(text) { $('[data-identity-status]').textContent = text; }
  function setBusy(form, busy) { form.querySelectorAll('button').forEach(button => { button.disabled = busy; }); }
  function showSession(session) {
    current = session;
    if (session) { offlineMode = false; writeLocalMode(false); }
    else offlineMode = readLocalMode();
    $('[data-login]').hidden = Boolean(session); $('[data-authenticated]').hidden = !session;
    $('[data-offline]').hidden = Boolean(session); $('[data-recovery]').hidden = Boolean(session);
    $('[data-invitation]').hidden = Boolean(session);
    const inviteForm = $('[data-invite]');
    const membersList = $('[data-members]');
    const membersNote = $('[data-members-note]');
    if (inviteForm) inviteForm.hidden = !session?.permissions?.includes('members.invite');
    if (membersList) membersList.hidden = !session?.permissions?.includes('members.read');
    if (membersNote) membersNote.hidden = Boolean(session?.permissions?.includes('members.read'));
    const appRoot = document.querySelector('#app');
    if (appRoot) { appRoot.inert = !session && !offlineMode; appRoot.setAttribute('aria-hidden', String(!session && !offlineMode)); }
    host.dataset.gated = String(!session && !offlineMode);
    $('[data-admin]').hidden = !(session && appKind === 'restaurante' && session.permissions?.includes('company.manage'));
    trigger.hidden = false;
    placeTrigger();
    updateTriggerLabel();
    if (session) {
      $('[data-user-email]').textContent = session.email;
      $('[data-company-id]').textContent = session.activeCompanyId;
      try { localStorage.setItem('rotaMoto.activeCompanyHint', session.activeCompanyId); } catch (_) {}
      const mfaBox=$('[data-mfa]');mfaBox.hidden=!(session.mfaEnrollmentRequired||session.mfaConfigured);
      $('[data-mfa-status]').textContent=session.mfaEnrollmentRequired?'Acesso limitado até confirmar o autenticador.':session.mfaConfigured?'Verificação em duas etapas configurada. A chave não pode ser consultada novamente.':'Verificação em duas etapas não configurada.';
      $('[data-mfa-start]').hidden=!session.mfaEnrollmentRequired&&session.mfaConfigured;
      $('[data-mfa-regenerate]').hidden=!(session.mfaConfigured&&session.mfaVerified&&session.permissions?.includes('company.manage'));
      $('[data-sync]').hidden=Boolean(session.mfaEnrollmentRequired);
      setStatus(session.mfaEnrollmentRequired?'Acesso limitado · configure a verificação em duas etapas':'Sessão ativa');
      $('[data-login-error]').textContent = '';
      if (!$('[data-admin]').hidden) loadAdmin().catch(error => { $('[data-admin-error]').textContent = message(error); });
    } else {
      setStatus(offlineMode ? 'Sem conta do servidor · dados deste aparelho' : navigator.onLine === false ? 'Sem conexão · usando dados deste aparelho' : 'Entre para acessar sua conta.');
    }
  }
  function expireSession() {
    if (!current) return;
    sessionReadGuard.invalidate();
    csrf = null; window.RotaMotoSessionGuard?.clearCsrfToken(); current = null; offlineMode = false; writeLocalMode(false);
    Promise.resolve(window.RotaMotoSync?.clearSession?.()).catch(() => {});
    showSession(null); setOpen(true);
    $('[data-login-error]').textContent = 'Sua sessão expirou ou deixou de estar válida. Entre novamente.';
    setStatus('Sessão expirada. Entre novamente.');
  }
  async function restore() {
    const readVersion = sessionReadGuard.capture();
    const hadAuthenticatedSession = Boolean(current);
    try {
      const session = window.RotaMotoSessionGuard?.withSessionRead
        ? await window.RotaMotoSessionGuard.withSessionRead(() => fetch(`${API}/identity/session`, { credentials: 'include', cache: 'no-store' }))
        : await request('/identity/session');
      if (!sessionReadGuard.isCurrent(readVersion)) return current;
      if (typeof session.csrfToken !== 'string') throw Object.assign(new Error(), { code: 'UNAUTHENTICATED' });
      csrf = session.csrfToken; window.RotaMotoSessionGuard?.setCsrfToken(csrf); showSession(session);
      if (marketplaceCallback && session.permissions?.includes('integrations.manage') && !session.mfaEnrollmentRequired) {
        const callback = marketplaceCallback; marketplaceCallback = null;
        try {
          await request('/admin/integrations/keeta/complete', { method: 'POST', body: JSON.stringify(callback) });
          setStatus('Loja Keeta autorizada. Atualize Integrações para conferir a conta.');
          if (current.permissions?.includes('company.manage')) await loadAdmin();
        } catch (error) { setStatus(message(error)); }
      }
      return session;
    } catch (error) {
      if (!sessionReadGuard.isCurrent(readVersion)) return current;
      csrf = null; window.RotaMotoSessionGuard?.clearCsrfToken(); current = null; showSession(null);
      if (error.status === 401) {
        $('[data-login-error]').textContent = window.RotaMotoSessionGuard.sessionRestoreErrorMessage(error, hadAuthenticatedSession, message);
      }
      return null;
    }
  }
  function hintedCompany() { try { return localStorage.getItem('rotaMoto.activeCompanyHint') || ''; } catch (_) { return ''; } }
  function applyMailAction(){let params;try{params=new URLSearchParams(location.hash.slice(1))}catch(_){return}const action=params.get('action'),token=params.get('token');if(!token||token.length>43)return;if(action==='password_recovery'){$('[data-recovery-consume] [name=token]').value=token;$('[data-recovery]').open=true;setOpen(true)}else if(['owner_invitation','membership_invitation'].includes(action)){invitationKind=action;$('[data-accept-invitation] [name=token]').value=token;$('[data-invitation]').open=true;setOpen(true)}if(action==='password_recovery'||['owner_invitation','membership_invitation'].includes(action))history.replaceState(null,'',location.pathname+location.search)}
  applyMailAction();
  $('[data-login] [name=companyId]').value = hintedCompany();
  function clearMfaEnrollment(){const canvas=$('[data-mfa-qr]');canvas?.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);$('[data-mfa-secret]').value=''}
  function renderMfaQr(uri){const canvas=$('[data-mfa-qr]'),context=canvas?.getContext('2d'),encoder=window.RotaMotoQRCode;
    if(!canvas||!context||typeof encoder!=='function')throw new Error('QR local indisponível. Use a chave manual.');
    const code=new encoder(0,window.RotaMotoQRErrorCorrectLevel?.M??0);code.addData(uri);code.make();
    const modules=code.getModuleCount(),scale=Math.floor(canvas.width/(modules+8)),offset=Math.floor((canvas.width-modules*scale)/2);
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#111';
    for(let row=0;row<modules;row++)for(let column=0;column<modules;column++)if(code.isDark(row,column))context.fillRect(offset+column*scale,offset+row*scale,scale,scale);
  }
  $('[data-mfa-start]').addEventListener('click',async()=>{const button=$('[data-mfa-start]');button.disabled=true;$('[data-mfa-error]').textContent='';try{const result=await request('/identity/mfa/enrollment',{method:'POST',body:'{}'});$('[data-mfa-secret]').value=result.secret;$('[data-mfa-confirm]').hidden=false;renderMfaQr(result.otpauthUri);$('[data-mfa-status]').textContent='Escaneie o QR Code ou use a chave manual. Confirme com o código atual.';$('[data-mfa-confirm] [name=code]').focus()}catch(error){$('[data-mfa-error]').textContent=message(error)}finally{button.disabled=false}});
  $('[data-mfa-confirm]').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity()||working)return;working=true;setBusy(form,true);try{const result=await request('/identity/mfa/enrollment/confirm',{method:'POST',body:JSON.stringify({code:form.elements.code.value})});clearMfaEnrollment();$('[data-mfa-confirm]').hidden=true;$('[data-mfa-status]').textContent='Verificação em duas etapas configurada. A chave foi removida desta tela.';$('[data-recovery-code-list]').textContent=result.recoveryCodes.join('\n');$('[data-recovery-codes]').hidden=false;await restore()}catch(error){form.elements.code.value='';$('[data-mfa-error]').textContent=message(error)}finally{working=false;setBusy(form,false)}});
  $('[data-recovery-codes-dismiss]').addEventListener('click',()=>{$('[data-recovery-code-list]').textContent='';$('[data-recovery-codes]').hidden=true});
  $('[data-mfa-regenerate]').addEventListener('click',async event=>{const button=event.currentTarget;if(working)return;working=true;button.disabled=true;try{const result=await request('/identity/mfa/recovery-codes',{method:'POST',body:'{}'});$('[data-recovery-code-list]').textContent=result.recoveryCodes.join('\n');$('[data-recovery-codes]').hidden=false}catch(error){$('[data-mfa-error]').textContent=message(error)}finally{working=false;button.disabled=false}});
  $('.rm-account-trigger').addEventListener('click', () => setOpen(panel.hidden));
  $('[data-close]').addEventListener('click', () => { if (current || offlineMode) setOpen(false); });
  $('[data-login]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    sessionReadGuard.invalidate();
    working = true; setBusy(form, true); $('[data-login-error]').textContent = ''; setStatus('Autenticando…');
    const data = new FormData(form); const password = data.get('password');
    try {
      const body = { email: String(data.get('email')).trim(), password: String(password), ...(data.get('companyId') ? { companyId: String(data.get('companyId')).trim() } : {}), ...(data.get('mfaCode') ? { mfaCode: String(data.get('mfaCode')).trim() } : {}) };
      const result = await request('/identity/login', { method: 'POST', body: JSON.stringify(body) });
      csrf = result.csrfToken; window.RotaMotoSessionGuard?.setCsrfToken(csrf); form.elements.password.value = ''; form.elements.mfaCode.value = ''; $('[data-mfa-label]').hidden = true;
      const session = await restore();
      if (!session) throw Object.assign(new Error(), { code: 'UNAUTHENTICATED' });
      if(session.mfaEnrollmentRequired){setOpen(true);$('[data-mfa-start]').focus()}else{await syncAfterAuthentication();setOpen(false)}
    } catch (error) { if (error.code === 'MFA_REQUIRED') { $('[data-mfa-label]').hidden = false; form.elements.mfaCode.focus(); } else { form.elements.password.value = ''; form.elements.mfaCode.value = ''; $('[data-mfa-label]').hidden = true; } $('[data-login-error]').textContent = message(error); setStatus('Não foi possível autenticar'); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-offline]').addEventListener('click', () => { sessionReadGuard.invalidate(); offlineMode = true; writeLocalMode(true); updateTriggerLabel(); const appRoot = document.querySelector('#app'); if (appRoot) { appRoot.inert = false; appRoot.setAttribute('aria-hidden', 'false'); } host.dataset.gated = 'false'; setStatus('Sem conta do servidor · dados deste aparelho'); setOpen(false); });
  $('[data-switch]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    working = true; setBusy(form, true); $('[data-switch-error]').textContent = '';
    try { await request('/identity/tenant', { method: 'POST', body: JSON.stringify({ companyId: form.elements.companyId.value.trim() }) }); await restore(); await syncAfterAuthentication(); }
    catch (error) { $('[data-switch-error]').textContent = message(error); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-logout]').addEventListener('click', async () => {
    if (working) return; working = true;
    sessionReadGuard.invalidate();
    try { await request('/identity/logout', { method: 'POST', body: '{}' }); csrf = null; current = null; await window.RotaMotoSync?.clearSession?.().catch(() => {}); showSession(null); setOpen(true); }
    catch (error) { $('[data-account-error]').textContent = message(error); }
    finally { working = false; }
  });
  $('[data-sync]')?.addEventListener('click', async () => { try { await window.RotaMotoSync?.syncNow?.(); $('[data-account-error]').textContent = 'Pedido de atualização enviado.'; } catch (error) { $('[data-account-error]').textContent = message(error); } });
  $('[data-recovery-request]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    const email = form.elements.email.value.trim(); setBusy(form, true);
    try { await request('/identity/recovery', { method: 'POST', body: JSON.stringify({ email }) }); $('[data-recovery-status]').textContent = 'Se a conta puder ser recuperada, as instruções serão entregues ao email cadastrado.'; }
    catch (error) { $('[data-recovery-status]').textContent = message(error); }
    finally { setBusy(form, false); }
  });
  $('[data-recovery-consume]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    setBusy(form, true); const password = form.elements.password.value;
    try { await request('/identity/recovery/consume', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim(), password }) }); form.reset(); $('[data-recovery-result]').textContent = 'Senha alterada. Entre novamente.'; }
    catch (error) { form.elements.password.value = ''; $('[data-recovery-result]').textContent = message(error); }
    finally { setBusy(form, false); }
  });
  $('[data-accept-invitation]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return;
    setBusy(form, true); const password = form.elements.password.value;
    try { const result = await request(invitationKind==='owner_invitation'?'/identity/invitations/accept':'/identity/membership-invitations/accept', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim(), password }) });
      form.reset(); try { localStorage.setItem('rotaMoto.activeCompanyHint', result.companyId); } catch (_) {} $('[data-invitation-result]').textContent = 'Convite aceito. Agora entre com seu email e senha.'; $('[data-login] [name=companyId]').value = result.companyId; }
    catch (error) { form.elements.password.value = ''; $('[data-invitation-result]').textContent = message(error); }
    finally { setBusy(form, false); }
  });
  $('[data-accept-existing]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return; setBusy(form, true);
    try { const result = await request('/identity/membership-invitations/accept-authenticated', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim() }) });
      form.reset(); $('[data-existing-invitation-result]').textContent = `Convite aceito para a empresa ${result.companyId}. Confirme a troca para ativar o vínculo.`; $('[data-switch] [name=companyId]').value = result.companyId; }
    catch (error) { $('[data-existing-invitation-result]').textContent = message(error); } finally { setBusy(form, false); }
  });
  async function loadAdmin({ appendDrivers = false } = {}) {
    const canReadMembers = current.permissions.includes('members.read');
    const canReadDrivers = current.permissions.includes('sync.pull');
    const [company, members, roles, permissionResult, integrations, marketplaceOrders] = await Promise.all([
      request('/admin/company'), canReadMembers ? request('/admin/memberships?limit=100') : Promise.resolve({ members: [] }), request('/admin/roles'), request('/admin/permissions'),
      current.permissions.includes('integrations.manage') ? request('/admin/integrations') : Promise.resolve(null),
      current.permissions.includes('orders.read') ? request('/admin/marketplace/orders?limit=50').catch(() => ({orders:[]})) : Promise.resolve({orders:[]})
    ]);
    const driverPage = canReadDrivers ? await request(`/domain/drivers?limit=100${appendDrivers && driverCursor ? `&cursor=${encodeURIComponent(driverCursor)}` : ''}`) : { records: [], nextCursor: null };
    if (!appendDrivers) driverRows = [];
    driverRows.push(...driverPage.records);
    driverCursor = driverPage.nextCursor;
    $('[data-driver-access-note]').hidden = canReadDrivers;
    $('[data-company-name]').textContent = company.name;
    const integrationBox = $('[data-integrations]'); integrationBox.hidden = !integrations;
    if (integrations) { const list = integrationBox.querySelector('div'); list.replaceChildren(); integrations.integrations.forEach(item => {
      const row = document.createElement('section'); row.className = 'rm-integration-status';
      const title = document.createElement('strong'); title.textContent = `${item.displayName || item.provider} · ${item.connectionVerified ? 'conectada' : 'sem conexão verificada'}`; row.append(title);
      const accounts = document.createElement('div'); accounts.className='rm-integration-accounts';
      const accountStates={active:'autorizada; conexão ainda não verificada',pending:'autorização pendente',disabled:'desativada localmente',revoked:'autorização revogada',reauthorization_required:'precisa reautorizar',error:'erro na conta'};
      const accountErrors={AUTH_EXPIRED:'A autorização expirou. Reautorize a conta.',AUTH_REJECTED:'A plataforma recusou a autorização. Reautorize a conta.',ACCOUNT_UNAVAILABLE:'Conta inativa ou sem vínculo válido.',MARKETPLACE_EVENT_PENDING:'Evento recebido e será processado novamente.',
        PROVIDER_TIMEOUT:'O cadastro pode ter sido recebido sem resposta. Confira o estado no fornecedor antes de reiniciar a autorização.',PROVIDER_TRANSIENT:'O fornecedor está temporariamente indisponível. Tente novamente mais tarde.',
        PROVIDER_REJECTED:'O fornecedor rejeitou o cadastro. Confira o vínculo da loja e os dados de onboarding.',KEETA_ONBOARDING_FAILED:'Não foi possível registrar o vínculo da loja na Keeta. Confira o ID de loja e tente reautorizar.'};
      const accountRows=item.externalAccounts||[];
      if(!accountRows.length){const account=document.createElement('p');account.textContent='Conta: nenhuma loja autorizada vinculada.';accounts.append(account);}
      accountRows.forEach(accountRow=>{
        const account=document.createElement('section');account.className='rm-integration-account';
        const name=document.createElement('strong');name.textContent=`Loja: ${accountRow.displayName||'identificada'} · ${accountStates[accountRow.accountStatus]||'estado não verificado'}`;account.append(name);
        const sync=document.createElement('p');sync.textContent=`Última atualização: ${accountRow.lastSyncAt?new Date(accountRow.lastSyncAt).toLocaleString():'ainda indisponível'}`;account.append(sync);
        if(accountRow.lastErrorCode){const issue=document.createElement('p');issue.setAttribute('role','status');issue.textContent=accountErrors[accountRow.lastErrorCode]||'A conta registrou um erro. Verifique a autorização e o acesso do fornecedor.';account.append(issue);}
        if(accountRow.accountStatus==='active'&&accountRow.id){const disable=document.createElement('button');disable.type='button';disable.textContent='Desativar localmente';
          disable.addEventListener('click',async()=>{disable.disabled=true;try{await request(`/admin/integrations/${encodeURIComponent(item.provider)}/accounts/${encodeURIComponent(accountRow.id)}/disable`,{method:'POST',body:'{}'});await loadAdmin();}
            catch(error){disable.disabled=false;const issue=document.createElement('p');issue.setAttribute('role','status');issue.textContent=message(error);account.append(issue);}});account.append(disable);}
        accounts.append(account);
      });
      if (['ifood','keeta','99food'].includes(item.provider)) {
        const connect = document.createElement('button'); connect.type = 'button';
        connect.textContent = item.provider==='99food'?'Vincular loja':accountRows.some(account => ['disabled','revoked','reauthorization_required','error'].includes(account.accountStatus)) ? 'Reautorizar conta' : 'Conectar conta';
        connect.addEventListener('click', async () => {
          connect.disabled = true;
          try {
            if(item.provider==='99food'){
              const form=document.createElement('form');form.className='rm-marketplace-auth';
              form.innerHTML='<label>ID da loja 99Food<input name="appShopId" required maxlength="128" autocomplete="off"></label><label>Nome para identificação (opcional)<input name="displayName" maxlength="160" autocomplete="off"></label><button type="submit">Validar e vincular loja</button><p role="status"></p>';
              form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button'),shop=form.elements.appShopId.value.trim(),name=form.elements.displayName.value.trim();
                if(!shop||button.disabled)return;button.disabled=true;
                try{await request('/admin/integrations/99food/authorize',{method:'POST',body:JSON.stringify({appShopId:shop,...(name?{displayName:name}:{})})});
                  form.elements.appShopId.value='';form.elements.displayName.value='';form.querySelector('[role=status]').textContent='Loja vinculada. Confira a última sincronização e o diagnóstico da conta.';await loadAdmin();}
                catch(error){form.querySelector('[role=status]').textContent=message(error);button.disabled=false;}
              });
              row.append(form);connect.textContent='Vincular outra loja';connect.disabled=false;return;
            }
            const started = await request(`/admin/integrations/${item.provider}/authorize`, { method: 'POST', body: '{}' });
            if (item.provider === 'keeta') { location.assign(started.authorizationUrl); return; }
            const instructions = document.createElement('div'); instructions.className = 'rm-marketplace-auth';
            const text = document.createElement('p'); text.textContent = `Acesse o portal iFood e informe o código ${started.userCode}. Depois cole aqui o código de autorização recebido. Ele expira em ${started.expiresIn} segundos.`;
            const link = document.createElement('a'); link.href = started.verificationUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Abrir autorização iFood';
            const form = document.createElement('form'); form.innerHTML = '<label>Código de autorização<input name="authorizationCode" required maxlength="512" autocomplete="off"></label><button type="submit">Concluir autorização</button><button type="button" data-ifood-resume hidden>Verificar lojas novamente</button><p role="status"></p>';
            const resume=form.querySelector('[data-ifood-resume]');
            resume.addEventListener('click',async()=>{resume.disabled=true;try{await request('/admin/integrations/ifood/complete',{method:'POST',body:JSON.stringify({state:started.state})});form.querySelector('[role=status]').textContent='Conta vinculada. Atualize Integrações para conferir a sincronização.';resume.hidden=true;await loadAdmin();}
              catch(error){form.querySelector('[role=status]').textContent=message(error);resume.disabled=false;}});
            form.addEventListener('submit', async event => {
              event.preventDefault(); const input = form.elements.authorizationCode; const button = form.querySelector('button');
              if (!input.value || button.disabled) return; button.disabled = true;
              try { await request('/admin/integrations/ifood/complete', { method: 'POST', body: JSON.stringify({ state: started.state, authorizationCode: input.value }) }); input.value = ''; form.querySelector('[role=status]').textContent = 'Autorização concluída. Atualize Integrações para conferir as lojas vinculadas.'; await loadAdmin(); }
              catch (error) { input.value = ''; form.querySelector('[role=status]').textContent = message(error); if(error.code==='AUTHORIZED_MERCHANT_NOT_VISIBLE_YET')resume.hidden=false; button.disabled = false; }
            });
            instructions.append(text, link, form); row.append(instructions); connect.textContent = 'Autorização iniciada';
          } catch (error) { const note = document.createElement('p'); note.setAttribute('role','status'); note.textContent = message(error); row.append(note); connect.disabled = false; }
        });
        row.append(connect);
      } else {
        const blocked = document.createElement('p'); blocked.textContent = 'O portal oficial anuncia API de pedidos, webhooks e sandbox. O contrato detalhado, credenciais e certificação exigem onboarding de parceiro; por isso o adapter e a conexão continuam desabilitados.';
        const docs = document.createElement('a'); docs.href = 'https://developer-food.99app.com/'; docs.target = '_blank'; docs.rel = 'noopener noreferrer'; docs.textContent = 'Abrir portal oficial de desenvolvimento 99Food'; row.append(blocked, docs);
      }
      row.append(accounts);
      const names = { account: 'autorização da conta', merchant: 'lojas/merchant', orders: 'pedidos', webhook: 'webhook', polling: 'consulta de eventos', selfDelivery: 'entrega própria', platformDelivery: 'entrega da plataforma', quote: 'cotação', dispatch: 'despacho', cancelOrder: 'cancelar pedido', cancelDelivery: 'cancelar entrega', tracking: 'rastreamento', sandbox: 'sandbox', homologation: 'homologação' };
      const dimensionLabels = [
        ['DOCUMENTED', 'Contrato público'], ['IMPLEMENTED', 'Adapter'], ['RUNTIME_WIRED', 'Runtime'],
        ['LOCAL_TESTED', 'Teste local'], ['SANDBOX_TESTED', 'Sandbox'], ['PRODUCTION_AUTHORIZED', 'Produção']
      ];
      const capabilities = document.createElement('div'); capabilities.className = 'rm-integration-capabilities';
      const legend = document.createElement('p'); legend.className = 'rm-integration-legend';
      legend.textContent = 'Contrato, código, conexão ao sistema, testes locais, sandbox e autorização de produção aparecem separados.';
      capabilities.append(legend);
      Object.entries(item.capabilities || {}).forEach(([key, dimensions]) => {
        const feature = document.createElement('div'); feature.className = 'rm-integration-capability';
        const featureName = document.createElement('strong'); featureName.textContent = names[key] || key; feature.append(featureName);
        const states = document.createElement('div'); states.className = 'rm-integration-dimensions';
        dimensionLabels.forEach(([dimension, label]) => {
          const state = document.createElement('span'); const available = Boolean(dimensions?.[dimension]);
          state.className = available ? 'is-available' : 'is-unavailable';
          state.textContent = `${label}: ${available ? 'sim' : 'não'}`;
          states.append(state);
        });
        feature.append(states); capabilities.append(feature);
      });
      if (!Object.keys(item.capabilities || {}).length) capabilities.append(document.createTextNode('Capacidades ainda não verificadas.'));
      row.append(capabilities);
      const syncState = item.lastEventAt ? new Date(item.lastEventAt).toLocaleString() : 'ainda não há atualização registrada';
      const notes = document.createElement('p'); notes.textContent = `${item.capabilityNotes || 'A conexão ainda não está ativa.'} Última atualização: ${syncState}.`; row.append(notes);
      list.append(row);
    });
      const orderPanel=document.createElement('section');orderPanel.className='rm-marketplace-orders';
      const orderHeading=document.createElement('h4');orderHeading.textContent='Pedidos de plataformas externas';orderPanel.append(orderHeading);
      const orderRows=Array.isArray(marketplaceOrders.orders)?marketplaceOrders.orders:[];
      const commandStates={queued:'Na fila',leased:'Em execução',pending:'Aguardando confirmação da plataforma',succeeded:'Confirmada pela plataforma',rejected:'Falhou',unknown_outcome:'Resultado incerto; reconciliação pendente',needs_review:'Precisa de revisão'};
      if(!orderRows.length){const empty=document.createElement('p');empty.textContent='Nenhum pedido dessa plataforma foi recebido ainda.';orderPanel.append(empty);}
      orderRows.forEach(order=>{
        const item=document.createElement('article');item.className='rm-marketplace-order';
        const providerName={ifood:'iFood',keeta:'Keeta','99food':'99Food'}[order.provider]||'Plataforma';
        const title=document.createElement('strong');title.textContent=`${providerName} · ${order.displayId||order.domainOrderId} · ${order.providerStatus||'estado indisponível'}`;item.append(title);
        const status=document.createElement('p');status.textContent=order.commandStatus?`${order.lastOperation}: ${commandStates[order.commandStatus]||'estado desconhecido'}${order.lastErrorCode?` (${order.lastErrorCode})`:''}`:'Nenhum comando enviado.';item.append(status);
        const actions=[];
        const raw=String(order.providerStatus||'').toUpperCase();
        if(order.provider==='99food'&&raw==='100'){const deadline=document.createElement('p');deadline.className='rm-integration-deadline';deadline.textContent='A 99Food exige confirmação em até 5 minutos após o aviso de novo pedido.';item.append(deadline);}
        if(raw==='PLACED'||raw==='CREATED'||order.provider==='99food'&&raw==='100')actions.push(['CONFIRM','Confirmar pedido']);
        if(order.provider==='ifood'&&raw==='CONFIRMED')actions.push(['START_PREPARATION','Iniciar preparo']);
        if((order.provider==='ifood'&&['CONFIRMED','PREPARATION_STARTED','PREPARING'].includes(raw))||(order.provider==='keeta'&&['CONFIRMED','PREPARING'].includes(raw))||order.provider==='99food'&&raw==='200')actions.push(['READY','Marcar pronto']);
        if(order.provider==='99food'&&order.fulfillment==='merchant'&&order.ownDeliveryComplete===true&&['200','400'].includes(raw))actions.push(['DELIVERED','Confirmar entrega própria concluída']);
        if(order.provider==='99food'&&order.fulfillment==='platform'&&raw==='200'&&Number(order.payType)===2&&Number(order.shopPaidMoney)>0)actions.push(['CONFIRM_CASH_PAYMENT','Confirmar recebimento em dinheiro']);
        if(['READY_TO_PICKUP','READY_FOR_PICKUP'].includes(raw))actions.push(['DISPATCH_MERCHANT','Despachar com entrega própria']);
        if(order.provider==='99food'&&order.latestEventType==='orderCancelApply'&&order.application?.id)actions.push(['CANCEL_REQUEST','Responder ao pedido de cancelamento']);
        if(order.provider==='99food'&&order.latestEventType==='orderRefundApply'&&order.application?.id)actions.push(['REFUND_REQUEST','Responder ao pedido de reembolso']);
        if(!['CANCELLED','CANCELED','DELIVERED','CONCLUDED','COMPLETED','901','902','903','921','922','923','941','942','943','944','945','946','961','971','981','600'].includes(raw))actions.push(['CANCEL_ORDER','Solicitar cancelamento']);
        if(order.provider==='ifood')actions.push(['SHIPPING_QUOTE','Consultar cotação iFood']);
        if(order.provider==='ifood'&&order.quoteId)actions.push(['SHIPPING_REQUEST','Solicitar entrega iFood']);
        if(order.provider==='ifood'&&order.shippingRequested)actions.push(['SHIPPING_CANCEL','Cancelar entrega iFood'],['SHIPPING_TRACKING','Consultar rastreamento iFood']);
        const canManageOrders=current.permissions.includes('orders.manage');
        if(canManageOrders)actions.forEach(([operation,label])=>{const button=document.createElement('button');button.type='button';button.textContent=label;
          button.addEventListener('click',async()=>{let commandData={};
            if(operation==='CONFIRM'&&order.provider==='keeta'){const code=window.prompt('Informe o código do pedido exigido pela confirmação Keeta:');if(!code)return;commandData.orderExternalCode=code;}
            if(operation==='CANCEL_ORDER'&&order.provider==='99food'){
              const choices=['1010 — Item esgotado','1020 — Loja fechada','1030 — Loja sem capacidade de preparo','1040 — Acidente grave ou interrupção de serviço','1050 — Problema relacionado ao cliente','1060 — Sem entregador (somente entrega da loja)','1070 — Atualizar cardápio','1071 — Fora da área (somente entrega da loja)','1072 — Endereço inseguro (somente entrega da loja)','1073 — Suspeita de fraude','1074 — Dúvida sobre taxas ou promoções','1080 — Outro motivo'];
              const selected=window.prompt(`Motivo oficial 99Food; informe o código:\\n${choices.join('\\n')}`);if(!selected)return;const reasonId=Number(selected);
              if(!choices.some(choice=>choice.startsWith(String(reasonId)))){status.textContent='Código de motivo inválido.';return;}
              commandData={reasonId};if(reasonId===1080){const reason=window.prompt('Descreva o motivo para a 99Food:');if(!reason?.trim())return;commandData.reason=reason.trim();}
            }else if(operation==='CANCEL_ORDER'){
              const reason=window.prompt('Informe o motivo oficial do cancelamento:');if(!reason)return;commandData={reason};if(order.provider==='keeta'){const code=window.prompt('Informe o código oficial de cancelamento Keeta:');if(!code)return;commandData.code=code;}
            }
            if(operation==='CANCEL_REQUEST'){
              const agree=window.confirm('Aprovar este pedido de cancelamento? OK aprova; Cancelar recusa.');commandData={applyId:order.application.id,agree};
              if(!agree&&order.application.reasons?.length){const selected=window.prompt(`Escolha o motivo informado pela 99Food:\\n${order.application.reasons.map((entry,index)=>`${index+1} — ${entry.label}`).join('\\n')}`);if(selected){const choice=order.application.reasons[Number(selected)-1];if(!choice){status.textContent='Opção de motivo inválida.';return;}commandData.reason=choice.label;}}
            }
            if(operation==='REFUND_REQUEST'){
              const agree=window.confirm('Aprovar este pedido de reembolso? OK aprova; Cancelar recusa.');commandData={applyId:order.application.id,agree};
              if(!agree){const options=order.application.baseReasons||[];if(!options.length){status.textContent='A 99Food não enviou motivos para recusa deste reembolso.';return;}const selected=window.prompt(`Escolha o motivo fornecido pela 99Food:\\n${options.map((entry,index)=>`${index+1} — ${entry.label}`).join('\\n')}`);if(!selected)return;const choice=options[Number(selected)-1];if(!choice){status.textContent='Opção de motivo inválida.';return;}commandData.baseReasonId=choice.id;commandData.baseReason=choice.label;}
            }
            if(operation==='DISPATCH_MERCHANT'&&order.provider==='keeta'){const url=window.prompt('Link HTTPS de rastreamento da entrega própria:');if(!url)return;commandData.deliveryTrackingInfo={externalTrackingURL:url};}
            button.disabled=true;try{const result=await request(`/admin/marketplace/orders/${encodeURIComponent(order.domainOrderId)}/commands`,{method:'POST',body:JSON.stringify({operation,idempotencyKey:crypto.randomUUID(),commandData})});
              status.textContent=result.status==='pending'?'Comando aceito; aguardando confirmação da plataforma.':'Comando registrado para execução.';await loadAdmin();}
            catch(error){button.disabled=false;status.textContent=message(error);}});item.append(button);});
        orderPanel.append(item);
      });
      list.append(orderPanel);
    }
    const roleSelect = $('[data-invite] select'); roleSelect.replaceChildren();
    const assignableRoles = roles.roles.filter(role => role.permissions.every(permission => current.permissions.includes(permission)));
    assignableRoles.forEach(role => { const option = document.createElement('option'); option.value = role.id; option.textContent = role.name; roleSelect.append(option); });
    const permissionBox = $('[data-permissions]'); permissionBox.replaceChildren();
    const grantablePermissions = permissionResult.permissions.filter(permission => current.permissions.includes(permission.key));
    grantablePermissions.forEach(permission => { const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = permission.key; label.append(input, document.createTextNode(` ${permission.key}`)); permissionBox.append(label); });
    const roleList = $('[data-roles-list]'); roleList.replaceChildren();
    const roleHeading = document.createElement('h3'); roleHeading.textContent = 'Perfis existentes'; roleList.append(roleHeading);
    roles.roles.forEach(role => {
      const card = document.createElement('form'); card.className = 'rm-member';
      const heading = document.createElement('strong'); heading.textContent = `${role.name} · ${role.key}`; card.append(heading);
      if (role.key === 'owner' || role.systemTemplate) { const note = document.createElement('span'); note.textContent = 'Perfil de sistema protegido.'; card.append(note); roleList.append(card); return; }
      if (role.id === current.activeRoleId) { const note = document.createElement('span'); note.textContent = 'Perfil atualmente associado à sua sessão; não pode ser alterado por você.'; card.append(note); roleList.append(card); return; }
      if (!role.permissions.every(permission => current.permissions.includes(permission))) { const note = document.createElement('span'); note.textContent = 'Este perfil excede suas permissões; somente um perfil de nível suficiente pode alterá-lo.'; card.append(note); roleList.append(card); return; }
      const nameLabel = document.createElement('label'); nameLabel.textContent = 'Nome do perfil'; const nameInput = document.createElement('input'); nameInput.name = 'name'; nameInput.required = true; nameInput.maxLength = 100; nameInput.value = role.name; nameLabel.append(nameInput); card.append(nameLabel);
      const fieldset = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = 'Permissões'; fieldset.append(legend);
      const checks = document.createElement('div'); checks.className = 'rm-role-permissions';
      grantablePermissions.forEach(permission => { const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'checkbox'; input.value = permission.key; input.checked = role.permissions.includes(permission.key); label.append(input, document.createTextNode(` ${permission.key}`)); checks.append(label); });
      fieldset.append(checks); card.append(fieldset);
      const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Salvar perfil'; const feedback = document.createElement('p'); feedback.setAttribute('role', 'status'); card.append(save, feedback);
      card.addEventListener('submit', async event => { event.preventDefault(); if (!card.reportValidity()) return; save.disabled = true;
        const permissions = [...checks.querySelectorAll('input:checked')].map(input => input.value);
        try { await request(`/admin/roles/${role.id}`, { method: 'PATCH', body: JSON.stringify({ name: nameInput.value.trim(), permissions }) }); feedback.textContent = 'Perfil atualizado.'; await loadAdmin(); }
        catch (error) { feedback.textContent = message(error); } finally { save.disabled = false; }
      }); roleList.append(card);
    });
    const list = $('[data-members]'); list.replaceChildren();
    members.members.forEach(member => {
      const card = document.createElement('article'); card.className = 'rm-member';
      const title = document.createElement('strong'); title.textContent = member.email; card.append(title);
      const meta = document.createElement('span'); meta.textContent = `${member.roleName} · ${member.status}${member.disabled ? ' · conta desativada' : ''}`; card.append(meta);
      if (member.userId !== current.userId) {
        const currentRole = roles.roles.find(role => role.id === member.roleId);
        const canReassignCurrent = currentRole?.permissions.every(permission => current.permissions.includes(permission)) ?? false;
        if (canReassignCurrent) {
        const select = document.createElement('select'); select.setAttribute('aria-label', `Perfil de ${member.email}`);
        roles.roles.filter(role => role.id === member.roleId || role.permissions.every(permission => current.permissions.includes(permission)))
          .forEach(role => { const option = document.createElement('option'); option.value = role.id; option.textContent = role.name; option.selected = role.id === member.roleId; select.append(option); });
        const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Salvar perfil';
        save.addEventListener('click', async () => { save.disabled = true; try { await request(`/admin/memberships/${member.membershipId}`, { method: 'PATCH', body: JSON.stringify({ roleId: select.value }) }); await loadAdmin(); } catch (error) { $('[data-admin-error]').textContent = message(error); } finally { save.disabled = false; } });
        card.append(select, save);
        }
      if (member.status === 'active' || member.status === 'suspended') { const stateButton = document.createElement('button'); stateButton.type = 'button'; stateButton.className = 'rm-secondary'; stateButton.textContent = member.status === 'active' ? 'Suspender' : 'Reativar';
          stateButton.addEventListener('click', async () => { if (member.status === 'active' && !window.confirm(`Suspender o acesso de ${member.email}?`)) return; stateButton.disabled = true; try { await request(`/admin/memberships/${member.membershipId}`, { method: 'PATCH', body: JSON.stringify({ status: member.status === 'active' ? 'suspended' : 'active' }) }); await loadAdmin(); } catch (error) { $('[data-admin-error]').textContent = message(error); } finally { stateButton.disabled = false; } }); card.append(stateButton); }
      }
      if (current.permissions.includes('company.manage')) {
        const linkBox = document.createElement('div'); linkBox.className = 'rm-driver-link';
        const title = document.createElement('strong'); title.textContent = 'Motorista operacional'; linkBox.append(title);
        const feedback = document.createElement('p'); feedback.className = 'rm-driver-link-status'; feedback.setAttribute('role', 'status');
        const driver = driverRows.find(row => row.id === member.driverId);
        if (member.driverId) {
          feedback.textContent = `Vinculado a ${driver?.record?.name || driver?.record?.displayName || `ID ${member.driverId}`}.`;
          const unlink = document.createElement('button'); unlink.type = 'button'; unlink.className = 'rm-secondary'; unlink.textContent = 'Desvincular motorista';
          unlink.addEventListener('click', async () => {
            if (!window.confirm(`Desvincular o motoboy ${member.email}? Ele deixará de receber entregas desta empresa até ser vinculado novamente.`)) return;
            unlink.disabled = true;
            try { await request(`/admin/memberships/${member.membershipId}/driver`, { method: 'DELETE' }); await loadAdmin(); }
            catch (error) { feedback.textContent = message(error); unlink.disabled = false; }
          });
          linkBox.append(feedback, unlink);
        } else {
          const eligible = member.status === 'active' && !member.disabled && member.emailVerified &&
            member.permissions?.includes('sync.pull') && member.permissions?.includes('sync.push');
          if (!eligible) feedback.textContent = 'Disponível quando a conta estiver ativa, confirmada e autorizada.';
          else if (!canReadDrivers) feedback.textContent = 'Seu perfil não pode listar os motoristas desta empresa.';
          else {
            const select = document.createElement('select');
            select.setAttribute('aria-label', `Motorista para ${member.email}`);
            const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Selecione um motorista'; select.append(placeholder);
            const linkedElsewhere = new Set(members.members.filter(item => item.membershipId !== member.membershipId && item.driverId).map(item => item.driverId));
            driverRows.filter(row => !linkedElsewhere.has(row.id)).forEach(row => {
              const option = document.createElement('option'); option.value = row.id;
              option.textContent = `${row.record?.name || row.record?.displayName || 'Motorista'}${row.record?.status ? ` · ${row.record.status}` : ''}`;
              select.append(option);
            });
            const link = document.createElement('button'); link.type = 'button'; link.className = 'rm-primary'; link.textContent = 'Vincular motorista'; link.disabled = true;
            select.addEventListener('change', () => { link.disabled = !select.value; });
            link.addEventListener('click', async () => {
              if (!select.value) return;
              link.disabled = true;
              try { await request(`/admin/memberships/${member.membershipId}/driver`, { method: 'PUT', body: JSON.stringify({ driverId: select.value }) }); await loadAdmin(); }
              catch (error) { feedback.textContent = message(error); link.disabled = !select.value; }
            });
            linkBox.append(select, link, feedback);
          }
        }
        card.append(linkBox);
      }
      list.append(card);
    });
    if (driverCursor && canReadDrivers) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'rm-secondary'; more.textContent = 'Carregar mais motoristas';
      more.addEventListener('click', async () => { more.disabled = true; try { await loadAdmin({ appendDrivers: true }); } catch (error) { $('[data-admin-error]').textContent = message(error); more.disabled = false; } });
      list.append(more);
    }
  }
  $('[data-refresh-admin]')?.addEventListener('click', () => loadAdmin().catch(error => { $('[data-admin-error]').textContent = message(error); }));
  $('[data-invite]')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return; setBusy(form, true);
    try { await request('/admin/invitations', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value.trim(), roleId: form.elements.roleId.value }) }); form.reset(); $('[data-invite-result]').textContent = 'Convite enviado.'; await loadAdmin(); }
    catch (error) { $('[data-invite-result]').textContent = message(error); } finally { setBusy(form, false); }
  });
  $('[data-create-role]')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()) return; setBusy(form, true);
    try { const permissions = [...form.querySelectorAll('[data-permissions] input:checked')].map(input => input.value); await request('/admin/roles', { method: 'POST', body: JSON.stringify({ key: form.elements.key.value.trim(), name: form.elements.name.value.trim(), permissions }) }); form.reset(); $('[data-role-result]').textContent = 'Perfil criado.'; await loadAdmin(); }
    catch (error) { $('[data-role-result]').textContent = message(error); } finally { setBusy(form, false); }
  });
  window.addEventListener('online', async () => { if (!current && !offlineMode) { const session = await restore(); if (session) await syncAfterAuthentication(); } else if (current) await syncAfterAuthentication(); });
  window.addEventListener('rotamoto:session-expired', expireSession);
  const initialAppRoot = document.querySelector('#app'); if (initialAppRoot) { initialAppRoot.inert = true; initialAppRoot.setAttribute('aria-hidden', 'true'); }
  host.dataset.gated = String(!offlineMode); trigger.hidden = false; updateTriggerLabel(); setOpen(!offlineMode); restore().then(async session => { if (session) { setOpen(false); await syncAfterAuthentication(); } });
  const appRoot = document.querySelector('#app');
  if (appRoot) new MutationObserver(placeTrigger).observe(appRoot, { childList: true, subtree: true });
  window.RotaMotoIdentity = Object.freeze({ restore, getSession: () => current, isOfflineMode: () => offlineMode });
})();
