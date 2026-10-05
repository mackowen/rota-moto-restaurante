(() => {
  'use strict';
  const API = String(window.ROTA_MOTO_API_BASE || '/api').replace(/\/$/u, '');
  let csrf = null;
  let current = null;
  let offlineMode = false;
  let invitationKind = 'membership_invitation';
  const sessionReadGuard = window.RotaMotoSessionGuard.createSessionReadGuard();
  let working = false;
  let driverRows = [];
  let driverCursor = null;
  let previousFocus = null;
  const codeMessages = {
    INVALID_CREDENTIALS: 'Email ou senha inválidos.', MFA_REQUIRED: 'Esta conta exige verificação MFA. Se o autenticador seguro ainda não estiver configurado, o acesso permanece bloqueado.', MFA_PROVIDER_UNAVAILABLE: 'A verificação MFA está temporariamente indisponível. Tente novamente mais tarde.',
    UNAUTHENTICATED: 'Sua sessão expirou. Entre novamente.', EMAIL_PROVIDER_NOT_CONFIGURED: 'Convites e recuperação ainda dependem da configuração segura de entrega de email.',
    FORBIDDEN: 'Seu perfil não permite esta ação.', LAST_OWNER_REQUIRED: 'A empresa precisa manter ao menos um owner ativo.',
    DRIVER_MEMBERSHIP_INELIGIBLE: 'Esta conta precisa estar ativa, verificada e autorizada para sincronizar como Motoboy.',
    DRIVER_NOT_FOUND: 'Motorista não encontrado nesta empresa.', DRIVER_ALREADY_LINKED: 'Este motorista já está associado a outra conta.',
    MEMBERSHIP_DRIVER_CONFLICT: 'Desvincule o motorista atual antes de trocar a associação.',
    INVALID_STATE_TRANSITION: 'Esta mudança de estado não é permitida.', EMAIL_DELIVERY_FAILED: 'Não foi possível entregar o convite. Nenhum link utilizável foi enviado.', AUTHENTICATION_REQUIRED: 'Entre na conta existente para aceitar este convite.', CONFLICT: 'A conta já possui um vínculo ou estado incompatível.',
    RATE_LIMITED: 'Muitas tentativas. Aguarde antes de tentar novamente.', NETWORK: 'Servidor indisponível. O modo local continua disponível.'
  };
  const host = document.createElement('div');
  host.id = 'rmIdentityRoot';
  host.innerHTML = `<button type="button" class="rm-account-trigger" aria-label="Abrir conta e acesso" aria-controls="rmIdentityPanel" aria-expanded="false">Conta</button>
    <section id="rmIdentityPanel" class="rm-identity-panel" role="dialog" aria-modal="true" aria-labelledby="rmIdentityTitle" hidden>
      <header><div><strong id="rmIdentityTitle">Conta RotaMoto</strong><small data-identity-status>Verificando sessão…</small></div><button type="button" data-close aria-label="Fechar painel">×</button></header>
      <div class="rm-identity-content">
        <form data-login novalidate><h2>Entrar</h2><label>Email<input name="email" type="email" autocomplete="username" required maxlength="320"></label>
          <label>Senha<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
          <label data-mfa-label hidden>Código MFA ou de recuperação<input name="mfaCode" autocomplete="one-time-code" minlength="6" maxlength="128"></label>
          <label>Empresa (UUID)<input name="companyId" autocomplete="off" spellcheck="false" aria-describedby="companyHelp" required></label>
          <small id="companyHelp">Use o identificador recebido no convite. O servidor valida o vínculo da conta.</small>
          <button class="rm-primary" type="submit">Entrar</button><p data-login-error role="alert" aria-live="polite"></p></form>
        <div data-authenticated hidden><div class="rm-account-summary"><b data-user-email></b><span data-company-name>Empresa ativa</span><span>ID: <code data-company-id></code></span></div>
          <section data-mfa hidden><h3>Autenticação multifator</h3><p data-mfa-status role="status"></p>
            <button type="button" data-mfa-start>Configurar autenticador</button>
            <form data-mfa-confirm hidden><p>Adicione esta conta ao seu aplicativo autenticador. Digite o código atual para confirmar.</p><label>Chave de configuração<input data-mfa-secret readonly autocomplete="off"></label><label>Código de confirmação<input name="code" inputmode="numeric" autocomplete="one-time-code" required minlength="6" maxlength="6"></label><button type="submit">Confirmar MFA</button><p data-mfa-error role="alert"></p></form>
            <section data-recovery-codes hidden><h4>Códigos de recuperação</h4><p>Guarde-os fora deste navegador. Cada código só pode ser usado uma vez.</p><pre data-recovery-code-list></pre><button type="button" data-recovery-codes-dismiss>Ocultar códigos</button></section>
            <button type="button" data-mfa-regenerate hidden>Gerar novos códigos de recuperação</button>
          </section>
          <form data-accept-existing><label>Código de convite para sua conta<input name="token" required maxlength="43" autocomplete="off"></label><button type="submit">Aceitar convite</button><p role="status" data-existing-invitation-result></p></form>
          <form data-switch><label>Trocar empresa (UUID)<input name="companyId" autocomplete="off" spellcheck="false" required></label><button type="submit">Validar e trocar</button><p data-switch-error role="alert"></p></form>
          <button type="button" data-sync>Sincronizar agora</button><button type="button" data-logout class="rm-secondary">Sair</button><p data-account-error role="alert" aria-live="polite"></p>
        </div>
        <details data-recovery><summary>Recuperar acesso</summary><form data-recovery-request><label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><button type="submit">Solicitar recuperação</button><p role="status" data-recovery-status></p></form>
          <form data-recovery-consume><label>Código recebido<input name="token" autocomplete="one-time-code" required maxlength="43"></label><label>Nova senha<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><button type="submit">Alterar senha</button><p role="status" data-recovery-result></p></form></details>
        <details data-invitation><summary>Aceitar convite</summary><form data-accept-invitation><label>Código do convite<input name="token" required maxlength="43" autocomplete="off"></label><label>Crie sua senha<input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="new-password"></label><button type="submit">Aceitar convite</button><p role="status" data-invitation-result></p></form></details>
        <section data-admin hidden><h2>Administração da empresa</h2><p data-admin-error role="alert" aria-live="polite"></p><button type="button" data-refresh-admin>Atualizar usuários e perfis</button>
          <form data-invite><h3>Convidar usuário</h3><label>Email<input name="email" type="email" required maxlength="320"></label><label>Perfil<select name="roleId" required></select></label><button type="submit">Enviar convite</button><p role="status" data-invite-result></p></form>
          <section data-integrations hidden><h3>Integrações disponíveis</h3><div></div></section><div data-members aria-live="polite"></div><p data-members-note role="status" hidden>Seu perfil não permite consultar os usuários desta empresa.</p><p data-driver-access-note role="status" hidden>Para listar motoristas, sua sessão precisa da permissão de leitura de sync. A desassociação continua disponível para vínculos existentes.</p><section data-roles-list><h3>Perfis existentes</h3></section><form data-create-role><h3>Novo perfil</h3><label>Identificador<input name="key" required pattern="[a-z][a-z0-9_-]{1,63}" maxlength="64"></label><label>Nome<input name="name" required maxlength="100"></label><fieldset><legend>Permissões</legend><div data-permissions></div></fieldset><button type="submit">Criar perfil</button><p role="status" data-role-result></p></form>
        </section>
        <button type="button" data-offline class="rm-offline">Continuar somente com dados locais</button>
        <p class="rm-privacy">Senha e códigos são enviados somente ao servidor por HTTPS em produção. Sessão e proteção CSRF permanecem em cookie seguro e memória; nada disso é salvo no armazenamento local.</p>
      </div>
    </section>`;
  document.body.append(host);
  const $ = (selector, root = host) => root.querySelector(selector);
  const panel = $('#rmIdentityPanel');
  const trigger = $('.rm-account-trigger');
  const appKind = document.currentScript?.dataset.app || 'restaurante';
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
    const anchor = current || offlineMode ? app?.querySelector('.top-actions, .top') : null;
    const parent = anchor || host;
    if (trigger.parentElement !== parent) parent.append(trigger);
    trigger.classList.toggle('rm-account-trigger--inline', Boolean(anchor));
  }
  function visibleControls() {
    return [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[href],[tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
  }
  function setOpen(open) {
    if (open && panel.hidden) previousFocus = document.activeElement;
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
    current = session; offlineMode = false;
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
    if (session) {
      $('[data-user-email]').textContent = session.email;
      $('[data-company-id]').textContent = session.activeCompanyId;
      try { localStorage.setItem('rotaMoto.activeCompanyHint', session.activeCompanyId); } catch (_) {}
      const mfaBox=$('[data-mfa]');mfaBox.hidden=!(session.mfaEnrollmentRequired||session.mfaConfigured);
      $('[data-mfa-status]').textContent=session.mfaEnrollmentRequired?'Acesso limitado até confirmar o autenticador.':session.mfaConfigured?'MFA configurado. O segredo não pode ser consultado novamente.':'MFA não configurado.';
      $('[data-mfa-start]').hidden=!session.mfaEnrollmentRequired&&session.mfaConfigured;
      $('[data-mfa-regenerate]').hidden=!(session.mfaConfigured&&session.mfaVerified&&session.permissions?.includes('company.manage'));
      $('[data-sync]').hidden=Boolean(session.mfaEnrollmentRequired);
      setStatus(session.mfaEnrollmentRequired?'Sessão limitada · configure MFA':'Sessão ativa');
      $('[data-login-error]').textContent = '';
      if (!$('[data-admin]').hidden) loadAdmin().catch(error => { $('[data-admin-error]').textContent = message(error); });
    } else setStatus(navigator.onLine === false ? 'Offline · somente modo local' : 'Sem sessão autenticada');
  }
  function expireSession() {
    if (!current) return;
    sessionReadGuard.invalidate();
      csrf = null; window.RotaMotoSessionGuard?.clearCsrfToken(); current = null; offlineMode = false;
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
      csrf = session.csrfToken; window.RotaMotoSessionGuard?.setCsrfToken(csrf); showSession(session); return session;
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
  $('[data-mfa-start]').addEventListener('click',async()=>{const button=$('[data-mfa-start]');button.disabled=true;$('[data-mfa-error]').textContent='';try{const result=await request('/identity/mfa/enrollment',{method:'POST',body:'{}'});$('[data-mfa-secret]').value=result.secret;$('[data-mfa-confirm]').hidden=false;$('[data-mfa-status]').textContent=`Escaneie ou insira a chave no autenticador. ${result.otpauthUri}`;$('[data-mfa-confirm] [name=code]').focus()}catch(error){$('[data-mfa-error]').textContent=message(error)}finally{button.disabled=false}});
  $('[data-mfa-confirm]').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity()||working)return;working=true;setBusy(form,true);try{const result=await request('/identity/mfa/enrollment/confirm',{method:'POST',body:JSON.stringify({code:form.elements.code.value})});$('[data-mfa-secret]').value='';$('[data-mfa-confirm]').hidden=true;$('[data-mfa-status]').textContent='MFA configurado. O segredo foi removido desta tela.';$('[data-recovery-code-list]').textContent=result.recoveryCodes.join('\n');$('[data-recovery-codes]').hidden=false;await restore()}catch(error){form.elements.code.value='';$('[data-mfa-error]').textContent=message(error)}finally{working=false;setBusy(form,false)}});
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
  $('[data-offline]').addEventListener('click', () => { sessionReadGuard.invalidate(); offlineMode = true; trigger.textContent = 'Conta · modo local'; const appRoot = document.querySelector('#app'); if (appRoot) { appRoot.inert = false; appRoot.setAttribute('aria-hidden', 'false'); } host.dataset.gated = 'false'; setStatus('Modo local sem identidade do servidor'); setOpen(false); });
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
  $('[data-sync]')?.addEventListener('click', async () => { try { await window.RotaMotoSync?.syncNow?.(); $('[data-account-error]').textContent = 'Sincronização solicitada.'; } catch (error) { $('[data-account-error]').textContent = message(error); } });
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
    const [company, members, roles, permissionResult, integrations] = await Promise.all([
      request('/admin/company'), canReadMembers ? request('/admin/memberships?limit=100') : Promise.resolve({ members: [] }), request('/admin/roles'), request('/admin/permissions'),
      current.permissions.includes('integrations.manage') ? request('/admin/integrations') : Promise.resolve(null)
    ]);
    const driverPage = canReadDrivers ? await request(`/domain/drivers?limit=100${appendDrivers && driverCursor ? `&cursor=${encodeURIComponent(driverCursor)}` : ''}`) : { records: [], nextCursor: null };
    if (!appendDrivers) driverRows = [];
    driverRows.push(...driverPage.records);
    driverCursor = driverPage.nextCursor;
    $('[data-driver-access-note]').hidden = canReadDrivers;
    $('[data-company-name]').textContent = company.name;
    const integrationBox = $('[data-integrations]'); integrationBox.hidden = !integrations;
    if (integrations) { const list = integrationBox.querySelector('div'); list.replaceChildren(); integrations.integrations.forEach(item => { const row = document.createElement('p'); row.textContent = `${item.displayName || item.provider} · ${item.state || item.status} · ${item.connectionVerified ? 'conexão verificada' : 'sem conexão externa verificada'}${item.externalAccount ? ' · conta externa cadastrada, ainda não validada' : ''}`; list.append(row); }); }
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
            if (!window.confirm(`Desvincular o motorista de ${member.email}? A conta deixará de sincronizar entregas até receber outro vínculo.`)) return;
            unlink.disabled = true;
            try { await request(`/admin/memberships/${member.membershipId}/driver`, { method: 'DELETE' }); await loadAdmin(); }
            catch (error) { feedback.textContent = message(error); unlink.disabled = false; }
          });
          linkBox.append(feedback, unlink);
        } else {
          const eligible = member.status === 'active' && !member.disabled && member.emailVerified &&
            member.permissions?.includes('sync.pull') && member.permissions?.includes('sync.push');
          if (!eligible) feedback.textContent = 'Disponível quando a conta estiver ativa, verificada e autorizada para sincronizar.';
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
  host.dataset.gated = 'true'; trigger.hidden = false; setOpen(true); restore().then(async session => { if (session) { setOpen(false); await syncAfterAuthentication(); } });
  const appRoot = document.querySelector('#app');
  if (appRoot) new MutationObserver(placeTrigger).observe(appRoot, { childList: true, subtree: true });
  window.RotaMotoIdentity = Object.freeze({ restore, getSession: () => current, isOfflineMode: () => offlineMode });
})();
