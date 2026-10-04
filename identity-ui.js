(() => {
  'use strict';
  const API = String(window.ROTA_MOTO_API_BASE || '/api').replace(/\/$/u, '');
  let csrf = null;
  let current = null;
  let offlineMode = false;
  let working = false;
  const codeMessages = {
    INVALID_CREDENTIALS: 'Email ou senha inválidos.', MFA_REQUIRED: 'Esta conta exige verificação MFA. Se o autenticador seguro ainda não estiver configurado, o acesso permanece bloqueado.', MFA_PROVIDER_UNAVAILABLE: 'A verificação MFA está temporariamente indisponível. Tente novamente mais tarde.',
    UNAUTHENTICATED: 'Sua sessão expirou. Entre novamente.', EMAIL_PROVIDER_NOT_CONFIGURED: 'Convites e recuperação ainda dependem da configuração segura de entrega de email.',
    FORBIDDEN: 'Seu perfil não permite esta ação.', LAST_OWNER_REQUIRED: 'A empresa precisa manter ao menos um owner ativo.',
    INVALID_STATE_TRANSITION: 'Esta mudança de estado não é permitida.', EMAIL_DELIVERY_FAILED: 'Não foi possível entregar o convite. Nenhum link utilizável foi enviado.', AUTHENTICATION_REQUIRED: 'Entre na conta existente para aceitar este convite.', CONFLICT: 'A conta já possui um vínculo ou estado incompatível.',
    RATE_LIMITED: 'Muitas tentativas. Aguarde antes de tentar novamente.', NETWORK: 'Servidor indisponível. O modo local continua disponível.'
  };
  const host = document.createElement('div');
  host.id = 'rmIdentityRoot';
  host.innerHTML = `<button type="button" class="rm-account-trigger" aria-controls="rmIdentityPanel" aria-expanded="false">Conta e acesso</button>
    <section id="rmIdentityPanel" class="rm-identity-panel" role="region" aria-label="Conta e autenticação" hidden>
      <header><div><strong>Conta RotaMoto</strong><small data-identity-status>Verificando sessão…</small></div><button type="button" data-close aria-label="Fechar painel">×</button></header>
      <div class="rm-identity-content">
        <form data-login novalidate><h2>Entrar</h2><label>Email<input name="email" type="email" autocomplete="username" required maxlength="320"></label>
          <label>Senha<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label>
          <label data-mfa-label hidden>Código de verificação MFA<input name="mfaCode" inputmode="numeric" autocomplete="one-time-code" minlength="6" maxlength="128"></label>
          <label>Empresa (UUID)<input name="companyId" autocomplete="off" spellcheck="false" aria-describedby="companyHelp" required></label>
          <small id="companyHelp">Use o identificador recebido no convite. O servidor valida o vínculo da conta.</small>
          <button class="rm-primary" type="submit">Entrar</button><p data-login-error role="alert" aria-live="polite"></p></form>
        <div data-authenticated hidden><div class="rm-account-summary"><b data-user-email></b><span data-company-name>Empresa ativa</span><span>ID: <code data-company-id></code></span></div>
          <form data-accept-existing><label>Código de convite para sua conta<input name="token" required maxlength="43" autocomplete="off"></label><button type="submit">Aceitar convite</button><p role="status" data-existing-invitation-result></p></form>
          <form data-switch><label>Trocar empresa (UUID)<input name="companyId" autocomplete="off" spellcheck="false" required></label><button type="submit">Validar e trocar</button><p data-switch-error role="alert"></p></form>
          <button type="button" data-sync>Sincronizar agora</button><button type="button" data-logout class="rm-secondary">Sair</button><p data-account-error role="alert" aria-live="polite"></p>
        </div>
        <details data-recovery><summary>Recuperar acesso</summary><form data-recovery-request><label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><button type="submit">Solicitar recuperação</button><p role="status" data-recovery-status></p></form>
          <form data-recovery-consume><label>Código recebido<input name="token" autocomplete="one-time-code" required maxlength="43"></label><label>Nova senha<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><button type="submit">Alterar senha</button><p role="status" data-recovery-result></p></form></details>
        <details data-invitation><summary>Aceitar convite</summary><form data-accept-invitation><label>Código do convite<input name="token" required maxlength="43" autocomplete="off"></label><label>Crie sua senha<input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="new-password"></label><button type="submit">Aceitar convite</button><p role="status" data-invitation-result></p></form></details>
        <section data-admin hidden><h2>Administração da empresa</h2><p data-admin-error role="alert" aria-live="polite"></p><button type="button" data-refresh-admin>Atualizar usuários e perfis</button>
          <form data-invite><h3>Convidar usuário</h3><label>Email<input name="email" type="email" required maxlength="320"></label><label>Perfil<select name="roleId" required></select></label><button type="submit">Enviar convite</button><p role="status" data-invite-result></p></form>
          <section data-integrations hidden><h3>Integrações disponíveis</h3><div></div></section><div data-members aria-live="polite"></div><p data-members-note role="status" hidden>Seu perfil não permite consultar os usuários desta empresa.</p><section data-roles-list><h3>Perfis existentes</h3></section><form data-create-role><h3>Novo perfil</h3><label>Identificador<input name="key" required pattern="[a-z][a-z0-9_-]{1,63}" maxlength="64"></label><label>Nome<input name="name" required maxlength="100"></label><fieldset><legend>Permissões</legend><div data-permissions></div></fieldset><button type="submit">Criar perfil</button><p role="status" data-role-result></p></form>
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
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...(options.headers || {}) };
    let response;
    try { response = await fetch(`${API}${path}`, { credentials: 'include', cache: 'no-store', ...options, headers }); }
    catch (_) { const error = new Error('NETWORK'); error.network = true; throw error; }
    let body = {}; try { body = await response.json(); } catch (_) {}
    if (response.status === 401) expireSession();
    if (!response.ok && response.status === 403 && body.error?.code === 'CSRF_INVALID' && method !== 'GET' && !retried) {
      const session = await restore(); if (session) return request(path, options, true);
    }
    if (!response.ok) { const error = new Error(body.error?.code || 'REQUEST_FAILED'); error.code = body.error?.code; error.status = response.status; throw error; }
    return body;
  }
  function setOpen(open) { panel.hidden = !open; trigger.setAttribute('aria-expanded', String(open)); if (open) panel.querySelector('input:not([disabled])')?.focus(); }
  function setStatus(text) { $('[data-identity-status]').textContent = text; }
  function setBusy(form, busy) { form.querySelectorAll('button').forEach(button => { button.disabled = busy; }); }
  function showSession(session) {
    current = session; offlineMode = false;
    $('[data-login]').hidden = Boolean(session); $('[data-authenticated]').hidden = !session;
    $('[data-offline]').hidden = Boolean(session); $('[data-recovery]').hidden = Boolean(session);
    $('[data-invitation]').hidden = Boolean(session);
    $('[data-invite]').hidden = !session?.permissions?.includes('members.invite');
    $('[data-members]').hidden = !session?.permissions?.includes('members.read');
    $('[data-members-note]').hidden = Boolean(session?.permissions?.includes('members.read'));
    const appRoot = document.querySelector('#app');
    if (appRoot) { appRoot.inert = !session && !offlineMode; appRoot.setAttribute('aria-hidden', String(!session && !offlineMode)); }
    host.dataset.gated = String(!session && !offlineMode);
    $('[data-admin]').hidden = !(session && appKind === 'restaurante' && session.permissions?.includes('company.manage'));
    trigger.hidden = false;
    if (session) {
      $('[data-user-email]').textContent = session.email;
      $('[data-company-id]').textContent = session.activeCompanyId;
      try { localStorage.setItem('rotaMoto.activeCompanyHint', session.activeCompanyId); } catch (_) {}
      setStatus('Sessão ativa');
      $('[data-login-error]').textContent = '';
      if (!$('[data-admin]').hidden) loadAdmin().catch(error => { $('[data-admin-error]').textContent = message(error); });
    } else setStatus(navigator.onLine === false ? 'Offline · somente modo local' : 'Sem sessão autenticada');
  }
  function expireSession() {
    if (!current) return;
    csrf = null; current = null; offlineMode = false;
    Promise.resolve(window.RotaMotoSync?.clearSession?.()).catch(() => {});
    showSession(null); setOpen(true);
    $('[data-login-error]').textContent = 'Sua sessão expirou ou deixou de estar válida. Entre novamente.';
    setStatus('Sessão expirada. Entre novamente.');
  }
  async function restore() {
    try { const session = await request('/identity/session'); if (typeof session.csrfToken !== 'string') throw Object.assign(new Error(), { code: 'UNAUTHENTICATED' }); csrf = session.csrfToken; showSession(session); return session; }
    catch (error) { csrf = null; current = null; showSession(null); if (error.status === 401) $('[data-login-error]').textContent = message(error); return null; }
  }
  function hintedCompany() { try { return localStorage.getItem('rotaMoto.activeCompanyHint') || ''; } catch (_) { return ''; } }
  $('[data-login] [name=companyId]').value = hintedCompany();
  $('.rm-account-trigger').addEventListener('click', () => setOpen(panel.hidden));
  $('[data-close]').addEventListener('click', () => { if (current || offlineMode) setOpen(false); });
  $('[data-login]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    working = true; setBusy(form, true); $('[data-login-error]').textContent = ''; setStatus('Autenticando…');
    const data = new FormData(form); const password = data.get('password');
    try {
      const body = { email: String(data.get('email')).trim(), password: String(password), ...(data.get('companyId') ? { companyId: String(data.get('companyId')).trim() } : {}), ...(data.get('mfaCode') ? { mfaCode: String(data.get('mfaCode')).trim() } : {}) };
      const result = await request('/identity/login', { method: 'POST', body: JSON.stringify(body) });
      csrf = result.csrfToken; form.elements.password.value = ''; form.elements.mfaCode.value = ''; $('[data-mfa-label]').hidden = true;
      const session = await restore();
      if (!session) throw Object.assign(new Error(), { code: 'UNAUTHENTICATED' });
      await syncAfterAuthentication();
      setOpen(false);
    } catch (error) { if (error.code === 'MFA_REQUIRED') { $('[data-mfa-label]').hidden = false; form.elements.mfaCode.focus(); } else { form.elements.password.value = ''; form.elements.mfaCode.value = ''; $('[data-mfa-label]').hidden = true; } $('[data-login-error]').textContent = message(error); setStatus('Não foi possível autenticar'); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-offline]').addEventListener('click', () => { offlineMode = true; trigger.textContent = 'Conta · modo local'; const appRoot = document.querySelector('#app'); if (appRoot) { appRoot.inert = false; appRoot.setAttribute('aria-hidden', 'false'); } host.dataset.gated = 'false'; setStatus('Modo local sem identidade do servidor'); setOpen(false); });
  $('[data-switch]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    working = true; setBusy(form, true); $('[data-switch-error]').textContent = '';
    try { await request('/identity/tenant', { method: 'POST', body: JSON.stringify({ companyId: form.elements.companyId.value.trim() }) }); await restore(); await syncAfterAuthentication(); }
    catch (error) { $('[data-switch-error]').textContent = message(error); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-logout]').addEventListener('click', async () => {
    if (working) return; working = true;
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
    try { const result = await request('/identity/membership-invitations/accept', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim(), password }) });
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
  async function loadAdmin() {
    const canReadMembers = current.permissions.includes('members.read');
    const [company, members, roles, permissionResult, integrations] = await Promise.all([
      request('/admin/company'), canReadMembers ? request('/admin/memberships?limit=100') : Promise.resolve({ members: [] }), request('/admin/roles'), request('/admin/permissions'),
      current.permissions.includes('integrations.manage') ? request('/admin/integrations') : Promise.resolve(null)
    ]);
    $('[data-company-name]').textContent = company.name;
    const integrationBox = $('[data-integrations]'); integrationBox.hidden = !integrations;
    if (integrations) { const list = integrationBox.querySelector('div'); list.replaceChildren(); integrations.integrations.forEach(item => { const row = document.createElement('p'); row.textContent = `${item.provider} · ${item.status}${item.externalAccount ? ` · ${item.externalAccount.linkStatus}` : ''}`; list.append(row); }); }
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
      list.append(card);
    });
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
  window.RotaMotoIdentity = Object.freeze({ restore, getSession: () => current, isOfflineMode: () => offlineMode });
})();
