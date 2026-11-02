(() => {
  'use strict';
  const API = String(window.ROTA_MOTO_API_BASE || '/api').replace(/\/$/u, '');
  const serverUpdateBus = window.RotaMotoServerUpdateCoordinator?.create();
  let csrf = null;
  let current = null;
  let companySnapshot = null;
  let offlineMode = false;
  let invitationKind = 'membership_invitation';
  const sessionReadGuard = window.RotaMotoSessionGuard.createSessionReadGuard();
  function invalidateSessionReads() {
    sessionReadGuard.invalidate();
    window.RotaMotoSessionGuard?.invalidateSessionRead?.();
  }
  let working = false;
  let mfaStarting = false;
  let authView = 'login';
  let recoveryStep = 'recovery-menu';
  let mfaRecoveryConfirmReady = false;
  let driverRows = [];
  let driverCursor = null;
  let marketplaceOrderCache = { orders: [], loaded: false, error: null };
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
    INVALID_CREDENTIALS: 'Email ou senha inválidos.', INVALID_TOKEN: 'Este código não é válido, expirou ou já foi usado. Solicite um novo convite ou código para continuar.', CURRENT_PASSWORD_INVALID: 'A senha atual não confere.', PASSWORD_UNCHANGED: 'Escolha uma senha diferente da atual.', MFA_REQUIRED: 'Esta conta precisa de um código de verificação. Configure o aplicativo autenticador para entrar.', MFA_PROVIDER_UNAVAILABLE: 'A verificação em duas etapas está temporariamente indisponível. Tente novamente mais tarde.', CSRF_INVALID: 'A sessão de segurança foi renovada. Tente configurar novamente; se o erro continuar, atualize a página.', RECOVERY_LOCAL_OPERATOR_REQUIRED: 'Esta solicitação exige o procedimento local auditado do operador.',
    UNAUTHENTICATED: 'Sua sessão expirou. Entre novamente.', EMAIL_PROVIDER_NOT_CONFIGURED: 'Convites e recuperação ainda dependem da configuração segura de entrega de email.',
    FORBIDDEN: 'Seu perfil não permite esta ação.', LAST_OWNER_REQUIRED: 'A empresa precisa manter ao menos um responsável principal ativo.',
    DRIVER_MEMBERSHIP_INELIGIBLE: 'A conta precisa estar ativa, confirmada e autorizada para usar o app Motoboy.',
    DRIVER_INACTIVE: 'Este cadastro operacional não está ativo para usar o app Motoboy.',
    DRIVER_HAS_ACTIVE_DELIVERIES: 'Reatribua ou conclua as entregas em andamento antes de encerrar este vínculo.',
    DRIVER_NOT_FOUND: 'Motoboy não encontrado nesta empresa.', DRIVER_ALREADY_LINKED: 'Este motorista já está associado a outra conta.',
    MEMBERSHIP_DRIVER_CONFLICT: 'Desvincule o motorista atual antes de trocar a associação.',
    INVALID_STATE_TRANSITION: 'Esta mudança de estado não é permitida.', EMAIL_DELIVERY_FAILED: 'Não foi possível entregar o convite. Nenhum link utilizável foi enviado.', AUTHENTICATION_REQUIRED: 'Entre na conta existente para aceitar este convite.',
    CONFLICT: 'Os dados mudaram durante a operação. Atualize a tela e confira o estado antes de tentar novamente.', INVALID_RESPONSE: 'A resposta recebida não corresponde ao formato esperado para esta seção. Atualize a lista; se persistir, informe o suporte.', NETWORK_TIMEOUT: 'O servidor demorou para responder. Tente atualizar a lista novamente.', RATE_LIMITED: 'Muitas tentativas. Aguarde antes de tentar novamente.', NETWORK: 'Sem conexão com o servidor. Os dados salvos neste aparelho continuam disponíveis; ações que precisam do servidor ficam pausadas.',
    PROVIDER_CREDENTIALS_NOT_CONFIGURED: 'Peça ao administrador para concluir a configuração segura do aplicativo.',
    MARKETPLACE_ACCOUNT_LIFECYCLE_UNAVAILABLE: 'A integração ainda não está configurada. Peça ao administrador para concluir a configuração segura.',
    OAUTH_STATE_EXPIRED_OR_USED: 'Esta autorização expirou ou já foi usada. Inicie uma nova autorização.',
    AUTHORIZED_MERCHANT_NOT_VISIBLE_YET: 'A autorização foi concluída, mas as lojas ainda não apareceram. Toque em “Verificar lojas novamente” daqui a pouco. Não repita a autorização.',
    PROVIDER_BLOCKED_EXTERNAL: 'A 99Food exige acesso de onboarding e contrato oficial antes de habilitar a integração.'
  };
  const host = document.createElement('div');
  host.id = 'rmIdentityRoot';
  host.innerHTML = `<button type="button" class="rm-account-trigger" data-account-security aria-label="Abrir conta e acesso" aria-controls="rmIdentityPanel" aria-expanded="false">Conta</button>
    <section id="rmIdentityPanel" class="rm-identity-panel" role="main" aria-labelledby="rmIdentityTitle" hidden>
      <section class="rm-login-presentation" data-login-presentation aria-labelledby="rm-login-heading">
        <div class="rm-login-brand"><img src="/favicon.svg?v=0140.1" alt=""><span>RotaMoto</span></div>
        <div class="rm-login-intro"><p class="rm-login-eyebrow">OPERAÇÃO DO RESTAURANTE</p><h1 id="rm-login-heading">Gestão completa de entregas para o seu restaurante</h1>
          <p>Pedidos, rotas, motoboys e operações em um só lugar.</p></div>
        <ul class="rm-login-benefits">
          <li><span class="rm-login-benefit-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4zM8 9h8M8 13h5M8 17h3"/></svg></span><span><strong>Mais controle</strong><small>Acompanhe pedidos e operações em um só painel.</small></span></li>
          <li><span class="rm-login-benefit-icon rm-login-benefit-icon--green" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17 14a5 5 0 0 1 3.5 4.8"/></svg></span><span><strong>Equipe conectada</strong><small>Gerencie motoboys e presença operacional.</small></span></li>
          <li><span class="rm-login-benefit-icon rm-login-benefit-icon--amber" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 19 9 14l4 3 7-9M15 8h5v5"/><circle cx="4" cy="19" r="1"/><circle cx="9" cy="14" r="1"/><circle cx="13" cy="17" r="1"/></svg></span><span><strong>Rotas eficientes</strong><small>Planeje e acompanhe as entregas da equipe.</small></span></li>
        </ul>
        <div class="rm-login-route-art" aria-hidden="true"><span class="rm-login-route-art__pin"><svg viewBox="0 0 24 24"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg></span><span class="rm-login-route-art__line"></span><span class="rm-login-route-art__dot"></span><span class="rm-login-route-art__caption">Pedidos · Equipe · Entregas</span></div>
      </section>
      <header><div><strong id="rmIdentityTitle">Conta RotaMoto</strong><small data-identity-status>Verificando sua conta…</small></div><button type="button" data-close aria-label="Fechar painel">×</button></header>
    <div class="rm-identity-content">
        <div class="rm-login-mobile-brand" data-login-mobile-brand><img src="/favicon.svg?v=0140.1" alt=""><span>RotaMoto</span></div>
        <form data-login novalidate><div class="rm-login-form-heading"><h2 tabindex="-1">Conta RotaMoto</h2><p>Entre para acessar sua conta.</p></div>
          <label>Email<span class="rm-login-input-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg><input name="email" type="email" autocomplete="username" required maxlength="320"></span></label>
          <label>Senha<span class="rm-login-input-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><input name="password" type="password" autocomplete="current-password" required maxlength="1024"><button class="rm-password-toggle" type="button" data-toggle-password aria-label="Mostrar senha" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button></span></label>
          <label data-mfa-label hidden>Código de verificação ou recuperação<input name="mfaCode" autocomplete="one-time-code" minlength="6" maxlength="128"></label>
          <label>Código da empresa<span class="rm-login-input-wrap"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 10h1m4 0h1m-6 4h1m4 0h1m-5 7v-4h4v4"/></svg><input name="companyId" autocomplete="off" spellcheck="false" aria-describedby="companyHelp" required></span></label>
          <small id="companyHelp">Use o código recebido no convite. O servidor confirma o vínculo da conta.</small>
          <button class="rm-primary rm-login-submit" type="submit"><span>Entrar</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button><p data-login-error role="alert" aria-live="polite"></p></form>
        <div data-authenticated hidden><div class="rm-account-summary"><b data-user-email></b><span data-email-verification></span><span data-company-name>Empresa ativa</span><span data-company-code-row>Identificador da empresa: <code data-company-id></code> <button type="button" data-copy-company-id>Copiar</button></span></div>
          <form data-password-change><p>Use a senha atual para definir uma nova. Sua sessão neste aparelho continuará ativa; as outras sessões serão encerradas após a confirmação.</p><label>Senha atual<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="1024"></label><label>Nova senha<input name="newPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><label>Repita a nova senha<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><button type="submit">Alterar senha</button><p data-password-change-status role="status" aria-live="polite"></p></form>
          <section data-mfa hidden><p data-mfa-status role="status"></p>
            <p data-mfa-start-status role="alert" aria-live="assertive" aria-atomic="true"></p><button type="button" data-mfa-start>Configurar verificação em duas etapas</button><button type="button" class="rm-secondary" data-mfa-replace hidden>Substituir autenticador</button>
          <form data-mfa-replace-verify hidden><p>Para substituir o autenticador, confirme sua senha e informe um código TOTP atual ou um código de recuperação ainda não utilizado. A chave ativa nunca é exibida novamente.</p><label>Senha atual<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="1024"></label><label>Código TOTP ou de recuperação<input name="currentMfaCode" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" required minlength="6" maxlength="23" pattern="(?:[0-9]{6}|[A-Fa-f0-9]{20}|[A-Fa-f0-9]{5}(?:-[A-Fa-f0-9]{5}){3})" title="Use um código TOTP de seis dígitos ou um código de recuperação ainda não utilizado."></label><button type="submit">Confirmar identidade</button><button type="button" class="rm-secondary" data-mfa-replace-cancel>Cancelar</button><p data-mfa-replace-status role="alert" aria-live="polite"></p></form>
          <form data-mfa-confirm hidden><p>Escaneie o QR Code ou informe a nova chave no aplicativo autenticador. Digite o código atual para confirmar. A chave será exibida apenas durante esta configuração.</p><canvas data-mfa-qr width="208" height="208" role="img" aria-label="QR Code para configurar autenticação em duas etapas" hidden></canvas><label>Nova chave de configuração<input data-mfa-secret readonly autocomplete="off"></label><label>Código de confirmação<input name="code" inputmode="numeric" autocomplete="one-time-code" required minlength="6" maxlength="6"></label><button type="submit">Confirmar novo autenticador</button><button type="button" class="rm-secondary" data-mfa-cancel>Cancelar configuração</button><p data-mfa-error role="alert"></p></form>
            <section data-recovery-codes hidden><h4>Códigos de recuperação</h4><p>Guarde-os fora deste navegador. Cada código só pode ser usado uma vez.</p><pre data-recovery-code-list></pre><button type="button" data-recovery-codes-dismiss>Ocultar códigos</button></section>
            <button type="button" data-mfa-regenerate hidden>Gerar novos códigos de recuperação</button>
          </section>
          <form data-accept-existing><label>Código de convite para sua conta<input name="token" required maxlength="43" autocomplete="off"></label><button type="submit">Aceitar convite</button><p role="status" data-existing-invitation-result></p></form>
          <form data-switch hidden><label>Ativar outra empresa vinculada<select name="companyId" required><option value="">Escolha uma empresa</option></select></label><button type="submit" disabled>Ativar empresa selecionada</button><p data-switch-error role="alert"></p></form>
          <button type="button" data-logout class="rm-secondary">Sair</button><p data-account-error role="alert" aria-live="polite"></p>
        </div>
        <section class="rm-auth-flow" data-recovery data-auth-view="recovery" aria-labelledby="rmRecoveryTitle" hidden>
          <header class="rm-auth-flow-heading"><div class="rm-auth-flow-heading__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.2c0 4.7 3.2 8.3 7.5 9.8 4.3-1.5 7.5-5.1 7.5-9.8V6L12 3Z"/><path d="M9 12h6M12 9v6"/></svg></div><div><h2 id="rmRecoveryTitle" data-recovery-title>Recuperar acesso</h2><p data-recovery-description>Escolha como deseja recuperar sua conta.</p></div><button class="rm-auth-back" type="button" data-recovery-back aria-label="Voltar ao login"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h12"/></svg><span data-recovery-back-label>Voltar</span></button></header>
          <nav class="rm-auth-recovery-menu" data-recovery-menu aria-label="Opções para recuperar acesso">
            <button type="button" class="rm-auth-option" data-recovery-choice="request-code"><span class="rm-auth-option__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg></span><span><strong>Solicitar código</strong><small>O envio depende da configuração segura de email.</small></span><span class="rm-auth-option__arrow" aria-hidden="true">›</span></button>
            <button type="button" class="rm-auth-option" data-recovery-choice="reset-password"><span class="rm-auth-option__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-2 2"/></svg></span><span><strong>Redefinir senha</strong><small>Use o código recebido para criar uma nova senha.</small></span><span class="rm-auth-option__arrow" aria-hidden="true">›</span></button>
            <button type="button" class="rm-auth-option" data-recovery-choice="recover-mfa"><span class="rm-auth-option__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="2"/><path d="M9 7h6M10 17h4M3 9v6m18-6v6"/></svg></span><span><strong>Perdi o autenticador</strong><small>Inicie a recuperação segura da verificação em duas etapas.</small></span><span class="rm-auth-option__arrow" aria-hidden="true">›</span></button>
          </nav>
          <section class="rm-auth-flow-screen" data-recovery-screen="request-code" hidden><form data-recovery-request><label>Email<input name="email" type="email" autocomplete="email" required maxlength="320"></label><small>Se a conta puder ser recuperada e o serviço de email estiver disponível, as instruções serão enviadas ao endereço cadastrado.</small><button class="rm-primary" type="submit">Solicitar recuperação por email</button><p role="status" aria-live="polite" data-recovery-status></p></form></section>
          <section class="rm-auth-flow-screen" data-recovery-screen="reset-password" hidden><form data-recovery-consume><label>Código recebido<input name="token" autocomplete="one-time-code" required maxlength="43"></label><label>Nova senha<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><button class="rm-primary" type="submit">Alterar senha</button><p role="status" aria-live="polite" data-recovery-result></p></form></section>
          <section class="rm-auth-flow-screen" data-recovery-screen="recover-mfa" hidden><form data-mfa-recovery-request data-mfa-recovery-stage="request"><p class="rm-auth-flow-note">A solicitação exige sua senha atual e confirmação pelo email verificado. Outro administrador deverá aprová-la; para proprietário único, somente o operador local pode concluir. O envio depende da configuração segura de email.</p><label>Email<input name="email" type="email" autocomplete="username" required maxlength="320"></label><label>Senha atual<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><label>Código da empresa<input name="companyId" required maxlength="36" autocomplete="off"></label><button class="rm-primary" type="submit">Solicitar recuperação de MFA</button><p role="status" aria-live="polite" data-mfa-recovery-status></p></form><form data-mfa-recovery-confirm data-mfa-recovery-stage="confirm" hidden><label>Código recebido por email<input name="token" autocomplete="one-time-code" required maxlength="43"></label><button class="rm-primary" type="submit">Confirmar solicitação</button><p role="status" aria-live="polite" data-mfa-recovery-confirm-status></p></form></section>
        </section>
        <section class="rm-auth-flow rm-auth-invitation" data-invitation data-auth-view="invitation" aria-labelledby="rmInvitationTitle" hidden><header class="rm-auth-flow-heading"><div class="rm-auth-flow-heading__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v5.2c0 4.7 3.2 8.3 7.5 9.8 4.3-1.5 7.5-5.1 7.5-9.8V6L12 3Z"/><path d="m9 12 2 2 4-4"/></svg></div><div><h2 id="rmInvitationTitle">Aceitar convite</h2><p>Informe o código recebido para ativar o vínculo autorizado.</p></div><button class="rm-auth-back" type="button" data-invitation-back aria-label="Voltar ao login"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6M9 12h12"/></svg><span>Voltar ao login</span></button></header><form data-accept-invitation><label>Código do convite<input name="token" required maxlength="43" autocomplete="off"></label><label>Crie sua senha<input name="password" type="password" required minlength="12" maxlength="1024" autocomplete="new-password"></label><button class="rm-primary" type="submit">Aceitar convite</button><p role="status" aria-live="polite" data-invitation-result></p></form></section>
        <nav class="rm-login-secondary" data-login-secondary aria-label="Ajuda para acessar sua conta"><button type="button" data-open-recovery>Recuperar acesso</button><span aria-hidden="true">·</span><button type="button" data-open-invitation>Aceitar convite</button><span aria-hidden="true" data-bootstrap-separator hidden>·</span><button type="button" data-open-bootstrap hidden>Primeira instalação</button></nav>
        <section data-admin hidden><h2>Administração da empresa</h2><p data-admin-error role="alert" aria-live="polite"></p><button type="button" data-refresh-admin>Atualizar usuários e perfis</button><form data-company-setup><h3>Configuração da empresa</h3><p>Informe os dados básicos. Contato e endereço são opcionais; o fuso horário é obrigatório para a operação.</p><label>Nome da empresa<input name="name" required maxlength="160" autocomplete="organization"></label><label>Telefone de contato (opcional)<input name="supportPhone" maxlength="40" autocomplete="tel"></label><label>Fuso horário<select name="timeZone" required><option value="America/Sao_Paulo">Brasília · America/Sao_Paulo</option><option value="America/Fortaleza">Fortaleza · America/Fortaleza</option><option value="America/Manaus">Manaus · America/Manaus</option><option value="America/Rio_Branco">Rio Branco · America/Rio_Branco</option><option value="UTC">UTC</option></select></label><label>Endereço operacional (opcional)<input name="address" maxlength="500" autocomplete="street-address"></label><button type="submit">Salvar configuração</button><p role="status" data-company-setup-status aria-live="polite"></p></form><section data-mfa-recovery-admin hidden><h3>Solicitações de recuperação MFA</h3><button type="button" data-refresh-mfa-recovery>Atualizar solicitações</button><div data-mfa-recovery-requests aria-live="polite"></div></section>
          <details class="rm-admin-form-disclosure"><summary>Convidar pessoa</summary><form data-invite><h3>Convidar funcionário ou motoboy</h3><p>O convite cria ou associa uma conta pelo email. Para liberar entregas, convide a pessoa, aguarde a ativação e depois vincule a conta ao cadastro operacional correto de motoboy. Não é criada uma segunda conta.</p><label>Email<input name="email" type="email" required maxlength="320" autocomplete="email"></label><label>Perfil de acesso<select name="roleId" required></select></label><button type="submit">Enviar convite</button><p role="status" data-invite-result></p></form></details>
          <section data-integrations hidden><h3>Integrações disponíveis</h3><div></div></section><section class="rm-admin-list-section"><h3>Usuários e convites</h3><div data-members aria-live="polite"></div></section><p data-members-note role="status" hidden>Seu perfil não permite consultar os usuários desta empresa.</p><p data-driver-access-note role="status" hidden>Para listar motoristas, sua sessão precisa da permissão de leitura de sync. A desassociação continua disponível.</p><details class="rm-admin-form-disclosure"><summary>Criar perfil</summary><form data-create-role><p>Escolha um nome e permissões que seu próprio perfil pode conceder. O código técnico é gerado automaticamente.</p><label>Nome do perfil<input name="name" required maxlength="100"></label><label>Descrição<input name="description" maxlength="240"></label><fieldset><legend>Permissões por função</legend><div data-permissions></div></fieldset><button type="submit">Criar perfil</button><p role="status" data-role-result></p></form></details><section data-roles-list><h3>Perfis de acesso</h3></section>
        </section>
        <p class="rm-privacy" data-login-privacy>Use apenas seu email, senha e códigos de verificação. Não compartilhe esses dados.</p>
      </div>
    </section>`;
  document.body.append(host);
  const $ = (selector, root = host) => root.querySelector(selector) || (root === host ? document.querySelector(selector) : null);
  const bootstrapEntry = $('[data-open-bootstrap]');
  const bootstrapSeparator = $('[data-bootstrap-separator]');
  if (bootstrapEntry) {
    fetch(`${API}/identity/bootstrap/status`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async response => response.ok ? response.json() : null)
      .then(status => {
        const visible = ['ready', 'pending_owner_activation', 'pending_owner_mfa'].includes(status?.state);
        bootstrapEntry.hidden = !visible;
        if (bootstrapSeparator) bootstrapSeparator.hidden = !visible;
      }).catch(() => {});
    bootstrapEntry.addEventListener('click', () => { location.assign('/bootstrap.html'); });
  }
  const panel = $('#rmIdentityPanel');
  const trigger = $('.rm-account-trigger');
  // Keep references before accountPage is reparented into #main or detached.
  // MFA cleanup must still clear the enrollment secret when that happens.
  const mfaQrCanvas = $('[data-mfa-qr]');
  const mfaSecretInput = $('[data-mfa-secret]');
  if (trigger) trigger.hidden = true;
  const companyAdminSection = $('[data-admin]');
  const authenticatedContent = $('[data-authenticated]');
  const accountPage = document.createElement('section');
  accountPage.id = 'rmAccountSettingsPage';
  accountPage.className = 'rm-account-settings-page';
  accountPage.hidden = true;
  accountPage.innerHTML = `<header class="rm-account-settings-heading"><div><h2 id="rmAccountPageHeading" tabindex="-1">Conta e segurança</h2><p>Gerencie acesso, proteção e vínculos da conta.</p></div><button type="button" data-account-page-close aria-label="Voltar ao aplicativo" hidden>Voltar</button></header>
    <div class="rm-account-settings-grid" data-account-overview>
      <section class="rm-account-identity-summary" aria-labelledby="rmAccountIdentityTitle"><span class="rm-account-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/></svg></span><div class="rm-account-identity-copy"><h3 id="rmAccountIdentityTitle">Minha conta</h3><div class="rm-account-identity-details" data-account-summary-slot></div><p class="rm-account-summary-company" data-account-summary-company>Empresa ativa</p></div></section>
      <section class="rm-account-settings-group" aria-labelledby="rmAccountSecurityTitle"><h3 id="rmAccountSecurityTitle">Segurança</h3><div class="rm-account-settings-list">
        <button type="button" class="rm-account-setting-row" data-account-open="password" aria-haspopup="dialog"><span class="rm-account-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span><span class="rm-account-setting-copy"><span class="rm-account-setting-title">Senha e acesso</span><span class="rm-account-setting-state">Alterar senha da conta</span></span><svg class="rm-account-setting-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
        <button type="button" class="rm-account-setting-row" data-account-open="mfa" aria-haspopup="dialog"><span class="rm-account-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/></svg></span><span class="rm-account-setting-copy"><span class="rm-account-setting-title">Verificação em duas etapas</span><span class="rm-account-setting-state" data-account-mfa-summary>Verificando proteção…</span></span><svg class="rm-account-setting-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
        <button type="button" class="rm-account-setting-row" data-account-open="recovery-codes" aria-haspopup="dialog"><span class="rm-account-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span><span class="rm-account-setting-copy"><span class="rm-account-setting-title">Códigos de recuperação</span><span class="rm-account-setting-state">Gerenciar códigos de uso único</span></span><svg class="rm-account-setting-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
      </div></section>
      <section class="rm-account-settings-group" aria-labelledby="rmAccountAccessTitle"><h3 id="rmAccountAccessTitle">Empresas e acesso</h3><div class="rm-account-settings-list">
        <button type="button" class="rm-account-setting-row" data-account-open="companies" aria-haspopup="dialog"><span class="rm-account-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 20h18M5 20V7l7-3 7 3v13M9 10h1m4 0h1m-6 4h1m4 0h1M10 20v-4h4v4"/></svg></span><span class="rm-account-setting-copy"><span class="rm-account-setting-title">Empresas vinculadas</span><span class="rm-account-setting-state">Gerenciar empresas da conta</span></span><svg class="rm-account-setting-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
        <button type="button" class="rm-account-setting-row" data-account-open="invitation" aria-haspopup="dialog"><span class="rm-account-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6M12 3v8m-4-4h8"/></svg></span><span class="rm-account-setting-copy"><span class="rm-account-setting-title">Convites</span><span class="rm-account-setting-state">Inserir código de convite</span></span><svg class="rm-account-setting-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
      </div></section>
      <section class="rm-account-settings-group rm-account-settings-group--session" aria-label="Sessão atual"><div class="rm-account-settings-list"><button type="button" class="rm-account-setting-row rm-account-setting-row--session" data-account-open="logout" aria-haspopup="dialog"><span class="rm-account-setting-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10 4H5v16h5M14 8l4 4-4 4m4-4H9"/></svg></span><span class="rm-account-setting-copy"><span class="rm-account-setting-title">Encerrar sessão</span><span class="rm-account-setting-state">Sair deste aparelho</span></span><svg class="rm-account-setting-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></div></section>
    </div>
    <dialog class="rm-account-dialog" data-account-dialog aria-modal="true" aria-labelledby="rmAccountDialogTitle" aria-describedby="rmAccountDialogDescription">
      <div class="rm-account-dialog-surface"><header><div><h2 id="rmAccountDialogTitle" data-account-dialog-title></h2><p id="rmAccountDialogDescription" data-account-dialog-description></p></div><button type="button" data-account-close aria-label="Fechar">×</button></header>
        <div class="rm-account-dialog-body">
          <section data-account-panel="password" hidden><div data-account-panel-content="password"></div></section>
          <section data-account-panel="mfa" hidden><div data-account-panel-content="mfa"></div></section>
          <section data-account-panel="companies" hidden><div data-account-panel-content="companies"><p class="rm-account-company-status" data-account-companies-state role="status" aria-live="polite"></p><div class="rm-account-company-list" data-account-companies-list></div><button type="button" class="rm-secondary" data-account-companies-retry hidden>Tentar novamente</button></div></section>
          <section data-account-panel="invitation" hidden><div data-account-panel-content="invitation"></div></section>
          <section data-account-panel="logout" hidden><div data-account-panel-content="logout"></div></section>
          <section class="rm-account-discard" data-account-panel="discard" hidden><p data-account-discard-message>Há alterações não salvas.</p><div><button type="button" data-account-discard-stay>Continuar editando</button><button type="button" class="rm-danger" data-account-discard-confirm>Descartar e fechar</button></div></section>
        </div>
        <footer class="rm-account-dialog-footer"><button type="button" data-account-cancel>Cancelar</button></footer>
      </div>
    </dialog>`;
  const accountPanel = name => accountPage.querySelector(`[data-account-panel="${name}"]`);
  const accountPanelContent = name => accountPage.querySelector(`[data-account-panel-content="${name}"]`);
  const accountSummary = $('[data-account-summary]') || $('.rm-account-summary');
  const accountEmail = accountSummary?.querySelector('[data-user-email]');
  const emailVerification = accountSummary?.querySelector('[data-email-verification]');
  const companyName = accountSummary?.querySelector('[data-company-name]');
  const companyCodeRow = accountSummary?.querySelector('[data-company-code-row]');
  if (accountSummary) {
    accountSummary.classList.add('rm-account-summary');
    const slot = accountPage.querySelector('[data-account-summary-slot]');
    if (accountEmail) slot.append(accountEmail);
    if (emailVerification) slot.append(emailVerification);
    const companySummary = accountPage.querySelector('[data-account-summary-company]');
    if (companyName && companySummary) { companyName.classList.add('rm-account-summary-company'); companySummary.replaceChildren(document.createTextNode('Empresa ativa · '), companyName); }
    companyCodeRow?.remove();
    accountSummary.remove();
  }
  const mfaSection = $('[data-mfa]');
  if (mfaSection) {
    mfaSection.querySelector('h3')?.remove();
    const recoveryCodes = mfaSection.querySelector('[data-recovery-codes]');
    const regenerateCodes = mfaSection.querySelector('[data-mfa-regenerate]');
    const setupView = document.createElement('div');
    setupView.className = 'rm-account-mfa-view'; setupView.dataset.accountMfaView = 'setup';
    const recoveryView = document.createElement('div');
    recoveryView.className = 'rm-account-mfa-view'; recoveryView.dataset.accountMfaView = 'codes'; recoveryView.hidden = true;
    const regenerationConfirm = document.createElement('div');
    regenerationConfirm.className = 'rm-account-inline-confirm rm-account-inline-confirm--compact'; regenerationConfirm.dataset.recoveryRegenerateStep = ''; regenerationConfirm.hidden = true;
    regenerationConfirm.setAttribute('role','group'); regenerationConfirm.setAttribute('aria-label','Confirmar geração de códigos de recuperação');
    regenerationConfirm.innerHTML = '<p>Gerar novos códigos invalida os códigos anteriores que ainda não foram usados.</p><div><button type="button" data-recovery-regenerate-cancel>Cancelar</button><button type="button" class="rm-danger" data-recovery-regenerate-submit>Gerar novos códigos</button></div><p role="alert" data-recovery-regenerate-error></p>';
    for (const child of [...mfaSection.childNodes]) if (child !== recoveryCodes && child !== regenerateCodes) setupView.append(child);
    if (recoveryCodes) recoveryView.append(recoveryCodes);
    if (regenerateCodes) recoveryView.append(regenerateCodes);
    recoveryView.append(regenerationConfirm);
    mfaSection.replaceChildren(setupView, recoveryView);
    mfaSection.dataset.accountMfaReady = 'true';
    accountPanelContent('mfa')?.append(mfaSection);
  }
  const switchForm = $('[data-switch]'); const invitationForm = $('[data-accept-existing]');
  if (switchForm) accountPanelContent('companies')?.append(switchForm);
  if (companyCodeRow) {
    const details = document.createElement('details'); details.className = 'rm-account-company-details';
    const summary = document.createElement('summary'); summary.textContent = 'Detalhes técnicos';
    details.append(summary, companyCodeRow); accountPanelContent('companies')?.append(details);
  }
  if (invitationForm) accountPanelContent('invitation')?.append(invitationForm);
  const recoveryDetails = $('[data-recovery]');
  const logoutButton = $('[data-logout]'); const accountError = $('[data-account-error]');
  const passwordChangeForm = $('[data-password-change]');
  if (passwordChangeForm) accountPanelContent('password')?.append(passwordChangeForm);
  if (logoutButton) accountPanelContent('logout')?.append(document.createTextNode('Encerrar a sessão neste aparelho. Você poderá entrar novamente quando precisar. '), logoutButton);
  if (accountError) accountPanelContent('logout')?.append(accountError);
  authenticatedContent?.remove();
  host.append(accountPage);
  const accountDialog = accountPage.querySelector('[data-account-dialog]');
  let accountDialogPanelName = '';
  let accountDialogInitialDraft = '';
  let accountDialogReturnFocus = null;
  let accountPageOverlayOpen = false;
  let showRecoveryCodesAfterEnrollment = false;
  let linkedCompanies = [];
  let linkedCompaniesLoad = null;
  let linkedCompaniesRequestId = 0;
  let requestedCompanySwitchId = '';
  const accountPanelCopy = {
    password: ['Alterar senha', 'Confirme sua senha atual para proteger esta alteração.'],
    mfa: ['Verificação em duas etapas', 'Gerencie a proteção da conta sem revelar o autenticador atual.'],
    'recovery-codes': ['Códigos de recuperação', 'Cada código pode ser usado uma única vez.'],
    companies: ['Empresas vinculadas', 'O servidor valida os vínculos antes de trocar a empresa ativa.'],
    invitation: ['Inserir código de convite', 'Aceite um convite enviado para esta conta.'],
    logout: ['Encerrar sessão', 'Confirme para sair desta conta neste aparelho.']
  };
  function setAccountMfaView(view) {
    accountPage.querySelectorAll('[data-account-mfa-view]').forEach(section => { section.hidden = section.dataset.accountMfaView !== view; });
    const isCodes = view === 'codes';
    const title = accountPage.querySelector('[data-account-dialog-title]');
    const description = accountPage.querySelector('[data-account-dialog-description]');
    if (title && isCodes) title.textContent = accountPanelCopy['recovery-codes'][0];
    if (description && isCodes) description.textContent = accountPanelCopy['recovery-codes'][1];
  }
  function openAccountPanel(name, { source = document.activeElement, mfaView = 'setup', force = false } = {}) {
    if (!accountDialog || (!current && !force)) return false;
    const panelName = name === 'recovery-codes' ? 'mfa' : name;
    const copy = accountPanelCopy[name] || accountPanelCopy[panelName];
    if (!copy) return false;
    if (name === 'password') { const status = accountPage.querySelector('[data-password-change-status]'); if (status) status.textContent = ''; }
    accountDialogPanelName = name;
    if (!accountDialog.open) accountDialogReturnFocus = source;
    accountPage.querySelectorAll('[data-account-panel]').forEach(section => { section.hidden = section.dataset.accountPanel !== panelName; });
    accountDialogInitialDraft = accountPanelFormSnapshot(panelName);
    if (panelName === 'mfa') setAccountMfaView(name === 'recovery-codes' ? 'codes' : mfaView);
    const title = accountPage.querySelector('[data-account-dialog-title]');
    const description = accountPage.querySelector('[data-account-dialog-description]');
    if (title) title.textContent = copy[0];
    if (description) description.textContent = copy[1];
    const cancel = accountPage.querySelector('[data-account-cancel]');
    if (cancel) cancel.textContent = name === 'logout' ? 'Voltar' : 'Cancelar';
    if (!accountDialog.open) accountDialog.showModal();
    accountDialog.classList.toggle('rm-account-dialog--long', ['mfa', 'recovery-codes', 'companies', 'invitation'].includes(name));
    syncAccountDialogActions();
    if (name === 'companies') void loadLinkedCompanies(requestedCompanySwitchId);
    requestAnimationFrame(() => {
      const activePanel = accountPanel(panelName);
      const target = [...(activePanel?.querySelectorAll('input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled])') || [])].find(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
      (target || accountPage.querySelector('[data-account-close]') || accountPage.querySelector('[data-account-dialog-title]'))?.focus();
    });
    return true;
  }
  function syncAccountDialogActions() {
    const isMfaPanel = accountDialogPanelName === 'mfa' || accountDialogPanelName === 'recovery-codes';
    const pendingEnrollment = accountPage.querySelector('[data-mfa-confirm]')?.hidden === false;
    const identityStep = accountPage.querySelector('[data-mfa-replace-verify]')?.hidden === false;
    const recoveryCodesVisible = Boolean(accountPage.querySelector('[data-recovery-code-list]')?.textContent?.trim());
    const regenerateConfirmation = accountPage.querySelector('[data-recovery-regenerate-step]')?.hidden === false;
    const handledInside = isMfaPanel && (pendingEnrollment || identityStep || recoveryCodesVisible || regenerateConfirmation);
    const headerClose = accountPage.querySelector('[data-account-close]');
    const footer = accountPage.querySelector('.rm-account-dialog-footer');
    if (headerClose) headerClose.hidden = handledInside;
    if (footer) footer.hidden = handledInside;
  }
  function companyNameForDisplay(company) {
    const name = typeof company?.name === 'string' ? company.name.trim() : '';
    if (!name || /^(?:synthetic\b|__campaign_|[0-9a-f]{8}-[0-9a-f-]{27,})/iu.test(name)) return 'Registro empresarial';
    return name;
  }
  function companyStateForDisplay(company) {
    if (company?.isActive) return 'Selecionada';
    const membership = { active: 'Vínculo ativo', invited: 'Convite pendente', suspended: 'Vínculo suspenso', revoked: 'Vínculo encerrado' }[company?.membershipStatus] || 'Vínculo não disponível';
    const status = { active: 'Empresa ativa', suspended: 'Empresa suspensa', inactive: 'Empresa indisponível' }[company?.companyStatus] || '';
    return status ? `${membership} · ${status}` : membership;
  }
  function renderLinkedCompanies(companies, requestedId = '') {
    const state = accountPage.querySelector('[data-account-companies-state]');
    const list = accountPage.querySelector('[data-account-companies-list]');
    const retry = accountPage.querySelector('[data-account-companies-retry]');
    const form = accountPage.querySelector('[data-switch]');
    const select = form?.elements.companyId;
    const submit = form?.querySelector('[type="submit"]');
    if (!state || !list || !select || !form) return;
    list.replaceChildren();
    select.replaceChildren(new Option('Escolha uma empresa', ''));
    const visibleCompanies = companies.filter(company => company && typeof company.companyId === 'string' && typeof company.name === 'string');
    for (const company of visibleCompanies) {
      const row = document.createElement('article'); row.className = 'rm-account-company-row';
      const heading = document.createElement('h3'); heading.textContent = companyNameForDisplay(company);
      const badge = document.createElement('span'); badge.className = 'rm-account-company-state'; badge.dataset.state = company.isActive ? 'current' : 'linked'; badge.textContent = companyStateForDisplay(company);
      const note = document.createElement('p'); note.textContent = company.isActive ? 'Empresa ativa nesta sessão.' : company.canSwitch ? 'Disponível para seleção por esta conta.' : 'Este vínculo não pode ser ativado nesta sessão.';
      row.append(heading, badge, note);
      if (companyNameForDisplay(company) === 'Registro empresarial') {
        const details = document.createElement('details'); details.className = 'rm-account-company-details';
        const summary = document.createElement('summary'); summary.textContent = 'Detalhes técnicos';
        const technical = document.createElement('p'); technical.textContent = `Nome cadastrado: ${company.name} · Identificador: ${company.companyId}`;
        details.append(summary, technical); row.append(details);
      }
      list.append(row);
      if (company.canSwitch && !company.isActive) select.add(new Option(companyNameForDisplay(company), company.companyId));
    }
    if (!visibleCompanies.length) {
      state.textContent = 'Nenhuma empresa vinculada foi disponibilizada para esta sessão.';
      form.hidden = true; retry.hidden = true; return;
    }
    const active = visibleCompanies.find(company => company.isActive);
    const alternatives = visibleCompanies.filter(company => company.canSwitch && !company.isActive);
    if (active && visibleCompanies.length === 1) state.textContent = `${companyNameForDisplay(active)} está selecionada. Esta conta tem somente uma empresa vinculada; não há outra para trocar.`;
    else if (active) state.textContent = `Empresa selecionada: ${companyNameForDisplay(active)}.`;
    else state.textContent = 'Empresas vinculadas a esta conta.';
    if (alternatives.length) {
      form.hidden = false;
      if (requestedId && alternatives.some(company => company.companyId === requestedId)) select.value = requestedId;
      if (submit) submit.disabled = !select.value;
    } else { form.hidden = true; if (submit) submit.disabled = true; }
    retry.hidden = true;
    accountDialogInitialDraft = accountPanelFormSnapshot('companies');
  }
  async function loadLinkedCompanies(requestedId = '') {
    if (linkedCompaniesLoad) return linkedCompaniesLoad.then(() => { if (requestedId && linkedCompanies.length) renderLinkedCompanies(linkedCompanies, requestedId); });
    const state = accountPage.querySelector('[data-account-companies-state]');
    const retry = accountPage.querySelector('[data-account-companies-retry]');
    const list = accountPage.querySelector('[data-account-companies-list]');
    const form = accountPage.querySelector('[data-switch]');
    const requestId = ++linkedCompaniesRequestId;
    const userId = current?.userId;
    if (state) state.textContent = 'Carregando empresas vinculadas…';
    if (list) list.replaceChildren();
    if (form) form.hidden = true;
    if (retry) retry.hidden = true;
    linkedCompaniesLoad = (async () => {
      try {
        const result = await request('/identity/companies');
        if (!Array.isArray(result?.companies) || result.companies.some(company => !company || typeof company.companyId !== 'string' || typeof company.name !== 'string' || typeof company.isActive !== 'boolean' || typeof company.canSwitch !== 'boolean')) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
        if (requestId !== linkedCompaniesRequestId || current?.userId !== userId) return;
        linkedCompanies = result.companies;
        renderLinkedCompanies(linkedCompanies, requestedId);
      } catch (error) {
        if (requestId !== linkedCompaniesRequestId || current?.userId !== userId) return;
        if (state) state.textContent = message(error);
        if (retry) retry.hidden = false;
      } finally {
        if (requestId === linkedCompaniesRequestId) linkedCompaniesLoad = null;
      }
    })();
    return linkedCompaniesLoad;
  }
  function accountPanelFormSnapshot(name) {
    const form = accountPanelContent(name)?.querySelector('form');
    if (!form) return '';
    return JSON.stringify([...form.elements].filter(field => field.name && !['currentPassword','currentMfaCode','mfaCode'].includes(field.name) && field.type !== 'submit').map(field => ({ name: field.name, type: field.type || '',
      value: ['checkbox','radio'].includes(field.type) ? String(field.checked) : field.value })));
  }
  function accountPanelHasDraft(name = accountDialogPanelName) {
    const panelName = name === 'recovery-codes' ? 'mfa' : name;
    const form = accountPanelContent(panelName)?.querySelector('form');
    if (!form || form.dataset.saving === 'true') return false;
    return accountPanelFormSnapshot(panelName) !== accountDialogInitialDraft;
  }
  function showAccountDiscardPrompt(messageText, confirmText = 'Descartar e fechar') {
    accountPanel('discard').hidden = false;
    accountPage.querySelectorAll('[data-account-panel]').forEach(section => { if (section.dataset.accountPanel !== 'discard') section.hidden = true; });
    accountPage.querySelector('[data-account-discard-message]').textContent = messageText;
    accountPage.querySelector('[data-account-discard-confirm]').textContent = confirmText;
    accountPage.querySelector('[data-account-discard-stay]').focus();
  }
  function closeAccountDialog(force = false) {
    if (!accountDialog?.open) return true;
    const activeForm = accountPanelContent(accountDialogPanelName === 'recovery-codes' ? 'mfa' : accountDialogPanelName)?.querySelector('form');
    const pendingAction = mfaStarting || activeForm?.dataset.saving === 'true' || activeForm?.dataset.submitting === 'true' || activeForm?.dataset.accepting === 'true' || accountPage.querySelector('[data-recovery-regenerate-submit]')?.dataset.saving === 'true' || (accountDialogPanelName === 'logout' && logoutButton?.dataset.saving === 'true');
    if (!force && pendingAction) { accountPage.querySelector('[data-account-dialog-description]').textContent = 'Aguarde a confirmação da operação antes de fechar esta tela.'; return false; }
    const pendingEnrollment = accountPage.querySelector('[data-mfa-confirm]')?.hidden === false;
    if (!force && pendingEnrollment) {
      const feedback = accountPage.querySelector('[data-mfa-error]');
      if (feedback) feedback.textContent = 'Para sair, cancele primeiro a configuração pendente. O autenticador atual não será alterado.';
      accountPage.querySelector('[data-mfa-cancel]')?.focus();
      return false;
    }
    if (!force && mfaLocked) { accountPage.querySelector('[data-account-dialog-description]').textContent = 'Conclua a verificação em duas etapas para acessar o aplicativo.'; accountPage.querySelector('[data-mfa-start]:not([hidden]),[data-mfa-replace]:not([hidden])')?.focus(); return false; }
    const shownRecoveryCodes = accountPage.querySelector('[data-recovery-code-list]')?.textContent?.trim();
    if (!force && shownRecoveryCodes) {
      showAccountDiscardPrompt('Os códigos são exibidos uma única vez. Se você ainda não os guardou, continue nesta tela.', 'Ocultar códigos e fechar');
      return false;
    }
    if (!force && accountPanelHasDraft()) {
      showAccountDiscardPrompt('Há informações digitadas que ainda não foram enviadas. Deseja descartá-las?');
      return false;
    }
    accountDialog.close();
    return true;
  }
  function openAccountPageOverlay(source = trigger) {
    if (!current || appKind !== 'motoboy' || mfaLocked) return;
    accountDialogReturnFocus = source;
    accountPageOverlayOpen = true;
    accountPage.hidden = false;
    accountPage.classList.add('rm-account-settings-page--overlay');
    accountPage.setAttribute('role', 'dialog');
    accountPage.setAttribute('aria-modal', 'true');
    accountPage.setAttribute('aria-labelledby', 'rmAccountPageHeading');
    const app = applicationRoot();
    if (app) { app.inert = true; app.setAttribute('aria-hidden', 'true'); }
    document.body.dataset.accountSettingsOpen = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => accountPage.querySelector('.rm-account-settings-heading h2')?.focus());
  }
  function closeAccountPageOverlay(force = false) {
    if (!accountPageOverlayOpen) return true;
    if (accountDialog.open && !closeAccountDialog(force)) return false;
    accountPageOverlayOpen = false;
    accountPage.hidden = true;
    accountPage.classList.remove('rm-account-settings-page--overlay');
    accountPage.removeAttribute('role'); accountPage.removeAttribute('aria-modal'); accountPage.removeAttribute('aria-labelledby');
    delete document.body.dataset.accountSettingsOpen;
    const app = applicationRoot();
    const gated = host.dataset.gated === 'true';
    if (app) { app.inert = gated; app.setAttribute('aria-hidden', String(gated)); }
    trigger.hidden = !current || mfaLocked;
    trigger.setAttribute('aria-expanded', 'false');
    if (accountDialogReturnFocus?.isConnected && !accountDialogReturnFocus.closest('[hidden]')) accountDialogReturnFocus.focus();
    else if (!gated) trigger.focus();
    return true;
  }
  accountPage.addEventListener('keydown', event => {
    if (!accountPageOverlayOpen || accountDialog.open) return;
    if (event.key === 'Escape') { event.preventDefault(); closeAccountPageOverlay(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...accountPage.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
    if (!controls.length) { event.preventDefault(); accountPage.querySelector('h2')?.focus(); return; }
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1).focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  });
  accountDialog?.addEventListener('cancel', event => { event.preventDefault(); closeAccountDialog(); });
  accountDialog?.addEventListener('click', event => { if (event.target === accountDialog) closeAccountDialog(); });
  accountDialog?.addEventListener('close', () => {
    if (accountDialog.open) return;
    accountPanelContent(accountDialogPanelName === 'recovery-codes' ? 'mfa' : accountDialogPanelName)?.querySelectorAll('form').forEach(form => form.reset());
    accountPage.classList.remove('rm-account-dialog-open');
    const recoveryList = accountPage.querySelector('[data-recovery-code-list]');
    if (recoveryList?.textContent) recoveryList.textContent = '';
    const recoveryCodes = accountPage.querySelector('[data-recovery-codes]');
    if (recoveryCodes) recoveryCodes.hidden = true;
    accountDialogPanelName = '';
    accountDialogInitialDraft = '';
    syncAccountDialogActions();
    if (accountDialogReturnFocus?.isConnected && !accountDialogReturnFocus.closest('[hidden]')) accountDialogReturnFocus.focus();
  });
  accountPage.querySelector('[data-account-close]')?.addEventListener('click', () => closeAccountDialog());
  accountPage.querySelector('[data-account-cancel]')?.addEventListener('click', () => closeAccountDialog());
  accountPage.querySelector('[data-account-discard-stay]')?.addEventListener('click', () => {
    const name = accountDialogPanelName === 'recovery-codes' ? 'mfa' : accountDialogPanelName;
    accountPage.querySelectorAll('[data-account-panel]').forEach(section => { section.hidden = section.dataset.accountPanel !== name; });
    if (name === 'mfa') setAccountMfaView(accountDialogPanelName === 'recovery-codes' ? 'codes' : 'setup');
    accountPage.querySelector('[data-account-close]')?.focus();
  });
  accountPage.querySelector('[data-account-discard-confirm]')?.addEventListener('click', () => {
    const activeName = accountDialogPanelName === 'recovery-codes' ? 'mfa' : accountDialogPanelName;
    accountPanelContent(activeName)?.querySelector('form')?.reset();
    const recoveryList = accountPage.querySelector('[data-recovery-code-list]'); if (recoveryList) recoveryList.textContent = '';
    const recoveryCodes = accountPage.querySelector('[data-recovery-codes]'); if (recoveryCodes) recoveryCodes.hidden = true;
    accountPanel('discard').hidden = true;
    closeAccountDialog(true);
  });
  accountPage.querySelectorAll('[data-account-open]').forEach(button => button.addEventListener('click', () => {
    const name = button.dataset.accountOpen;
    openAccountPanel(name, { source: button, mfaView: name === 'recovery-codes' ? 'codes' : 'setup' });
  }));
  accountPage.querySelector('[data-account-companies-retry]')?.addEventListener('click', () => { if (!linkedCompaniesLoad) void loadLinkedCompanies(requestedCompanySwitchId); });
  accountPage.querySelector('[data-switch]')?.elements.companyId?.addEventListener('change', event => {
    const submit = event.currentTarget.form?.querySelector('[type="submit"]');
    if (submit) submit.disabled = !linkedCompanies.some(company => company.companyId === event.currentTarget.value && company.canSwitch && !company.isActive);
  });
  accountPage.querySelector('[data-recovery-regenerate-cancel]')?.addEventListener('click', () => { accountPage.querySelector('[data-recovery-regenerate-step]').hidden = true; syncAccountDialogActions(); accountPage.querySelector('[data-mfa-regenerate]')?.focus(); });
  accountPage.querySelector('[data-mfa-regenerate]')?.addEventListener('click', event => { event.preventDefault(); const confirmBox = accountPage.querySelector('[data-recovery-regenerate-step]'); if (confirmBox) confirmBox.hidden = false; syncAccountDialogActions(); accountPage.querySelector('[data-recovery-regenerate-submit]')?.focus(); });
  accountPage.querySelector('[data-recovery-regenerate-submit]')?.addEventListener('click', async event => {
    const button = event.currentTarget; if (button.disabled || button.dataset.saving === 'true') return; button.dataset.saving = 'true'; button.disabled = true;
    const confirmBox = accountPage.querySelector('[data-recovery-regenerate-step]'); const cancel = accountPage.querySelector('[data-recovery-regenerate-cancel]'); if (cancel) cancel.disabled = true; confirmBox?.setAttribute('aria-busy','true');
    const error = accountPage.querySelector('[data-recovery-regenerate-error]'); if (error) error.textContent = '';
    try {
      const result = await request('/identity/mfa/recovery-codes', { method: 'POST', body: '{}' });
      if (!Array.isArray(result?.recoveryCodes) || result.recoveryCodes.some(code => typeof code !== 'string' || !code)) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
      accountPage.querySelector('[data-recovery-code-list]').textContent = result.recoveryCodes.join('\n');
      accountPage.querySelector('[data-recovery-codes]').hidden = false;
      accountPage.querySelector('[data-recovery-regenerate-step]').hidden = true;
      accountPage.querySelector('[data-mfa-start-status]').textContent = 'Novos códigos gerados. Guarde-os agora; eles não poderão ser consultados novamente.';
      syncAccountDialogActions(); accountPage.querySelector('[data-recovery-codes-dismiss]')?.focus();
    } catch (errorValue) { if (error) error.textContent = message(errorValue); }
    finally { delete button.dataset.saving; button.disabled = false; if (cancel) cancel.disabled = false; confirmBox?.removeAttribute('aria-busy'); }
  });
  accountPage.querySelector('[data-account-page-close]')?.addEventListener('click', () => closeAccountPageOverlay());
  const adminPage = document.createElement('section');
  adminPage.id = 'rmCompanyAdminPage';
  adminPage.className = 'rm-company-admin-page';
  adminPage.hidden = true;
  adminPage.setAttribute('aria-label', 'Configurações da empresa');
  adminPage.innerHTML = '<p data-admin-load-status role="status" aria-live="polite"></p><div class="rm-company-admin-content"></div>';
  host.append(adminPage);
  const platformAdminPage=document.createElement('section');platformAdminPage.id='rmPlatformAdminPage';platformAdminPage.className='rm-company-admin-page';platformAdminPage.hidden=true;
  platformAdminPage.setAttribute('aria-label', 'Administração global');
  platformAdminPage.innerHTML='<nav class="rm-admin-nav" aria-label="Administração global" aria-describedby="rmPlatformNavHint"><button type="button" aria-pressed="true" data-platform-list="companies">Empresas</button><button type="button" aria-pressed="false" data-platform-list="users">Usuários</button><button type="button" aria-pressed="false" data-platform-list="memberships">Vínculos</button><button type="button" aria-pressed="false" data-platform-list="roles">Perfis e permissões</button><button type="button" aria-pressed="false" data-platform-list="finance">Resumo financeiro</button><button type="button" aria-pressed="false" data-platform-list="settings">Configuração da plataforma</button></nav><p id="rmPlatformNavHint" class="rm-platform-nav-hint">No celular, deslize para acessar as seis seções.</p><p data-platform-error role="alert" aria-live="polite"></p><p data-platform-feedback role="status" aria-live="polite"></p><button type="button" data-platform-refresh>Atualizar lista</button><div data-platform-results aria-live="polite" aria-busy="false"></div>';
  host.append(platformAdminPage);
  let platformDisclosureSequence=0,platformFinanceCompanyId='';const platformAdminRequests=window.RotaMotoIdentityRequestState.createLatestRequestState(),platformFinanceRequests=window.RotaMotoIdentityRequestState.createLatestRequestState();
  function platformSchemaError(){return Object.assign(new Error('A resposta da administração está incompleta ou incompatível.'),{code:'INVALID_RESPONSE'})}
  function platformRows(data){if(!data||!Array.isArray(data.items))throw platformSchemaError();return data.items}
  const platformAdminRequest=window.RotaMotoPlatformAdminRequest.create((path,options)=>request(path,options));
  function platformValue(row,...keys){for(const key of keys)if(Object.prototype.hasOwnProperty.call(row,key))return row[key];return undefined}
  function platformText(row,...keys){const value=platformValue(row,...keys);if(typeof value!=='string'||!value.trim())throw platformSchemaError();return value.trim()}
  function platformBoolean(row,...keys){const value=platformValue(row,...keys);if(typeof value!=='boolean')throw platformSchemaError();return value}
  function platformCount(row,...keys){const value=platformValue(row,...keys);if(value===null||value===undefined)return null;if(!Number.isSafeInteger(value)||value<0)throw platformSchemaError();return value}
  function platformCompany(row){if(!row||typeof row!=='object')throw platformSchemaError();const status=platformText(row,'status');const safeStatus=['active','suspended','provisioning','closed'].includes(status)?status:'unknown';return{id:platformText(row,'id'),name:platformText(row,'name'),status:safeStatus,memberCount:platformCount(row,'member_count','memberCount')}}
  function platformUser(row){if(!row||typeof row!=='object')throw platformSchemaError();return{id:platformText(row,'id'),email:platformText(row,'email'),emailVerified:platformBoolean(row,'email_verified','emailVerified'),disabled:platformBoolean(row,'disabled'),companyCount:platformCount(row,'company_count','companyCount'),platformAdmin:platformBoolean(row,'platform_admin','platformAdmin')}}
  function platformMembership(row){if(!row||typeof row!=='object')throw platformSchemaError();const status=platformText(row,'status');if(!['active','invited','suspended','revoked'].includes(status))throw platformSchemaError();return{id:platformText(row,'id'),companyName:platformText(row,'company_name','companyName'),email:platformText(row,'email'),roleName:platformText(row,'role_name','roleName'),status,hasDriverLink:platformBoolean(row,'has_driver_link','hasDriverLink')}}
  function platformRole(row){if(!row||typeof row!=='object')throw platformSchemaError();const catalog=platformValue(row,'permission_catalog','permissionCatalog'),permissions=platformValue(row,'permissions');if(!Array.isArray(catalog)||!Array.isArray(permissions)||permissions.some(key=>typeof key!=='string'))throw platformSchemaError();const normalizedCatalog=catalog.map(item=>{const key=platformText(item,'key');return window.RotaMotoPlatformPermissionCatalog.present(key)});const keys=new Set(normalizedCatalog.map(item=>item.key));if(!keys.size||keys.size!==normalizedCatalog.length||permissions.some(key=>!keys.has(key)))throw platformSchemaError();return{id:platformText(row,'id'),name:platformText(row,'display_name','displayName'),key:platformText(row,'role_key','roleKey'),protected:platformBoolean(row,'protected')||platformValue(row,'role_key','roleKey')==='owner',systemTemplate:platformValue(row,'is_system_template','isSystemTemplate')===true,permissions:[...new Set(permissions)],catalog:normalizedCatalog}}
  const platformStatusLabel={active:'Ativa',suspended:'Suspensa',provisioning:'Em configuração',closed:'Encerrada',invited:'Convite pendente',revoked:'Revogado',unknown:'Estado não reconhecido'};
  function platformCompanyNameNote(name){return /^(?:Synthetic\s|__campaign_)/iu.test(name)?'Nome com padrão técnico; a origem deste registro não foi confirmada.':''}
  function platformLabeledValue(label,value){const wrap=document.createElement('div');wrap.className='rm-platform-fact';const name=document.createElement('span');name.textContent=label;const content=document.createElement('strong');content.textContent=value;wrap.append(name,content);return wrap}
  async function confirmRoleDraftDiscard(root){
    const dirty=[...root.querySelectorAll('[data-platform-role-form][data-dirty="true"]')];
    if(!dirty.length)return true;
    const result=await window.RotaMotoDialog?.confirm({title:'Descartar alterações não salvas?',message:'Há permissões alteradas que ainda não foram salvas. Se continuar, essas alterações serão descartadas.',danger:true,confirmLabel:'Descartar alterações'});
    return result?.confirmed===true;
  }
  function renderPlatformRoleEditor(company,role){
    const panel=document.createElement('section');panel.className='rm-platform-role';
    const heading=document.createElement('div');heading.className='rm-platform-role-head';
    const name=document.createElement('h4');name.textContent=role.name;
    const badge=document.createElement('span');badge.className=role.protected?'rm-platform-status rm-platform-status--protected':'rm-platform-status';badge.textContent=role.protected?'Perfil protegido':role.systemTemplate?'Modelo do sistema':'Perfil empresarial';
    const toggle=document.createElement('button');toggle.type='button';toggle.className='btn rm-platform-role-toggle';toggle.textContent='Ver permissões';
    heading.append(name,badge);panel.append(heading);
    const content=document.createElement('div');content.className='rm-platform-role-content';
    const scope=document.createElement('p');scope.className='rm-platform-help';scope.textContent='Esta lista mostra as permissões do perfil nesta empresa, não as permissões temporárias da sessão.';content.append(scope);
    const form=document.createElement('form');form.className='rm-platform-permission-form';form.dataset.platformRoleForm='';form.dataset.dirty='false';
    const fieldset=document.createElement('fieldset');fieldset.disabled=role.protected;
    const legend=document.createElement('legend');legend.textContent='Permissões do perfil';fieldset.append(legend);
    const grid=document.createElement('div');grid.className='rm-platform-permission-groups';
    let initial=role.permissions.slice().sort();const controls=[],groups=new Map();
    for(const permission of role.catalog){
      let group=groups.get(permission.category);
      if(!group){group=document.createElement('section');group.className='rm-platform-permission-group';const title=document.createElement('h5');title.textContent=permission.category;const items=document.createElement('div');items.className='rm-platform-permission-grid';group.append(title,items);grid.append(group);groups.set(permission.category,items)}
      const granted=role.permissions.includes(permission.key),row=document.createElement('div');row.className='rm-platform-permission-row';
      const label=document.createElement('label');label.className='rm-platform-permission';
      const input=document.createElement('input');input.type='checkbox';input.name='permission';input.value=permission.key;input.checked=granted;input.disabled=role.protected;
      const copy=document.createElement('span');copy.className='rm-platform-permission-copy';const description=document.createElement('strong');description.textContent=permission.label;
      const stateLabel=document.createElement('small');stateLabel.className='rm-platform-permission-state';stateLabel.textContent=granted?'Concedida neste perfil':'Não concedida neste perfil';copy.append(description,stateLabel);
      label.append(input,copy);row.append(label);
      const detail=document.createElement('details');detail.className='rm-platform-permission-description';const summary=document.createElement('summary');summary.textContent=permission.known?'Descrição':'Descrição e detalhe administrativo';const explanation=document.createElement('p');explanation.textContent=permission.description;detail.append(summary,explanation);
      if(!permission.known){const code=document.createElement('code');code.textContent=permission.key;detail.append(code)}
      row.append(detail);groups.get(permission.category).append(row);controls.push(input);
    }
    fieldset.append(grid);form.append(fieldset);
    const feedback=document.createElement('p');feedback.className='rm-platform-inline-status';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');form.append(feedback);
    if(role.protected){const note=document.createElement('p');note.className='rm-platform-protected-note';note.textContent='As permissões essenciais deste perfil são protegidas e não podem ser alteradas aqui.';form.append(note)}
    else{
      const actions=document.createElement('div');actions.className='rm-platform-role-actions';
      const reset=document.createElement('button');reset.type='button';reset.className='btn';reset.textContent='Cancelar alterações';reset.disabled=true;
      const save=document.createElement('button');save.type='submit';save.className='btn primary';save.textContent='Salvar permissões';save.disabled=true;actions.append(reset,save);form.append(actions);
      const currentKeys=()=>controls.filter(input=>input.checked).map(input=>input.value).sort();
      const updateDirty=()=>{const dirty=JSON.stringify(currentKeys())!==JSON.stringify(initial);form.dataset.dirty=String(dirty);save.disabled=!dirty;reset.disabled=!dirty;feedback.textContent=dirty?'Há alterações não salvas neste perfil.':''};
      controls.forEach(input=>input.addEventListener('change',()=>{const keys=currentKeys();if(keys.includes('finance.manage')&&!keys.includes('finance.read')){const financeRead=controls.find(control=>control.value==='finance.read');if(financeRead){financeRead.checked=true;feedback.textContent='“Gerenciar registros financeiros” exige “Consultar registros financeiros”; as duas permissões foram selecionadas.'}}updateDirty()}));
      reset.addEventListener('click',()=>{controls.forEach(input=>{input.checked=initial.includes(input.value)});updateDirty()});
      form.addEventListener('submit',async event=>{
        event.preventDefault();if(save.disabled||save.dataset.saving==='true')return;save.dataset.saving='true';save.disabled=true;
        try{
          const permissionKeys=currentKeys();
          const confirmation=await window.RotaMotoDialog?.confirm({title:'Salvar permissões do perfil?',message:`As alterações serão aplicadas ao perfil “${role.name}” desta empresa e registradas na auditoria.`,confirmLabel:'Salvar permissões',loadingLabel:'Salvando…',errorMessage:message,onConfirm:async()=>{
            const latest=platformRows(await platformAdminRequest(`/platform-admin/companies/${encodeURIComponent(company.id)}/roles`)).map(platformRole).find(item=>item.id===role.id);
            if(!latest||JSON.stringify(latest.permissions.slice().sort())!==JSON.stringify(initial))throw Object.assign(new Error('Este perfil foi alterado em outra sessão. Releia os dados antes de tentar novamente.'),{code:'CONFLICT'});
            return platformAdminRequest(`/platform-admin/companies/${encodeURIComponent(company.id)}/roles/${encodeURIComponent(role.id)}/permissions`,null,{method:'PATCH',body:JSON.stringify({permissionKeys,reason:'platform_policy'})});
          }});
          if(!confirmation?.confirmed)return;
          feedback.textContent='Permissões salvas. Conferindo o estado atualizado…';
          const refreshed=platformRows(await platformAdminRequest(`/platform-admin/companies/${encodeURIComponent(company.id)}/roles`)).map(platformRole).find(item=>item.id===role.id);
          if(!refreshed||JSON.stringify(refreshed.permissions.slice().sort())!==JSON.stringify(permissionKeys))throw Object.assign(new Error('O perfil mudou durante a atualização. Releia os dados antes de tentar novamente.'),{code:'CONFLICT'});
          initial=refreshed.permissions.slice().sort();
          controls.forEach(input=>{input.checked=initial.includes(input.value);const state=input.closest('.rm-platform-permission')?.querySelector('.rm-platform-permission-state');if(state)state.textContent=input.checked?'Concedida neste perfil':'Não concedida neste perfil'});
          updateDirty();feedback.textContent=`As permissões do perfil “${role.name}” foram salvas e confirmadas.`;
        }catch(error){feedback.textContent=message(error)}finally{delete save.dataset.saving;updateDirty()}
      });
    }
    content.append(form);panel.append(toggle,content);
    window.RotaMotoPlatformAdminDisclosure.create(toggle,content,{beforeCollapse:()=>confirmRoleDraftDiscard(form),expandedLabel:'Recolher permissões',collapsedLabel:'Ver permissões',onError:error=>{feedback.textContent=message(error)}});
    return panel;
  }
  function renderPlatformCompanies(box,rows,kind){
    const roleViews=[];
    for(const company of rows){
      const card=document.createElement('article');card.className='rm-platform-card rm-platform-company-card';
      const header=document.createElement('div');header.className='rm-platform-card-head';
      const title=document.createElement('h3'),technicalName=/^(?:Synthetic\s|__campaign_)/iu.test(company.name);title.textContent=technicalName?'Registro empresarial':company.name;
      const badge=document.createElement('span');badge.className=`rm-platform-status rm-platform-status--${company.status}`;badge.textContent=platformStatusLabel[company.status];header.append(title,badge);card.append(header);
      const meta=document.createElement('p');meta.className='rm-platform-company-meta';
      meta.textContent=company.memberCount===null?'Quantidade de vínculos não disponível':`${company.memberCount} ${company.memberCount===1?'vínculo ativo':'vínculos ativos'}`;
      card.append(meta);
      if(technicalName){const detail=document.createElement('details');detail.className='rm-platform-company-technical';const summary=document.createElement('summary');summary.textContent='Detalhes do registro';const note=document.createElement('p');note.textContent='Este nome segue um padrão técnico; a origem não foi confirmada.';const identifier=document.createElement('code');identifier.className='rm-platform-technical-name';identifier.textContent=company.name;detail.append(summary,note,identifier);card.append(detail)}
      const actions=document.createElement('div');actions.className='rm-platform-company-actions';
      if(kind==='companies'&&['active','suspended'].includes(company.status)){
        const action=document.createElement('button');action.type='button';action.className='btn';const suspending=company.status==='active';action.textContent=suspending?'Suspender empresa':'Reativar empresa';
        action.addEventListener('click',async()=>{action.disabled=true;try{const reason=await window.RotaMotoDialog.prompt({title:suspending?'Motivo da suspensão':'Motivo da reativação',message:'Escolha o motivo para registrar esta alteração na auditoria.',fieldLabel:'Motivo',options:[{value:'business_review',label:'Revisão empresarial'},{value:'security_review',label:'Revisão de segurança'},{value:'owner_request',label:'Solicitação do proprietário'}]});if(!reason)return;const result=await window.RotaMotoDialog.confirm({title:suspending?'Suspender esta empresa?':'Reativar esta empresa?',message:`${company.name} ficará ${suspending?'suspensa':'ativa'} após confirmação do servidor.`,danger:suspending,confirmLabel:suspending?'Suspender empresa':'Reativar empresa',loadingLabel:'Atualizando…',errorMessage:message,onConfirm:()=>platformAdminRequest(`/platform-admin/companies/${encodeURIComponent(company.id)}`,null,{method:'PATCH',body:JSON.stringify({status:suspending?'suspended':'active',reason})})});if(!result?.confirmed)return;if(platformAdminPage.querySelector('[data-platform-list][aria-pressed="true"]')?.dataset.platformList==='companies'){const refreshed=await loadPlatformAdmin('companies');if(!refreshed?.some(item=>item.id===company.id&&item.status===(suspending?'suspended':'active')))throw Object.assign(new Error('A lista atualizada não confirmou o novo estado.'),{code:'CONFLICT'});platformAdminPage.querySelector('[data-platform-feedback]').textContent='Estado da empresa atualizado e confirmado na lista.'}}catch(error){if(card.isConnected&&platformAdminPage.querySelector('[data-platform-list][aria-pressed="true"]')?.dataset.platformList==='companies')platformAdminPage.querySelector('[data-platform-error]').textContent=message(error)}finally{action.disabled=false}});actions.append(action);
      }
      if(kind==='roles'){
        const toggle=document.createElement('button');toggle.type='button';toggle.className='btn rm-platform-company-toggle';toggle.textContent='Consultar perfis e permissões';
        const status=document.createElement('p');status.className='rm-platform-inline-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
        const panel=document.createElement('div');panel.dataset.companyRoles='';panel.className='rm-platform-role-list';panel.id=`rm-platform-company-roles-${++platformDisclosureSequence}`;
        const disclosure=window.RotaMotoPlatformAdminDisclosure.create(toggle,panel,{
          expandedLabel:'Recolher perfis',collapsedLabel:'Consultar perfis e permissões',
          beforeCollapse:()=>confirmRoleDraftDiscard(panel),
          onError:error=>{status.textContent=message(error)},
          onExpand:async()=>{
            for(const previous of roleViews){if(previous.panel!==panel&&previous.disclosure.isExpanded()){if(!await previous.disclosure.close())return false}}
            if(panel.dataset.loaded==='true')return true;
            toggle.disabled=true;status.textContent='Consultando perfis desta empresa…';
            try{
              const response=await platformAdminRequest(`/platform-admin/companies/${encodeURIComponent(company.id)}/roles`),roles=platformRows(response).map(platformRole);
              if(!card.isConnected||platformAdminPage.querySelector('[data-platform-list][aria-pressed="true"]')?.dataset.platformList!=='roles')return false;
              panel.replaceChildren();
              if(!roles.length){const empty=document.createElement('p');empty.className='rm-platform-empty';empty.textContent='Nenhum perfil disponível para esta empresa.';panel.append(empty)}
              else for(const role of roles)panel.append(renderPlatformRoleEditor(company,role));
              panel.dataset.loaded='true';status.textContent='';return true;
            }catch(error){status.textContent=message(error);return false}
            finally{toggle.disabled=false}
          }
        });
        roleViews.push({panel,disclosure,toggle});actions.append(toggle);card.append(actions,status,panel);
      }else if(actions.childElementCount)card.append(actions);
      box.append(card);
    }
  }

  function renderPlatformFinancePanel(box,companies){
    const section=document.createElement('section');section.className='rm-platform-card rm-platform-finance-panel';
    const heading=document.createElement('div');heading.className='rm-platform-card-head';const title=document.createElement('h3');title.textContent='Resumo financeiro';const scope=document.createElement('span');scope.className='rm-platform-status';scope.textContent='Consulta por empresa e período';heading.append(title,scope);section.append(heading);
    if(!companies.length){const empty=document.createElement('p');empty.className='rm-platform-empty';empty.textContent='Nenhuma empresa disponível para consultar totais financeiros.';section.append(empty);box.append(section);return}
    const form=document.createElement('form');form.className='rm-platform-finance-query';
    const companyLabel=document.createElement('label');companyLabel.textContent='Empresa';const select=document.createElement('select');select.className='rm-platform-field';select.setAttribute('aria-label','Empresa para consulta financeira');
    for(const company of companies){const option=document.createElement('option');option.value=company.id;option.textContent=company.name;select.append(option)}
    if(companies.some(item=>item.id===platformFinanceCompanyId))select.value=platformFinanceCompanyId;else platformFinanceCompanyId=companies[0].id;select.value=platformFinanceCompanyId;companyLabel.append(select);
    const period=document.createElement('div');period.className='rm-platform-period';const startLabel=document.createElement('label');startLabel.textContent='Data inicial';const start=document.createElement('input');start.type='date';start.className='rm-platform-field';start.required=true;start.value=new Date(new Date().getFullYear(),new Date().getMonth(),1).toISOString().slice(0,10);startLabel.append(start);const endLabel=document.createElement('label');endLabel.textContent='Data final';const end=document.createElement('input');end.type='date';end.className='rm-platform-field';end.required=true;end.value=new Date().toISOString().slice(0,10);endLabel.append(end);period.append(startLabel,endLabel);
    const submit=document.createElement('button');submit.type='submit';submit.className='btn primary';submit.textContent='Consultar totais';const status=document.createElement('div');status.className='rm-platform-finance-result';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const invalidate=()=>{platformFinanceRequests.cancel();form.removeAttribute('aria-busy');submit.disabled=false;submit.textContent='Consultar totais';status.textContent='Selecione “Consultar totais” para carregar os dados desta empresa e período.'};
    select.addEventListener('change',()=>{platformFinanceCompanyId=select.value;invalidate()});start.addEventListener('change',invalidate);end.addEventListener('change',invalidate);
    form.append(companyLabel,period,submit,status);form.addEventListener('submit',async event=>{event.preventDefault();if(!start.value||!end.value||end.value<start.value){status.textContent='Informe um período válido.';return}const companyId=select.value;if(!companyId){status.textContent='Selecione uma empresa para continuar.';return}
      const requestState=platformFinanceRequests.begin(),fromDate=start.value,toDate=end.value;platformFinanceCompanyId=companyId;submit.disabled=true;submit.textContent='Consultando…';form.setAttribute('aria-busy','true');status.textContent='Consultando totais financeiros…';
      try{const params=new URLSearchParams({from:new Date(`${fromDate}T00:00:00.000Z`).toISOString(),to:new Date(`${toDate}T23:59:59.999Z`).toISOString()}),response=await platformAdminRequest(`/platform-admin/companies/${encodeURIComponent(companyId)}/financial-summary?${params}`,requestState,{signal:requestState.signal});if(!requestState.isCurrent()||!form.isConnected||requestState.signal.aborted||select.value!==companyId||start.value!==fromDate||end.value!==toDate)return;const result=platformFinancialSummary(response.item);if(result.companyId!==companyId)throw platformSchemaError();status.replaceChildren();const resultHeading=document.createElement('h4');resultHeading.textContent='Totais agregados';status.append(resultHeading);const events=document.createElement('div');events.className='rm-platform-finance-events';for(const item of result.events){const eventCard=document.createElement('article');eventCard.className='rm-platform-finance-event';eventCard.append(platformLabeledValue('Categoria',({PAYMENT_CONFIRMED:'Recebimento confirmado',REFUND:'Reembolso',ADJUSTMENT:'Ajuste financeiro',PAYOUT_SETTLED:'Repasse confirmado'})[item.eventKind]||'Outra categoria financeira'),platformLabeledValue('Moeda',item.currency),platformLabeledValue('Registros',String(item.eventCount)),platformLabeledValue('Total registrado',formatPlatformMinor(item.amountMinor,item.currency)));events.append(eventCard)}if(!result.events.length){const empty=document.createElement('p');empty.textContent='Nenhum movimento financeiro neste período.';status.append(empty)}else status.append(events);const note=document.createElement('p');note.className='rm-platform-help';note.textContent='Consulta agregada da empresa selecionada. Não confirma liquidação bancária.';status.append(note)
      }catch(error){if(!requestState.isCurrent()||requestState.signal.aborted||error?.name==='AbortError')return;if(form.isConnected)status.textContent=message(error)}finally{if(requestState.isCurrent()){submit.disabled=false;submit.textContent='Consultar totais';form.removeAttribute('aria-busy')}}
    });section.append(form);box.append(section)
  }
  function platformFinancialSummary(item){if(!item||typeof item!=='object'||typeof item.companyId!=='string'||item.scope!=='aggregate_only'||!Array.isArray(item.events))throw platformSchemaError();return{companyId:item.companyId,events:item.events.map(event=>{if(!event||typeof event!=='object'||typeof event.eventKind!=='string'||typeof event.currency!=='string'||!Number.isSafeInteger(event.eventCount)||event.eventCount<0||typeof event.amountMinor!=='string'||!/^-?\d+$/.test(event.amountMinor))throw platformSchemaError();try{new Intl.NumberFormat('pt-BR',{style:'currency',currency:event.currency})}catch(_){throw platformSchemaError()}return{eventKind:event.eventKind,currency:event.currency,eventCount:event.eventCount,amountMinor:event.amountMinor}})}}
  function formatPlatformMinor(minorText,currency){try{const formatter=new Intl.NumberFormat('pt-BR',{style:'currency',currency}),digits=formatter.resolvedOptions().maximumFractionDigits,minor=BigInt(minorText),scale=10n**BigInt(digits),negative=minor<0n,absolute=negative?-minor:minor,whole=absolute/scale,fraction=(absolute%scale).toString().padStart(digits,'0'),grouped=new Intl.NumberFormat('pt-BR',{maximumFractionDigits:0}).format(whole),parts=formatter.formatToParts(negative?-1n:1n);return parts.map(part=>part.type==='integer'?grouped:part.type==='fraction'?fraction:part.value).join('')}catch(_){return'Valor não disponível para formatação'}}
  async function loadPlatformAdmin(kind='companies'){
    if(!current?.platformAdmin||mfaLocked)throw Object.assign(new Error('FORBIDDEN'),{code:'FORBIDDEN'});
    const requestState=platformAdminRequests.begin();platformFinanceRequests.cancel();const box=platformAdminPage.querySelector('[data-platform-results]'),errorSlot=platformAdminPage.querySelector('[data-platform-error]'),feedback=platformAdminPage.querySelector('[data-platform-feedback]'),refresh=platformAdminPage.querySelector('[data-platform-refresh]');
    platformAdminPage.dataset.activeSection=kind;platformAdminPage.querySelectorAll('[data-platform-list]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.platformList===kind)));errorSlot.textContent='';feedback.textContent='';box.replaceChildren();box.dataset.section=kind;box.dataset.state='loading';box.setAttribute('aria-busy','true');refresh.disabled=true;refresh.textContent='Atualizando…';const loading=document.createElement('p');loading.className='rm-platform-loading';loading.textContent='Carregando informações…';loading.setAttribute('role','status');box.append(loading);
    try{
      if(kind==='settings'){
        const response=await platformAdminRequest('/platform-admin/settings',requestState,{signal:requestState.signal});if(!requestState.isCurrent())return;const item=response?.item;if(!item||typeof item.platform_admin_mfa_required!=='boolean'||!['company_scoped','unavailable'].includes(item.tenant_isolation)||typeof item.scope!=='string'||typeof item.founder_claimed!=='boolean'||typeof item.financial_review!=='string')throw platformSchemaError();const card=document.createElement('article');card.className='rm-platform-card';const title=document.createElement('h3');title.textContent='Políticas de segurança da plataforma';card.append(title);const facts=document.createElement('div');facts.className='rm-platform-settings-grid';facts.append(platformLabeledValue('Verificação em duas etapas',item.platform_admin_mfa_required?'Obrigatória para administração global':'Não obrigatória'),platformLabeledValue('Isolamento de dados',item.tenant_isolation==='company_scoped'?'Separado por empresa':'Indisponível'),platformLabeledValue('Gerenciamento da plataforma',item.scope==='deployment_managed'?'Controlado fora do aplicativo':'Indisponível'),platformLabeledValue('Bootstrap inicial',item.founder_claimed?'Registro de fundador existente':'Sem registro de fundador'),platformLabeledValue('Consulta financeira global',item.financial_review==='explicit_company_period_aggregate_only'?'Agregada, por empresa e período':'Indisponível'));card.append(facts);const note=document.createElement('p');note.className='rm-platform-help';note.textContent='O registro do bootstrap indica que a inicialização fundacional ocorreu; não comprova, por si só, qual usuário possui hoje o privilégio Super ADM Global. O estado de cada conta é exibido separadamente na lista de usuários.';const policyNote=document.createElement('p');policyNote.className='rm-platform-protected-note';policyNote.textContent='Estas políticas são administradas pelo ambiente de implantação e não podem ser alteradas nesta tela. Segredos e parâmetros internos não são exibidos.';card.append(note,policyNote);box.replaceChildren(card);box.dataset.state='success';return;
      }
      const route={companies:'/platform-admin/companies',users:'/platform-admin/users',memberships:'/platform-admin/memberships',roles:'/platform-admin/companies',finance:'/platform-admin/companies'}[kind];if(!route)throw Object.assign(new Error('INVALID_INPUT'),{code:'INVALID_INPUT'});const response=await platformAdminRequest(route,requestState,{signal:requestState.signal});if(!requestState.isCurrent())return;const raw=platformRows(response);let result;if(kind==='companies'||kind==='roles'||kind==='finance'){result=raw.map(platformCompany);}else if(kind==='users'){result=raw.map(platformUser)}else{result=raw.map(platformMembership)}if(!requestState.isCurrent())return;loading.remove();box.dataset.state=raw.length?'success':'empty';if(kind==='companies'||kind==='roles'||kind==='finance'){if(kind==='companies')renderPlatformCompanies(box,result,'companies');else if(kind==='finance')renderPlatformFinancePanel(box,result);else renderPlatformCompanies(box,result,kind)}else if(kind==='users')renderPlatformUsers(box,result);else renderPlatformMemberships(box,result);errorSlot.textContent='';if(!raw.length)feedback.textContent=({companies:'Nenhuma empresa disponível para esta conta.',users:'Nenhuma conta disponível para esta consulta.',memberships:'Nenhum vínculo empresarial disponível.',roles:'Nenhuma empresa disponível para consultar perfis.',finance:'Nenhuma empresa disponível para consultar totais financeiros.'})[kind]||'Nenhum registro disponível.';return result;
    }catch(error){if(!requestState.isCurrent()||requestState.signal.aborted)return;box.replaceChildren();box.dataset.state='error';errorSlot.textContent=message(error);throw error}finally{if(requestState.isCurrent()){box.setAttribute('aria-busy','false');refresh.disabled=false;refresh.textContent='Atualizar lista'}}
  }
  function renderPlatformUsers(box,rows){for(const user of rows){const card=document.createElement('article');card.className='rm-platform-card';const title=document.createElement('h3');title.textContent=user.email;const status=document.createElement('span');status.className=`rm-platform-status ${user.disabled?'rm-platform-status--suspended':'rm-platform-status--active'}`;status.textContent=user.disabled?'Conta suspensa':'Conta ativa';const header=document.createElement('div');header.className='rm-platform-card-head';header.append(title,status);const facts=document.createElement('div');facts.className='rm-platform-facts';facts.append(platformLabeledValue('Email confirmado',user.emailVerified?'Sim':'Não'),platformLabeledValue('Vínculos empresariais',user.companyCount===null?'Quantidade não disponível':String(user.companyCount)),platformLabeledValue('Super ADM Global',user.platformAdmin?'Sim':'Não'));card.append(header,facts);if(user.id!==current.userId){const button=document.createElement('button');button.type='button';button.className='btn';button.textContent=user.disabled?'Reativar conta':'Suspender conta';button.addEventListener('click',async()=>{const next=!user.disabled;button.disabled=true;const result=await window.RotaMotoDialog?.confirm({title:`${next?'Suspender':'Reativar'} esta conta?`,message:`A conta ${user.email} será ${next?'suspensa':'reativada'}. A alteração será registrada na auditoria.`,danger:next,confirmLabel:next?'Suspender conta':'Reativar conta',loadingLabel:'Salvando…',errorMessage:message,onConfirm:()=>platformAdminRequest(`/platform-admin/users/${encodeURIComponent(user.id)}`,null,{method:'PATCH',body:JSON.stringify({disabled:next,reason:'security_review'})})});if(result?.confirmed&&platformAdminPage.querySelector('[data-platform-list][aria-pressed="true"]')?.dataset.platformList==='users'){try{const refreshed=await loadPlatformAdmin('users');if(!refreshed?.some(item=>item.id===user.id&&item.disabled===next))throw Object.assign(new Error('A lista atualizada não confirmou o novo estado.'),{code:'CONFLICT'});platformAdminPage.querySelector('[data-platform-feedback]').textContent='Estado da conta atualizado e relido.'}catch(error){if(card.isConnected&&platformAdminPage.querySelector('[data-platform-list][aria-pressed="true"]')?.dataset.platformList==='users')platformAdminPage.querySelector('[data-platform-error]').textContent=message(error)}}button.disabled=false});card.append(button)}box.append(card)}}
  function renderPlatformMemberships(box,rows){for(const membership of rows){const card=document.createElement('article');card.className='rm-platform-card';const header=document.createElement('div');header.className='rm-platform-card-head';const title=document.createElement('h3');title.textContent=membership.email;const badge=document.createElement('span');badge.className=`rm-platform-status rm-platform-status--${membership.status}`;badge.textContent=platformStatusLabel[membership.status];header.append(title,badge);const facts=document.createElement('div');facts.className='rm-platform-facts';facts.append(platformLabeledValue('Empresa',membership.companyName),platformLabeledValue('Papel na empresa',membership.roleName),platformLabeledValue('Escopo','Esta empresa'),platformLabeledValue('Vínculo com cadastro de motoboy',membership.hasDriverLink?'Vinculado':'Não vinculado'),platformLabeledValue('Origem do vínculo','Não informada pela consulta'));card.append(header,facts);box.append(card)}}
  platformAdminPage.querySelectorAll('[data-platform-list]').forEach(button=>button.addEventListener('click',async()=>{const selected=button.dataset.platformList;if(!await confirmRoleDraftDiscard(platformAdminPage))return;platformAdminPage.querySelectorAll('[data-platform-list]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));const nav=button.parentElement;if(nav.scrollWidth>nav.clientWidth){const left=button.offsetLeft-nav.offsetLeft,right=left+button.offsetWidth;if(left<nav.scrollLeft)nav.scrollTo({left,behavior:'smooth'});else if(right>nav.scrollLeft+nav.clientWidth)nav.scrollTo({left:right-nav.clientWidth,behavior:'smooth'})}loadPlatformAdmin(selected).catch(error=>{platformAdminPage.querySelector('[data-platform-error]').textContent=message(error)})}));
  platformAdminPage.querySelector('[data-platform-refresh]').addEventListener('click',async()=>{if(!await confirmRoleDraftDiscard(platformAdminPage))return;const selected=platformAdminPage.querySelector('[data-platform-list][aria-pressed="true"]')?.dataset.platformList||'companies';loadPlatformAdmin(selected).catch(error=>{platformAdminPage.querySelector('[data-platform-error]').textContent=message(error)})});
  if (companyAdminSection) {
    const content = adminPage.querySelector('.rm-company-admin-content');
    const sections = new Map();
    for (const [id,label,description] of [['team','Equipe e permissões','Pessoas, perfis e convites'],['drivers','Motoboys','Cadastros e vínculos operacionais'],['integrations','Integrações','Contas e estado das plataformas']]) {
      const section = document.createElement('section'); section.className='rm-admin-subpage'; section.dataset.adminSubpage=id; section.hidden=true; content.append(section); sections.set(id,section);
      const status=document.createElement('p');status.dataset.adminPageStatus=id;status.setAttribute('role','status');status.setAttribute('aria-live','polite');section.append(status);
    }
    const company = $('[data-company-setup]',companyAdminSection), recovery = $('[data-mfa-recovery-admin]',companyAdminSection), adminError = $('[data-admin-error]',companyAdminSection), adminRefresh = $('[data-refresh-admin]',companyAdminSection);
    const invite = $('[data-invite]',companyAdminSection), members = $('[data-members]',companyAdminSection), memberNote = $('[data-members-note]',companyAdminSection), roles = $('[data-roles-list]',companyAdminSection), createRole = $('[data-create-role]',companyAdminSection), driverNote = $('[data-driver-access-note]',companyAdminSection), integrations = $('[data-integrations]',companyAdminSection);
    const teamPage=sections.get('team');
    const teamIntro=document.createElement('div');teamIntro.className='rm-admin-team-intro';
    teamIntro.innerHTML='<p>Gerencie quem tem acesso a esta empresa, os convites e os perfis autorizados.</p><div class="rm-team-summary" aria-live="polite"><span data-team-member-count>Carregando integrantes…</span><span data-team-invite-count>Convites pendentes: —</span></div><p data-team-feedback role="status" aria-live="polite"></p>';
    teamPage.prepend(teamIntro);
    for (const node of [adminError,adminRefresh,recovery]) if(node) teamPage.append(node);

    const memberSection=members?.closest('section');
    if(memberSection){memberSection.classList.add('rm-team-section','rm-team-members-section');const heading=memberSection.querySelector('h3');if(heading)heading.textContent='Integrantes';teamPage.append(memberSection);}
    if(memberNote)teamPage.append(memberNote);

    const invitationSection=document.createElement('section');invitationSection.className='rm-team-section rm-team-invitations-section';
    const invitationHeader=document.createElement('div');invitationHeader.className='rm-team-section-heading';
    const invitationCopy=document.createElement('div');invitationCopy.className='rm-team-section-heading-copy';
    const invitationTitle=document.createElement('h3');invitationTitle.textContent='Convites';
    const invitationDescription=document.createElement('p');invitationDescription.textContent='Convites aguardando ativação. O envio depende do serviço de email configurado.';
    invitationCopy.append(invitationTitle,invitationDescription);invitationHeader.append(invitationCopy);
    const invitationList=document.createElement('div');invitationList.className='rm-team-invitation-list';invitationList.dataset.teamInvitations='';invitationList.setAttribute('aria-live','polite');
    invitationSection.append(invitationHeader,invitationList);
    if(invite){
      const dialog=window.RotaMotoAdminFormDialog.create({source:invite.closest('details'),form:invite,title:'Convidar pessoa',description:'Envie um convite para criar ou associar a conta pelo email. Para liberar entregas, vincule depois a conta ativa ao cadastro operacional correto do motoboy.',triggerLabel:'Convidar pessoa',submitButton:invite.querySelector('[type="submit"]')});
      if(dialog){dialog.trigger.classList.add('rm-team-section-action');dialog.trigger.remove();dialog.dialog.remove();invitationHeader.append(dialog.trigger);invitationSection.append(dialog.dialog);}
    }
    invitationSection.append(invitationList);teamPage.append(invitationSection);

    const roleSection=document.createElement('section');roleSection.className='rm-team-section rm-team-profiles-section';
    const roleHeader=document.createElement('div');roleHeader.className='rm-team-section-heading';
    const roleHeading=document.createElement('h3');roleHeading.textContent='Perfis e permissões';
    roleHeader.append(roleHeading);
    if(createRole){
      const dialog=window.RotaMotoAdminFormDialog.create({source:createRole.closest('details'),form:createRole,title:'Criar perfil',description:'Escolha um nome e somente as permissões que seu perfil pode delegar. O servidor valida e registra a alteração.',triggerLabel:'Criar perfil',submitButton:createRole.querySelector('[type="submit"]')});
      if(dialog){dialog.trigger.classList.add('rm-team-section-action');dialog.trigger.remove();dialog.dialog.remove();roleHeader.append(dialog.trigger);roleSection.append(dialog.dialog);}
    }
    if(roles){roles.classList.add('rm-team-role-list');roles.replaceChildren();roleSection.append(roleHeader,roles);teamPage.append(roleSection);}
    const driverMembers = document.createElement('div'); driverMembers.className='rm-driver-admin-list'; driverMembers.dataset.driverMembers=''; driverMembers.setAttribute('aria-live','polite');
    const driverIntro=document.createElement('p'); driverIntro.className='rm-driver-flow-note'; driverIntro.textContent='O cadastro operacional e a conta são registros diferentes. O vínculo conecta uma conta já ativa a um cadastro da empresa; disponibilidade é consultada separadamente.';
    const driverSummary=document.createElement('p');driverSummary.className='rm-driver-summary';driverSummary.dataset.driverSummary='';driverSummary.setAttribute('aria-live','polite');
    const driverFeedback=document.createElement('p');driverFeedback.className='rm-driver-feedback';driverFeedback.dataset.driverFeedback='';driverFeedback.setAttribute('role','status');driverFeedback.setAttribute('aria-live','polite');
    sections.get('drivers').append(driverIntro,driverSummary,driverFeedback,driverMembers);
    for (const node of [driverNote]) if(node) sections.get('drivers').append(node);
    if(integrations) sections.get('integrations').append(integrations);
    for(const form of adminPage.querySelectorAll('[data-company-setup],[data-invite],[data-create-role]')){form.setAttribute('aria-busy','true');const submit=adminSubmitButton(form);if(submit)submit.disabled=true;}
    companyAdminSection.remove();
    function showAdminPage(id) { if(!sections.has(id))return;for(const [key,section] of sections)section.hidden=key!==id;adminPage.dataset.activePage=id; }
    adminPage.showPage = showAdminPage;
    showAdminPage('team');
  }
  document.addEventListener('rotamoto:settings-page',event=>{const section=event.detail?.section;if(section==='platform-admin'&&current?.platformAdmin&&!mfaLocked){loadPlatformAdmin('companies').catch(error=>{platformAdminPage.querySelector('[data-platform-error]').textContent=message(error)});return}if(!section?.startsWith('company-admin-')||!current||mfaLocked||!current.permissions?.includes('company.manage'))return;const page=section.slice('company-admin-'.length),id=({team:'team',drivers:'drivers',integrations:'integrations'})[page];if(!id)return;adminPage.showPage?.(id);loadAdmin().catch(error=>showAdminLoadError(error));});
  const applicationRoot = () => document.querySelector('#app, .app');
  let mfaLocked = false;
  const appKind = document.currentScript?.dataset.app || 'restaurante';
  function updateTriggerLabel() {
    trigger.innerHTML = `<span class="rm-account-trigger-label">${offlineMode ? 'Dados locais' : 'Conta'}</span><svg class="rm-account-trigger-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/></svg>`;
    const opensAccountPage = Boolean(current && !mfaLocked);
    const triggerLabel = opensAccountPage ? 'Abrir Conta e segurança' : offlineMode ? 'Dados locais. Abrir opções da conta; sem sessão autenticada' : 'Abrir conta e acesso';
    trigger.setAttribute('aria-label', triggerLabel);
    trigger.setAttribute('aria-controls', opensAccountPage ? 'rmAccountSettingsPage' : 'rmIdentityPanel');
    trigger.title = opensAccountPage ? triggerLabel : offlineMode ? 'Modo local: sem sessão autenticada' : 'Abrir conta e acesso';
  }
  if (appKind !== 'restaurante') adminPage.remove();
  function message(error) { return codeMessages[error?.code] || (error?.network ? codeMessages.NETWORK : 'Não foi possível concluir. Revise os dados e tente novamente.'); }
  async function syncAfterAuthentication({ onAppReady } = {}) {
    if (mfaLocked) return;
    try {
      if (appKind === 'restaurante' && !window.RotaMotoAppReady) {
        const ready = await new Promise(resolve => window.addEventListener('rotamoto:app-ready', event => resolve(event.detail?.ok === true), { once: true }));
        if (!ready) return;
      }
      if (appKind === 'restaurante') onAppReady?.();
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
    if (method !== 'GET' && serverUpdateBus) {
      const topic = path.startsWith('/admin/company') ? 'company'
        : path.startsWith('/admin/integrations') || path.startsWith('/admin/marketplace') ? 'integrations'
          : path.startsWith('/admin/invitations') || path.startsWith('/admin/memberships') || path.startsWith('/admin/roles') ? 'team'
            : path.startsWith('/domain/drivers') ? 'drivers' : null;
      if (topic) serverUpdateBus.publish(topic);
    }
    return body;
  }
  function placeTrigger() {
    const app = document.querySelector('#app');
    const anchor = current || offlineMode ? app?.querySelector('.pilot-command-head .pilot-head-actions, .top-actions, .top') : null;
    const parent = anchor || host;
    if (trigger.parentElement !== parent) parent.append(trigger);
    trigger.classList.toggle('rm-account-trigger--inline', Boolean(anchor));
    const companyMount=app?.querySelector('#companyAdminSettingsMount');
    const platformMount=app?.querySelector('#platformAdminSettingsMount');
    const canManageCompany=Boolean(current&&appKind==='restaurante'&&!mfaLocked&&current.permissions?.includes('company.manage'));
    const canManagePlatform=Boolean(current&&appKind==='restaurante'&&!mfaLocked&&current.platformAdmin);
    if(companyMount&&canManageCompany){if(adminPage.parentElement!==companyMount)companyMount.append(adminPage);adminPage.hidden=false}
    else {adminPage.hidden=true;if(adminPage.parentElement!==host)host.append(adminPage)}
    if(platformMount&&canManagePlatform){if(platformAdminPage.parentElement!==platformMount)platformMount.append(platformAdminPage);platformAdminPage.hidden=false}
    else {platformAdminPage.hidden=true;if(platformAdminPage.parentElement!==host)host.append(platformAdminPage)}
  }
  const placementRoot = document.body;
  if (placementRoot && window.MutationObserver) {
    new MutationObserver(() => placeTrigger()).observe(placementRoot, { childList: true, subtree: true });
  }
  function visibleControls() {
    return [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[href],[tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.closest('[hidden]') && element.getClientRects().length > 0);
  }
  function setOpen(open, returnFocusTarget = null) {
    if (mfaLocked) open = true;
    if (open && panel.hidden) previousFocus = returnFocusTarget?.isConnected ? returnFocusTarget : document.activeElement;
    if (!open) clearMfaEnrollment();
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    const app = applicationRoot();
    const gated = host.dataset.gated === 'true';
    if (app) { app.inert = open || gated; app.setAttribute('aria-hidden', String(open || gated)); }
    if (open) {
      if (mfaLocked) openAccountPanel('mfa', { source: trigger, force: true });
      else (visibleControls()[0] || panel).focus();
    }
    else if (previousFocus?.isConnected && !panel.contains(previousFocus) && !previousFocus.closest('[inert]')) previousFocus.focus();
    else if (!gated) trigger.focus();
  }
  panel.tabIndex = -1;
  document.addEventListener('click', event => {
    const accountTrigger = event.target?.closest?.('[data-account-security]');
    if (!accountTrigger) return;
    event.preventDefault();
    if (current && !mfaLocked) {
      if (appKind === 'restaurante') document.dispatchEvent(new CustomEvent('rotamoto:open-account-settings'));
      else openAccountPageOverlay(accountTrigger);
      return;
    }
    setOpen(true, accountTrigger);
  });
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (mfaLocked) { event.preventDefault(); event.stopPropagation(); return; }
      if ((current || offlineMode) && !mfaLocked) { event.preventDefault(); setOpen(false); }
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
  function setRecoveryStep(step, moveFocus = true) {
    recoveryStep = ['recovery-menu', 'request-code', 'reset-password', 'recover-mfa'].includes(step) ? step : 'recovery-menu';
    const menu = $('[data-recovery-menu]');
    if (menu) menu.hidden = recoveryStep !== 'recovery-menu';
    for (const screen of panel.querySelectorAll('[data-recovery-screen]')) screen.hidden = screen.dataset.recoveryScreen !== recoveryStep;
    const title = $('[data-recovery-title]');
    const description = $('[data-recovery-description]');
    const copy = {
      'recovery-menu': ['Recuperar acesso', 'Escolha como deseja recuperar sua conta.'],
      'request-code': ['Solicitar código', 'Informe seu email para receber instruções de recuperação.'],
      'reset-password': ['Redefinir senha', 'Use o código recebido para criar uma nova senha.'],
      'recover-mfa': ['Perdi o autenticador', 'Inicie a recuperação segura da verificação em duas etapas.']
    }[recoveryStep];
    if (title) title.textContent = copy[0];
    if (description) description.textContent = copy[1];
    const back = $('[data-recovery-back]');
    const backLabel = $('[data-recovery-back-label]');
    if (back) back.setAttribute('aria-label', recoveryStep === 'recovery-menu' ? 'Voltar ao login' : 'Voltar às opções de recuperação');
    if (backLabel) backLabel.textContent = 'Voltar';
    const mfaRequest = $('[data-mfa-recovery-stage="request"]');
    const mfaConfirm = $('[data-mfa-recovery-stage="confirm"]');
    if (mfaRequest) mfaRequest.hidden = recoveryStep !== 'recover-mfa' || mfaRecoveryConfirmReady;
    if (mfaConfirm) mfaConfirm.hidden = recoveryStep !== 'recover-mfa' || !mfaRecoveryConfirmReady;
    if (moveFocus && recoveryStep !== 'recovery-menu') requestAnimationFrame(() => panel.querySelector(`[data-recovery-screen="${recoveryStep}"] input:not([disabled])`)?.focus());
    else if (moveFocus) requestAnimationFrame(() => title?.focus());
  }
  function setAuthView(view, moveFocus = true) {
    authView = ['login', 'recovery', 'invitation'].includes(view) ? view : 'login';
    const authenticated = Boolean(current);
    const login = $('[data-login]');
    const secondary = $('[data-login-secondary]');
    const privacy = $('[data-login-privacy]');
    if (login) login.hidden = authenticated || authView !== 'login';
    if (secondary) secondary.hidden = authenticated || authView !== 'login';
    if (privacy) privacy.hidden = authenticated || authView !== 'login';
    if (recoveryDetails) recoveryDetails.hidden = authView !== 'recovery' || (authenticated && !mfaLocked);
    const invitation = $('[data-invitation]');
    if (invitation) invitation.hidden = authView !== 'invitation' || authenticated || mfaLocked;
    if (authView === 'recovery') setRecoveryStep(recoveryStep, false);
    if (moveFocus) requestAnimationFrame(() => {
      const target = authView === 'login' ? $('[data-login] h2') : authView === 'recovery' ? $('[data-recovery-title]') : $('#rmInvitationTitle');
      target?.focus();
    });
  }
  function adminSubmitButton(form){return form.querySelector('[type="submit"]')||[...adminPage.querySelectorAll('button[form]')].find(button=>button.form===form)||null}
  function setBusy(form, busy) { form.setAttribute('aria-busy', String(busy)); form.querySelectorAll('button').forEach(button => { button.disabled = busy; }); if(form.id)document.querySelectorAll(`[form="${form.id}"]`).forEach(button=>{button.disabled=busy});const dialog=form.closest('dialog'); if(dialog)dialog.dataset.busy=String(busy); }
  function markAdminFormSaved(form){form.dataset.dialogDirty='';const dialog=form.closest('dialog');if(dialog?.open)dialog.close()}

  function clearSensitiveAccountState() {
    closeAccountDialog(true);
    showRecoveryCodesAfterEnrollment = false;
    passwordChangeForm?.reset();
    const replacementForm = $('[data-mfa-replace-verify]');
    if (replacementForm) { replacementForm.reset(); replacementForm.hidden = true; }
    const enrollmentForm = $('[data-mfa-confirm]');
    if (enrollmentForm) { enrollmentForm.reset(); enrollmentForm.hidden = true; }
    clearMfaEnrollment();
    const recoveryCodes = $('[data-recovery-codes]');
    if (recoveryCodes) { $('[data-recovery-code-list]').textContent = ''; recoveryCodes.hidden = true; }
  }

  function showSession(session) {
    if (!session) clearSensitiveAccountState();
    current = session;
    offlineMode = false;
    if (session) authView = 'login';
    if (!session) { linkedCompaniesRequestId += 1; linkedCompaniesLoad = null; linkedCompanies = []; requestedCompanySwitchId = ''; accountPageOverlayOpen = false; accountPage.classList.remove('rm-account-settings-page--overlay'); accountPage.removeAttribute('role'); accountPage.removeAttribute('aria-modal'); accountPage.removeAttribute('aria-labelledby'); closeAccountDialog(true); delete document.body.dataset.accountSettingsOpen; }
    $('[data-recovery]').hidden = Boolean(session);
    $('[data-invitation]').hidden = Boolean(session);
    const inviteForm = $('[data-invite]');
    const membersList = $('[data-members]');
    const membersNote = $('[data-members-note]');
    const canInvite = Boolean(session?.permissions?.includes('members.invite'));
    if (inviteForm) inviteForm.hidden = !canInvite;
    const inviteDialog=inviteForm?.closest('dialog');
    const inviteTrigger=inviteDialog?[...adminPage.querySelectorAll('button[aria-controls]')].find(button=>button.getAttribute('aria-controls')===inviteDialog.id):null;
    if (inviteTrigger instanceof HTMLButtonElement) inviteTrigger.hidden = !canInvite;
    if (membersList) membersList.hidden = !session?.permissions?.includes('members.read');
    if (membersNote) membersNote.hidden = Boolean(session?.permissions?.includes('members.read'));
    mfaLocked = Boolean(session && (session.mfaEnrollmentRequired || (session.mfaRequired && !session.mfaVerified)));
    if (!mfaLocked && !showRecoveryCodesAfterEnrollment && accountPage.classList.contains('rm-mfa-only')) closeAccountDialog(true);
    $('[data-login]').hidden = Boolean(session);
    if (accountPage) {
    const mfaGatePage = Boolean(mfaLocked || (showRecoveryCodesAfterEnrollment && accountPage.parentElement === panel));
      accountPage.classList.toggle('rm-mfa-only', mfaGatePage);
      if (mfaGatePage) { if (accountPage.parentElement !== panel) panel.append(accountPage); accountPage.hidden = false; }
      else if (appKind === 'motoboy') {
        if (accountPage.parentElement === panel) host.append(accountPage);
        accountPage.hidden = !accountPageOverlayOpen;
      } else {
        if (accountPage.parentElement === panel || !accountPage.isConnected) host.append(accountPage);
        accountPage.hidden = !(session && accountPage.closest('#main'));
      }
    }
    const appRoot = applicationRoot();
    if (appRoot) { const authorized = Boolean(session && !mfaLocked); appRoot.hidden = !authorized; appRoot.inert = !authorized; appRoot.setAttribute('aria-hidden', String(!authorized)); }
    window.dispatchEvent(new CustomEvent(session && !mfaLocked ? 'rotamoto:auth-ready' : 'rotamoto:auth-revoked'));
    document.body.dataset.mfaLocked = String(mfaLocked);
    host.dataset.mfaLocked = String(mfaLocked);
    host.dataset.gated = String(!session && !offlineMode);
    adminPage.hidden = true;
    platformAdminPage.hidden=true;
    $('[data-close]').hidden = !session || mfaLocked;
    $('[data-accept-existing]').hidden = mfaLocked;
    $('[data-switch]').hidden = true;
    setAuthView(authView, false);
    trigger.hidden = true;
    placeTrigger();
    updateTriggerLabel();
    if (session) {
      $('[data-user-email]').textContent = session.email;
      $('[data-company-id]').textContent = session.activeCompanyId;
      try { localStorage.setItem('rotaMoto.activeCompanyHint', session.activeCompanyId); } catch (_) {}
      $('[data-email-verification]').textContent=session.emailVerified?'Email confirmado':'Email ainda não confirmado';
      const companyLabel = typeof session.activeCompanyName === 'string' && session.activeCompanyName.trim() ? session.activeCompanyName.trim() : 'Empresa ativa';
      $('[data-company-name]').textContent = companyLabel;
      accountPage.querySelector('[data-account-mfa-summary]').textContent = session.mfaEnrollmentRequired ? 'Configuração pendente' : session.mfaConfigured ? 'Ativa' : 'Inativa';
      const mfaBox=$('[data-mfa]');mfaBox.hidden=false;
      $('[data-mfa-status]').textContent=session.mfaEnrollmentRequired?'Acesso limitado até confirmar o autenticador.':session.mfaConfigured?'Verificação em duas etapas configurada. A chave não pode ser consultada novamente.':'Ative a verificação em duas etapas para adicionar uma proteção à sua conta.';
      $('[data-mfa-start]').hidden=Boolean(session.mfaConfigured&&!session.mfaEnrollmentRequired);
      $('[data-mfa-replace]').hidden=!(session.mfaConfigured&&session.mfaVerified&&!session.mfaEnrollmentRequired);
      $('[data-mfa-regenerate]').hidden=!(session.mfaConfigured&&session.mfaVerified&&session.permissions?.includes('company.manage'));
      const recoveryButton=accountPage.querySelector('[data-account-open="recovery-codes"]');
      if (recoveryButton) { recoveryButton.disabled = $('[data-mfa-regenerate]').hidden; recoveryButton.title = recoveryButton.disabled ? 'Disponível após configurar a verificação em duas etapas e ter autorização para gerenciar os códigos.' : ''; }
      setStatus(mfaLocked?'Acesso bloqueado · configure e confirme a verificação em duas etapas':'Sessão ativa');
      $('[data-login-error]').textContent = '';
      if (!mfaLocked && !adminPage.hidden) loadAdmin().catch(error => { $('[data-admin-error]').textContent = message(error); });
    } else {
      setStatus(offlineMode ? 'Sem conta do servidor · dados deste aparelho' : navigator.onLine === false ? 'Sem conexão · usando dados deste aparelho' : 'Entre para acessar sua conta.');
    }
  }
  window.addEventListener('rotamoto:auth-revoked', () => {
    if (!accountPage.isConnected) { host.append(accountPage); accountPage.hidden = true; }
  });
  function expireSession() {
    if (!current) return;
    invalidateSessionReads();
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
      if (error.status !== 401 && hadAuthenticatedSession) {
        setStatus('Sem conexão para verificar a sessão. Os dados locais continuam disponíveis; ações do servidor serão retomadas quando houver conexão.');
        return current;
      }
      csrf = null; window.RotaMotoSessionGuard?.clearCsrfToken(); current = null; showSession(null);
      if (error.status === 401) {
        $('[data-login-error]').textContent = window.RotaMotoSessionGuard.sessionRestoreErrorMessage(error, hadAuthenticatedSession, message);
      }
      return null;
    }
  }
  function hintedCompany() { try { return localStorage.getItem('rotaMoto.activeCompanyHint') || ''; } catch (_) { return ''; } }
  function applyMailAction(){let params;try{params=new URLSearchParams(location.hash.slice(1))}catch(_){return}const action=params.get('action'),token=params.get('token');if(!token||token.length>43)return;if(action==='password_recovery'){$('[data-recovery-consume] [name=token]').value=token;setRecoveryStep('reset-password',false);setAuthView('recovery',false);setOpen(true)}else if(action==='mfa_recovery'){$('[data-mfa-recovery-confirm] [name=token]').value=token;mfaRecoveryConfirmReady=true;setRecoveryStep('recover-mfa',false);setAuthView('recovery',false);setOpen(true)}else if(['owner_invitation','membership_invitation'].includes(action)){invitationKind=action;$('[data-accept-invitation] [name=token]').value=token;setAuthView('invitation',false);setOpen(true)}if(action==='password_recovery'||action==='mfa_recovery'||['owner_invitation','membership_invitation'].includes(action))history.replaceState(null,'',location.pathname+location.search)}
  applyMailAction();
  $('[data-open-recovery]').addEventListener('click', event => { recoveryStep='recovery-menu'; mfaRecoveryConfirmReady=false; setRecoveryStep('recovery-menu',false); setAuthView('recovery'); });
  $('[data-open-invitation]').addEventListener('click', () => setAuthView('invitation'));
  host.querySelectorAll('[data-recovery-choice]').forEach(button => button.addEventListener('click', () => {
    const step = button.dataset.recoveryChoice;
    mfaRecoveryConfirmReady = step === 'recover-mfa' && Boolean($('[data-mfa-recovery-confirm] [name="token"]').value);
    setRecoveryStep(step);
  }));
  $('[data-recovery-back]').addEventListener('click', () => {
    if (recoveryStep !== 'recovery-menu') setRecoveryStep('recovery-menu');
    else setAuthView('login');
  });
  $('[data-invitation-back]').addEventListener('click', () => setAuthView('login'));
  $('[data-login] [name=companyId]').value = hintedCompany();
  $('[data-toggle-password]').addEventListener('click', event => {
    const button = event.currentTarget;
    const input = $('[data-login] [name=password]');
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
    button.innerHTML = visible
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.2 6.2C3.5 8 2 12 2 12s3.5 7 10 7a10 10 0 0 0 4-.8"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  });
  $('[data-password-change]').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget;
    // Background sync after login must not silently swallow this action.
    if(form.dataset.saving==='true')return;
    const newPassword=form.elements.newPassword.value;
    const confirmation=form.elements.confirmPassword;
    confirmation.setCustomValidity(confirmation.value===newPassword?'':'As duas novas senhas precisam ser iguais.');
    if(!form.reportValidity())return;
    confirmation.setCustomValidity('');
    form.dataset.saving='true';setBusy(form,true);
    const feedback=$('[data-password-change-status]');feedback.textContent='';
    try{
      const result=await request('/identity/password/change',{method:'POST',body:JSON.stringify({currentPassword:form.elements.currentPassword.value,newPassword})});
      if(result?.changed!==true)throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});
      form.reset();feedback.textContent='Senha atualizada. As outras sessões foram encerradas.';
    }catch(error){feedback.textContent=message(error)}
    finally{delete form.dataset.saving;setBusy(form,false)}
  });
  function clearMfaEnrollment(){const canvas=mfaQrCanvas;canvas?.getContext('2d')?.clearRect(0,0,canvas.width,canvas.height);if(canvas)canvas.hidden=true;if(mfaSecretInput)mfaSecretInput.value=''}
  function renderMfaQr(uri){const canvas=$('[data-mfa-qr]'),context=canvas?.getContext('2d'),encoder=window.RotaMotoQRCode;
    if(!canvas||!context||typeof encoder!=='function')throw new Error('QR local indisponível. Use a chave manual.');
    const code=new encoder(0,window.RotaMotoQRErrorCorrectLevel?.M??0);code.addData(uri);code.make();
    const modules=code.getModuleCount(),scale=Math.floor(canvas.width/(modules+8)),offset=Math.floor((canvas.width-modules*scale)/2);
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.fillStyle='#111';
    for(let row=0;row<modules;row++)for(let column=0;column<modules;column++)if(code.isDark(row,column))context.fillRect(offset+column*scale,offset+row*scale,scale,scale);
  }
  async function startMfaEnrollment(button, credentials = {}) {
    const feedback=$('[data-mfa-start-status]');
    if(mfaStarting)return false;
    mfaStarting=true;
    host.querySelectorAll('[data-mfa-start],[data-mfa-replace]').forEach(control=>{control.disabled=true;control.setAttribute('aria-busy','true')});
    feedback.textContent='';$('[data-mfa-error]').textContent='';$('[data-mfa-status]').textContent='Preparando a configuração…';
    try{
      const result=await request('/identity/mfa/enrollment',{method:'POST',body:JSON.stringify(credentials)});
      let enrollmentUri;
      try { enrollmentUri = new URL(result?.otpauthUri); } catch (_) { throw Object.assign(new Error(),{code:'MFA_ENROLLMENT_INVALID_RESPONSE'}); }
      if(typeof result?.secret!=='string'||! /^[A-Z2-7]{16,128}$/u.test(result.secret)||enrollmentUri.protocol!=='otpauth:'||enrollmentUri.hostname!=='totp'||!enrollmentUri.pathname.slice(1)||enrollmentUri.searchParams.get('secret')!==result.secret)
        throw Object.assign(new Error('Resposta de configuração inválida.'),{code:'MFA_ENROLLMENT_INVALID_RESPONSE'});
      $('[data-mfa-secret]').value=result.secret;
      $('[data-mfa-start]').hidden=true;$('[data-mfa-replace]').hidden=true;$('[data-mfa-replace-verify]').hidden=true;
      const form=$('[data-mfa-confirm]');form.hidden=false;
      syncAccountDialogActions();
      try{
        const canvas=$('[data-mfa-qr]');canvas.hidden=false;renderMfaQr(result.otpauthUri);
        $('[data-mfa-status]').textContent='Escaneie o QR Code ou use a nova chave manual. Confirme com o código do autenticador novo.';
      }catch(_){
        $('[data-mfa-qr]').hidden=true;
        $('[data-mfa-status]').textContent='O QR Code não pôde ser exibido neste aparelho. Use a nova chave manual abaixo e confirme com o código atual.';
        feedback.textContent='QR Code indisponível; a chave manual continua disponível.';
      }
      form.querySelector('[name=code]').focus();
      return true;
    }catch(error){
      feedback.textContent=error?.code==='MFA_ENROLLMENT_INVALID_RESPONSE'?'O servidor respondeu de forma inesperada. Atualize a página e tente novamente.':message(error);
      $('[data-mfa-status]').textContent='Não foi possível iniciar a verificação em duas etapas.';
      return false;
    }finally{mfaStarting=false;host.querySelectorAll('[data-mfa-start],[data-mfa-replace]').forEach(control=>{control.disabled=false;control.removeAttribute('aria-busy')})}
  }
  $('[data-mfa-start]').addEventListener('click',event=>startMfaEnrollment(event.currentTarget));
  $('[data-mfa-replace]').addEventListener('click',()=>{const form=$('[data-mfa-replace-verify]');form.hidden=false;$('[data-mfa-start]').hidden=true;$('[data-mfa-replace]').hidden=true;$('[data-mfa-replace-status]').textContent='';syncAccountDialogActions();form.elements.currentPassword.focus()});
  $('[data-mfa-replace-cancel]').addEventListener('click',()=>{const form=$('[data-mfa-replace-verify]');form.reset();form.hidden=true;$('[data-mfa-start]').hidden=Boolean(current?.mfaConfigured&&!current?.mfaEnrollmentRequired);$('[data-mfa-replace]').hidden=!(current?.mfaConfigured&&current?.mfaVerified&&!current?.mfaEnrollmentRequired);$('[data-mfa-replace-status]').textContent='';syncAccountDialogActions()});
  $('[data-mfa-replace-verify]').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;if(mfaStarting||form.dataset.saving==='true'||!form.reportValidity())return;const button=form.querySelector('[type=submit]');form.dataset.saving='true';setBusy(form,true);$('[data-mfa-replace-status]').textContent='';try{const started=await startMfaEnrollment(button,{currentPassword:form.elements.currentPassword.value,currentMfaCode:form.elements.currentMfaCode.value});if(started){form.reset();form.hidden=true}else $('[data-mfa-replace-status]').textContent=$('[data-mfa-start-status]').textContent}finally{delete form.dataset.saving;setBusy(form,false)}});
  $('[data-mfa-cancel]').addEventListener('click',async event=>{const button=event.currentTarget;if(mfaStarting||button.disabled)return;mfaStarting=true;button.disabled=true;try{const result=await request('/identity/mfa/enrollment/cancel',{method:'POST',body:'{}'});if(result.cancelled!==true&&result.cancelled!==false)throw Object.assign(new Error(),{code:'MFA_ENROLLMENT_INVALID_RESPONSE'});invalidateSessionReads();clearMfaEnrollment();$('[data-mfa-confirm]').reset();$('[data-mfa-confirm]').hidden=true;$('[data-mfa-start-status]').textContent='';await restore();$('[data-mfa-status]').textContent=result.cancelled?(current?.mfaConfigured?'Configuração cancelada. O autenticador atual continua ativo.':'Configuração cancelada.'):'Não havia uma configuração pendente para cancelar.';syncAccountDialogActions()}catch(error){$('[data-mfa-start-status]').textContent=message(error)}finally{mfaStarting=false;button.disabled=false}});
  $('[data-mfa-confirm]').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity()||form.dataset.saving==='true')return;form.dataset.saving='true';setBusy(form,true);try{const result=await request('/identity/mfa/enrollment/confirm',{method:'POST',body:JSON.stringify({code:form.elements.code.value})});if(!Array.isArray(result?.recoveryCodes)||result.recoveryCodes.some(code=>typeof code!=='string'||!code))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});invalidateSessionReads();clearMfaEnrollment();form.hidden=true;$('[data-recovery-code-list]').textContent=result.recoveryCodes.join('\n');$('[data-recovery-codes]').hidden=false;showRecoveryCodesAfterEnrollment=true;await restore();setAccountMfaView('codes');openAccountPanel('recovery-codes',{force:true,source:accountDialogReturnFocus});$('[data-mfa-status]').textContent='Verificação em duas etapas confirmada. Guarde os novos códigos; eles não poderão ser consultados novamente.'}catch(error){form.elements.code.value='';$('[data-mfa-error]').textContent=message(error)}finally{delete form.dataset.saving;setBusy(form,false)}});
  $('[data-recovery-codes-dismiss]').addEventListener('click',()=>{$('[data-recovery-code-list]').textContent='';$('[data-recovery-codes]').hidden=true;if(showRecoveryCodesAfterEnrollment){showRecoveryCodesAfterEnrollment=false;closeAccountDialog(true);accountPage.classList.remove('rm-mfa-only');if(accountPage.parentElement===panel){host.append(accountPage);accountPage.hidden=true;setOpen(false)}void syncAfterAuthentication()}else closeAccountDialog(true)});
  document.addEventListener('rotamoto:settings-page', event => {
    if (event.detail?.section === 'seguranca') { if (!current || mfaLocked) return; const mount=document.querySelector('#rmAccountSettingsMount'); if(mount && mount.closest('#main')){ mount.append(accountPage); accountPage.hidden=false; } panel.hidden=true; return; }
    if (mfaLocked) return;
    host.append(accountPage);
    accountPage.hidden=true;
  });
  $('[data-copy-company-id]').addEventListener('click',async event=>{try{await navigator.clipboard.writeText(current?.activeCompanyId||'');event.currentTarget.textContent='Copiado';setTimeout(()=>{event.currentTarget.textContent='Copiar'},1600)}catch(_){$('[data-account-error]').textContent='Não foi possível copiar o identificador neste navegador.'}});
  $('[data-close]').addEventListener('click', () => { if (current || offlineMode) setOpen(false); });
  $('[data-login]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    invalidateSessionReads();
    working = true; setBusy(form, true); $('[data-login-error]').textContent = ''; setStatus('Autenticando…');
    const data = new FormData(form); const password = data.get('password');
    try {
      const body = { email: String(data.get('email')).trim(), password: String(password), ...(data.get('companyId') ? { companyId: String(data.get('companyId')).trim() } : {}), ...(data.get('mfaCode') ? { mfaCode: String(data.get('mfaCode')).trim() } : {}) };
      const result = await request('/identity/login', { method: 'POST', body: JSON.stringify(body) });
      invalidateSessionReads();
      csrf = result.csrfToken; window.RotaMotoSessionGuard?.setCsrfToken(csrf); form.elements.password.value = ''; form.elements.mfaCode.value = ''; $('[data-mfa-label]').hidden = true;
      const session = await restore();
      if (!session) throw Object.assign(new Error(), { code: 'UNAUTHENTICATED' });
      if(session.mfaEnrollmentRequired){setOpen(true);$('[data-mfa-start]').focus()}else{await syncAfterAuthentication({onAppReady:()=>setOpen(false)})}
    } catch (error) { if (error.code === 'MFA_REQUIRED') { $('[data-mfa-label]').hidden = false; form.elements.mfaCode.focus(); } else { form.elements.password.value = ''; form.elements.mfaCode.value = ''; $('[data-mfa-label]').hidden = true; } $('[data-login-error]').textContent = message(error); setStatus('Não foi possível autenticar'); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-switch]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (form.dataset.saving === 'true' || !form.reportValidity()) return;
    const selected = linkedCompanies.find(company => company.companyId === form.elements.companyId.value && company.canSwitch && !company.isActive);
    if (!selected) { $('[data-switch-error]').textContent = 'Selecione uma empresa ativa vinculada a esta conta.'; return; }
    linkedCompaniesRequestId += 1; linkedCompaniesLoad = null;
    invalidateSessionReads();
    form.dataset.saving = 'true'; setBusy(form, true); $('[data-switch-error]').textContent = '';
    try { await request('/identity/tenant', { method: 'POST', body: JSON.stringify({ companyId: selected.companyId }) }); invalidateSessionReads(); await restore(); await syncAfterAuthentication(); closeAccountDialog(true); requestedCompanySwitchId = ''; }
    catch (error) { $('[data-switch-error]').textContent = message(error); }
    finally { delete form.dataset.saving; setBusy(form, false); }
  });
  $('[data-logout]').addEventListener('click', async () => {
    const button = $('[data-logout]'); if (button.dataset.saving === 'true') return; button.dataset.saving = 'true'; button.disabled = true;
    invalidateSessionReads();
    try { await request('/identity/logout', { method: 'POST', body: '{}' }); invalidateSessionReads(); csrf = null; current = null; showSession(null); setOpen(true); Promise.resolve(window.RotaMotoSync?.clearSession?.()).catch(() => {}).finally(() => { if (!current) setOpen(true); }); }
    catch (error) { const feedback = $('[data-account-error]'); if (feedback) feedback.textContent = message(error); }
    finally { delete button.dataset.saving; button.disabled = false; if (!current) { panel.hidden = false; setOpen(true); } }
  });
  $('[data-recovery-request]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    working = true; const email = form.elements.email.value.trim(); setBusy(form, true);
    try { await request('/identity/recovery', { method: 'POST', body: JSON.stringify({ email }) }); $('[data-recovery-status]').textContent = 'Se a conta puder ser recuperada, as instruções serão entregues ao email cadastrado.'; }
    catch (error) { $('[data-recovery-status]').textContent = message(error); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-mfa-recovery-request]').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget;if(working||!form.reportValidity())return;working=true;setBusy(form,true);
    try{await request('/identity/mfa/recovery/request',{method:'POST',body:JSON.stringify({email:form.elements.email.value.trim(),password:form.elements.password.value,companyId:form.elements.companyId.value.trim()})});form.elements.password.value='';$('[data-mfa-recovery-status]').textContent='Se a conta estiver elegível, as instruções serão enviadas ao email verificado.'}
    catch(error){$('[data-mfa-recovery-status]').textContent=message(error)}finally{working=false;setBusy(form,false)}
  });
  $('[data-mfa-recovery-confirm]').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget;if(working||!form.reportValidity())return;working=true;setBusy(form,true);
    try{const result=await request('/identity/mfa/recovery/confirm',{method:'POST',body:JSON.stringify({token:form.elements.token.value.trim()})});form.reset();$('[data-mfa-recovery-confirm-status]').textContent=`Identidade confirmada. Solicitação ${result.requestId} aguarda outro administrador com MFA; proprietário único depende do operador local.`}
    catch(error){$('[data-mfa-recovery-confirm-status]').textContent=message(error)}finally{working=false;setBusy(form,false)}
  });
  $('[data-recovery-consume]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    working = true; setBusy(form, true); const password = form.elements.password.value;
    try { await request('/identity/recovery/consume', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim(), password }) }); form.reset(); $('[data-recovery-result]').textContent = 'Senha alterada. Entre novamente.'; }
    catch (error) { form.elements.password.value = ''; $('[data-recovery-result]').textContent = message(error); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-accept-invitation]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (working || !form.reportValidity()) return;
    working = true; setBusy(form, true); const password = form.elements.password.value;
    try { const result = await request(invitationKind==='owner_invitation'?'/identity/invitations/accept':'/identity/membership-invitations/accept', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim(), password }) });
      form.reset(); try { localStorage.setItem('rotaMoto.activeCompanyHint', result.companyId); } catch (_) {} $('[data-invitation-result]').textContent = 'Convite aceito. Agora entre com seu email e senha.'; $('[data-login] [name=companyId]').value = result.companyId; }
    catch (error) { form.elements.password.value = ''; $('[data-invitation-result]').textContent = message(error); }
    finally { working = false; setBusy(form, false); }
  });
  $('[data-accept-existing]').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; if (form.dataset.accepting === 'true' || !form.reportValidity()) return; form.dataset.accepting='true'; setBusy(form, true);
    try { const result = await request('/identity/membership-invitations/accept-authenticated', { method: 'POST', body: JSON.stringify({ token: form.elements.token.value.trim() }) });
      linkedCompaniesRequestId += 1; linkedCompaniesLoad = null; linkedCompanies = [];
      form.reset(); $('[data-existing-invitation-result]').textContent = 'Convite aceito. Confirme a troca para ativar o vínculo autorizado.'; requestedCompanySwitchId = result.companyId; openAccountPanel('companies',{source:accountPage.querySelector('[data-account-open="invitation"]')}); }
    catch (error) { $('[data-existing-invitation-result]').textContent = message(error); } finally { delete form.dataset.accepting; setBusy(form, false); }
  });
  function appendPermissionOptions(container, permissions, selectedKeys = [], actorPermissions = [], { readOnly = false } = {}) {
    const groups = new Map();
    const groupNames = { company: 'Empresa', members: 'Equipe', orders: 'Pedidos', deliveries: 'Entregas', delivery: 'Entregas', driver: 'Entregas', integrations: 'Integrações', sync: 'Sincronização', finance: 'Financeiro', backup: 'Cópias e recuperação', identity: 'Identidade e segurança' };
    const descriptions = { 'sync.pull': 'Consultar alterações autorizadas desta empresa.', 'sync.push': 'Enviar alterações autorizadas deste dispositivo para a empresa.',
      'finance.read': 'Consultar relatórios e registros financeiros da empresa.', 'finance.manage': 'Gerenciar operações financeiras da empresa.' };
    for (const permission of permissions) {
      const key = String(permission.key || '');
      const category = key.split('.', 1)[0] || 'other';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category).push(permission);
    }
    for (const [category, entries] of groups) {
      const fieldset = document.createElement('fieldset');
      fieldset.className = 'rm-permission-group';
      const legend = document.createElement('legend');
      legend.textContent = groupNames[category] || 'Outros acessos';
      fieldset.append(legend);
      const options = document.createElement('div');
      options.className = 'rm-role-permissions';
      for (const permission of entries) {
        const label = document.createElement('label');
        label.className = 'rm-permission-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = permission.key;
        input.checked = selectedKeys.includes(permission.key);
        input.dataset.permissionKey = permission.key;
        const delegable = actorPermissions.includes(permission.key);
        input.disabled = readOnly || !delegable;
        const description = descriptions[permission.key] || String(permission.description || '').trim() || 'Permissão específica da empresa';
        const copy = document.createElement('span');
        copy.className = 'rm-permission-copy';
        const detail = document.createElement('span');
        detail.textContent = description;
        const state = document.createElement('small');
        state.className = 'rm-permission-state';
        state.textContent = input.checked ? 'Concedida neste perfil' : delegable ? 'Não concedida' : 'Não delegável pelo seu perfil';
        label.classList.toggle('is-not-delegable', !delegable || readOnly);
        copy.append(detail, state);
        label.append(input, copy);
        options.append(label);
      }
      fieldset.append(options);
      container.append(fieldset);
    }
    const scopeNote = document.createElement('p');
    scopeNote.className = 'rm-permission-scope-note';
    scopeNote.textContent = 'Super ADM Global é um acesso da plataforma, fora das permissões desta empresa; não pode ser concedido por este editor.';
    container.append(scopeNote);
  }

  let adminLoadGeneration=0;
  let adminReady=false;
  function showAdminLoadError(error){const text=message(error),status=adminPage.querySelector('[data-admin-page-status="'+(adminPage.dataset.activePage||'team')+'"]');const pageError=error?.status===401?'Sua sessão expirou. Entre novamente.':error?.status===403?'Seu perfil não tem acesso a esta informação.':text;if(status)status.textContent=pageError;const errorBox=adminPage.querySelector('[data-admin-error]');if(errorBox)errorBox.textContent=pageError;}
  function loadAdmin(options={}){const generation=++adminLoadGeneration;adminReady=false;for(const form of adminPage.querySelectorAll('[data-company-setup],[data-invite],[data-create-role]')){form.setAttribute('aria-busy','true');const submit=adminSubmitButton(form);if(submit)submit.disabled=true;}return loadAdminData(options).then(result=>{if(generation===adminLoadGeneration)adminReady=true;return result}).catch(error=>{if(generation===adminLoadGeneration){adminReady=false;showAdminLoadError(error)}throw error}).finally(()=>{if(generation!==adminLoadGeneration)return;for(const form of adminPage.querySelectorAll('[data-company-setup],[data-invite],[data-create-role]')){form.removeAttribute('aria-busy');const submit=adminSubmitButton(form);if(submit)submit.disabled=!adminReady;}});}
  async function loadAdminData({ appendDrivers = false } = {}) {
    const generation=adminLoadGeneration;
    const loadStatus=adminPage.querySelector('[data-admin-page-status="'+(adminPage.dataset.activePage||'team')+'"]');
    if(loadStatus)loadStatus.textContent='Carregando dados do servidor…';
    const canReadMembers = current.permissions.includes('members.read');
    const canReadDrivers = current.permissions.includes('sync.pull');
    const [company, members, roles, permissionResult, integrations] = await Promise.all([
      request('/admin/company'), canReadMembers ? request('/admin/memberships?limit=100') : Promise.resolve({ members: [] }), request('/admin/roles'), request('/admin/permissions'),
      current.permissions.includes('integrations.manage') ? request('/admin/integrations') : Promise.resolve(null)
    ]);
    if(generation!==adminLoadGeneration)return;
    const marketplaceOrders = marketplaceOrderCache;
    const driverPage = canReadDrivers ? await request(`/domain/drivers?limit=100${appendDrivers && driverCursor ? `&cursor=${encodeURIComponent(driverCursor)}` : ''}`) : { records: [], nextCursor: null };
    if(generation!==adminLoadGeneration)return;
    $('[data-admin-error]').textContent='';
    if(loadStatus)loadStatus.textContent='Dados carregados do servidor.';
    if (!appendDrivers) driverRows = [];
    driverRows.push(...driverPage.records);
    driverCursor = driverPage.nextCursor;
    let availabilityByDriver = new Map();
    let availabilityReadFailed = false;
    if (canReadDrivers) {
      try {
        const availability = await request('/driver-availability');
        if (!availability || !Array.isArray(availability.records) || availability.records.some(row =>
          !row || typeof row.driverId !== 'string' || !['online','offline'].includes(row.effectiveStatus))) {
          throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
        }
        availabilityByDriver = new Map(availability.records.map(row => [row.driverId, row]));
      } catch (_) {
        // Availability is a separate live signal; a missing/expired lease must
        // never hide canonical Driver records or identity links.
        availabilityReadFailed = true;
      }
    }
    if(generation!==adminLoadGeneration)return;
    companySnapshot = company;
    $('[data-driver-access-note]').hidden = canReadDrivers;
    const companyForm=$('[data-company-setup]');
    if(companyForm&&!companyForm.dataset.dirty){companyForm.elements.name.value=company.name||'';companyForm.elements.supportPhone.value=company.supportPhone||'';companyForm.elements.timeZone.value=company.timeZone||'America/Sao_Paulo';companyForm.elements.address.value=company.operationalLocation?.address||'';companyForm.dataset.loaded='true'}
    const integrationBox = $('[data-integrations]'); integrationBox.hidden = false;
    if(!integrations){const list=integrationBox.querySelector('div');if(list)list.textContent='Seu perfil não tem permissão para consultar as integrações desta empresa.';}
    if (integrations) { const list = integrationBox.querySelector('div'); list.replaceChildren(); const providerNav=document.createElement('nav');providerNav.className='rm-provider-nav';providerNav.setAttribute('aria-label','Plataformas e pedidos');const providerPages=document.createElement('div');providerPages.className='rm-provider-pages';let firstProvider=true;const providerPageByCode=new Map(); integrations.integrations.forEach(item => {
      const providerCode=String(item.provider||'').toLowerCase(),providerTitle=item.displayName||({ifood:'iFood','99food':'99Food',keeta:'Keeta'}[providerCode]||'Integração');
      const providerPage=document.createElement('section');providerPage.className='rm-provider-page';providerPage.dataset.providerPage=providerCode;providerPage.hidden=!firstProvider;providerPageByCode.set(providerCode,providerPage);
      const providerTab=document.createElement('button');providerTab.type='button';providerTab.className='rm-provider-tab';providerTab.dataset.providerTab=providerCode;providerTab.setAttribute('aria-pressed',String(firstProvider));providerTab.textContent=`${providerTitle} · ${item.connectionVerified?'conexão confirmada':'sem conexão confirmada'}`;providerTab.setAttribute('aria-label',`${providerTitle}: ${item.connectionVerified?'conexão confirmada':'sem conexão confirmada'}`);providerTab.addEventListener('click',()=>{providerPages.querySelectorAll('[data-provider-page]').forEach(section=>section.hidden=section.dataset.providerPage!==providerCode);providerNav.querySelectorAll('[data-provider-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.providerTab===providerCode)))});providerNav.append(providerTab);firstProvider=false;
      const row = document.createElement('section'); row.className = 'rm-integration-status';
      const title = document.createElement('strong'); title.textContent = `${providerTitle} · ${item.connectionVerified ? 'conexão confirmada' : 'sem conexão confirmada'}`; row.append(title);
      const refreshProvider=document.createElement('button');refreshProvider.type='button';refreshProvider.textContent='Atualizar situação no RotaMoto';const providerFeedback=document.createElement('p');providerFeedback.setAttribute('role','status');providerFeedback.setAttribute('aria-live','polite');refreshProvider.addEventListener('click',async()=>{refreshProvider.disabled=true;refreshProvider.setAttribute('aria-busy','true');providerFeedback.textContent='Consultando estado registrado…';try{await loadAdmin();const refreshedPage=adminPage.querySelector(`[data-provider-page="${providerCode}"]`);if(refreshedPage){adminPage.querySelectorAll('[data-provider-page]').forEach(section=>section.hidden=section.dataset.providerPage!==providerCode);refreshedPage.hidden=false;adminPage.querySelectorAll('[data-provider-tab]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.providerTab===providerCode)));const freshStatus=document.createElement('p');freshStatus.setAttribute('role','status');freshStatus.setAttribute('aria-live','polite');freshStatus.textContent='Estado registrado atualizado. Isso não confirma conexão com a plataforma.';refreshedPage.querySelector('.rm-integration-status')?.append(freshStatus)}else throw new Error('INTEGRATION_STATUS_UNAVAILABLE')}catch(error){const freshPage=adminPage.querySelector(`[data-provider-page="${providerCode}"]`);const freshStatus=document.createElement('p');freshStatus.setAttribute('role','alert');freshStatus.textContent=message(error);freshPage?.querySelector('.rm-integration-status')?.append(freshStatus)}finally{const freshButton=adminPage.querySelector(`[data-provider-page="${providerCode}"] .rm-integration-status button`);if(freshButton){freshButton.disabled=false;freshButton.removeAttribute('aria-busy')}}});refreshProvider.dataset.providerRefresh=providerCode;row.append(refreshProvider,providerFeedback);
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
        if(accountRow.accountStatus==='active'&&accountRow.id){const disable=document.createElement('button');disable.type='button';disable.textContent='Desconectar no RotaMoto';
          disable.addEventListener('click',async()=>{const confirmation=await window.RotaMotoDialog.confirm({title:'Desconectar loja?',message:'O recebimento de pedidos será interrompido. Esta ação não revoga a autorização no portal da plataforma.',danger:true,confirmLabel:'Desconectar'});if(!confirmation?.confirmed)return;disable.disabled=true;try{await request(`/admin/integrations/${encodeURIComponent(item.provider)}/accounts/${encodeURIComponent(accountRow.id)}/disable`,{method:'POST',body:'{}'});await loadAdmin();}
            catch(error){disable.disabled=false;const issue=document.createElement('p');issue.setAttribute('role','status');issue.textContent=message(error);account.append(issue);}});account.append(disable);}
        accounts.append(account);
      });
      if (['ifood','keeta','99food'].includes(item.provider)) {
        const actionArea=document.createElement('div');actionArea.className='rm-integration-action';actionArea.setAttribute('aria-live','polite');
        const connect = document.createElement('button'); connect.type = 'button';
        connect.textContent = item.provider==='99food'?'Vincular loja':accountRows.some(account => ['disabled','revoked','reauthorization_required','error'].includes(account.accountStatus)) ? 'Reautorizar conta' : 'Conectar conta';
        connect.addEventListener('click', async () => {
          connect.disabled = true;
          actionArea.replaceChildren();
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
              actionArea.replaceChildren(form);connect.textContent='Vincular outra loja';connect.disabled=false;return;
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
            instructions.append(text, link, form); actionArea.replaceChildren(instructions); connect.textContent = 'Autorização iniciada';
          } catch (error) { const note = document.createElement('p'); note.setAttribute('role','status'); note.textContent = message(error); actionArea.replaceChildren(note); connect.disabled = false; }
        });
        row.append(connect,actionArea);
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
      const technicalDetails=document.createElement('details');technicalDetails.className='rm-integration-technical';const technicalSummary=document.createElement('summary');technicalSummary.textContent='Detalhes técnicos';technicalDetails.append(technicalSummary,capabilities);row.append(technicalDetails);
      const syncState = item.lastEventAt ? new Date(item.lastEventAt).toLocaleString() : 'ainda não há atualização registrada';
      const notes = document.createElement('p'); notes.textContent = `${item.capabilityNotes || 'A conexão ainda não está ativa.'} Última atualização: ${syncState}.`; row.append(notes);
      providerPage.append(row);providerPages.append(providerPage);
    });
      for(const providerPage of providerPageByCode.values()){
        const orderHeading=document.createElement('h3');orderHeading.textContent='Pedidos recebidos';providerPage.append(orderHeading);
        if(current.permissions.includes('orders.read')){const refreshOrders=document.createElement('button');refreshOrders.type='button';refreshOrders.textContent=marketplaceOrders.loaded?'Atualizar pedidos':'Consultar pedidos';refreshOrders.addEventListener('click',async()=>{refreshOrders.disabled=true;refreshOrders.setAttribute('aria-busy','true');let feedback=providerPage.querySelector('[data-marketplace-orders-feedback]');if(!feedback){feedback=document.createElement('p');feedback.dataset.marketplaceOrdersFeedback='';feedback.setAttribute('role','status');providerPage.append(feedback)}feedback.textContent='Consultando os pedidos no servidor…';try{marketplaceOrderCache={...await request('/admin/marketplace/orders?limit=50'),loaded:true,error:null};await loadAdmin()}catch(error){marketplaceOrderCache={orders:[],loaded:false,error:error.code||'MARKETPLACE_ADMIN_FAILED'};feedback.textContent=message(error)}finally{refreshOrders.disabled=false;refreshOrders.removeAttribute('aria-busy')}});providerPage.append(refreshOrders)}
      }
      if(marketplaceOrders.error){const errorNote=document.createElement('p');errorNote.setAttribute('role','status');errorNote.textContent=marketplaceOrders.error==='MARKETPLACE_RUNTIME_UNAVAILABLE'?'A conexão de pedidos desta plataforma não está configurada neste servidor.':`Não foi possível consultar pedidos (${marketplaceOrders.error}).`;providerPages.append(errorNote)}
      const orderRows=Array.isArray(marketplaceOrders.orders)?marketplaceOrders.orders:[];
      const commandStates={queued:'Na fila',leased:'Em execução',pending:'Aguardando confirmação da plataforma',succeeded:'Confirmada pela plataforma',rejected:'Falhou',unknown_outcome:'Resultado incerto; reconciliação pendente',needs_review:'Precisa de revisão'};
      const operationLabels={CONFIRM:'Confirmação do pedido',START_PREPARATION:'Início do preparo',READY:'Pedido marcado como pronto',DELIVERED:'Entrega própria concluída',CONFIRM_CASH_PAYMENT:'Recebimento em dinheiro',DISPATCH_MERCHANT:'Despacho para entrega própria',CANCEL_ORDER:'Solicitação de cancelamento',CANCEL_REQUEST:'Resposta ao cancelamento',REFUND_REQUEST:'Resposta ao reembolso',SHIPPING_QUOTE:'Cotação de entrega',SHIPPING_REQUEST:'Solicitação de entrega',SHIPPING_CANCEL:'Cancelamento da entrega',SHIPPING_TRACKING:'Consulta de rastreamento'};
      orderRows.forEach(order=>{
        const item=document.createElement('article');item.className='rm-marketplace-order';
        const providerName={ifood:'iFood',keeta:'Keeta','99food':'99Food'}[order.provider]||'Plataforma';
        const title=document.createElement('strong');title.textContent=`${providerName} · ${order.displayId||order.domainOrderId} · ${order.providerStatus||'estado indisponível'}`;item.append(title);
        const status=document.createElement('p');status.textContent=order.commandStatus?`${operationLabels[order.lastOperation]||'Última atualização'}: ${commandStates[order.commandStatus]||'estado não reconhecido'}`:'Nenhum comando enviado.';item.append(status);
        if(order.lastErrorCode){const errorNote=document.createElement('p');errorNote.setAttribute('role','status');errorNote.textContent='A atualização não foi concluída. Tente novamente ou peça ajuda ao suporte da empresa.';item.append(errorNote);if(/^[A-Z0-9_]{1,80}$/u.test(String(order.lastErrorCode))){const technical=document.createElement('details');technical.className='rm-integration-technical';const summary=document.createElement('summary');summary.textContent='Código para suporte';const code=document.createElement('code');code.textContent=order.lastErrorCode;technical.append(summary,code);item.append(technical)}}
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
            if(operation==='CONFIRM'&&order.provider==='keeta'){const code=await window.RotaMotoDialog.prompt({title:'Confirmar pedido Keeta',message:'Informe o código do pedido exigido pela plataforma.',fieldLabel:'Código do pedido',maxLength:120,validate:value=>value.trim()?true:'Informe o código do pedido.'});if(!code)return;commandData.orderExternalCode=code;}
            if(operation==='CANCEL_ORDER'&&order.provider==='99food'){
              const choices=['1010 — Item esgotado','1020 — Loja fechada','1030 — Loja sem capacidade de preparo','1040 — Acidente grave ou interrupção de serviço','1050 — Problema relacionado ao cliente','1060 — Sem entregador (somente entrega da loja)','1070 — Atualizar cardápio','1071 — Fora da área (somente entrega da loja)','1072 — Endereço inseguro (somente entrega da loja)','1073 — Suspeita de fraude','1074 — Dúvida sobre taxas ou promoções','1080 — Outro motivo'];
              const selected=await window.RotaMotoDialog.prompt({title:'Motivo do cancelamento',message:'Selecione o motivo oficial informado pela 99Food.',fieldLabel:'Motivo',options:choices.map(choice=>({value:choice.slice(0,4).trim(),label:choice}))});if(!selected)return;const reasonId=Number(selected);
              if(!choices.some(choice=>choice.startsWith(String(reasonId)))){status.textContent='Código de motivo inválido.';return;}
              commandData={reasonId};if(reasonId===1080){const reason=await window.RotaMotoDialog.prompt({title:'Descreva o motivo',message:'A 99Food exige uma explicação para a opção “Outro motivo”.',fieldLabel:'Motivo',multiline:true,maxLength:500,validate:value=>value.trim()?true:'Descreva o motivo.'});if(!reason?.trim())return;commandData.reason=reason.trim();}
            }else if(operation==='CANCEL_ORDER'){
              const reason=await window.RotaMotoDialog.prompt({title:'Motivo do cancelamento',message:'Informe o motivo exigido pela plataforma.',fieldLabel:'Motivo',multiline:true,maxLength:500,validate:value=>value.trim()?true:'Informe o motivo.'});if(!reason)return;commandData={reason};if(order.provider==='keeta'){const code=await window.RotaMotoDialog.prompt({title:'Código de cancelamento Keeta',message:'Informe o código oficial de cancelamento.',fieldLabel:'Código',maxLength:120,validate:value=>value.trim()?true:'Informe o código.'});if(!code)return;commandData.code=code;}
            }
            if(operation==='CANCEL_REQUEST'){
              const decision=await window.RotaMotoDialog.prompt({title:'Pedido de cancelamento',message:'Escolha uma decisão explícita para a solicitação recebida.',fieldLabel:'Decisão',options:[{value:'approve',label:'Aprovar cancelamento'},{value:'deny',label:'Recusar cancelamento'}]});if(!decision)return;const agree=decision==='approve';commandData={applyId:order.application.id,agree};
              if(!agree&&order.application.reasons?.length){const selected=await window.RotaMotoDialog.prompt({title:'Motivo da recusa',message:'Selecione um dos motivos informados pela 99Food.',fieldLabel:'Motivo',options:order.application.reasons.map((entry,index)=>({value:String(index),label:entry.label}))});if(selected!==null){const choice=order.application.reasons[Number(selected)];if(!choice){status.textContent='Opção de motivo inválida.';return;}commandData.reason=choice.label;}}
            }
            if(operation==='REFUND_REQUEST'){
              const decision=await window.RotaMotoDialog.prompt({title:'Pedido de reembolso',message:'Escolha uma decisão explícita para a solicitação recebida.',fieldLabel:'Decisão',options:[{value:'approve',label:'Aprovar reembolso'},{value:'deny',label:'Recusar reembolso'}]});if(!decision)return;const agree=decision==='approve';commandData={applyId:order.application.id,agree};
              if(!agree){const options=order.application.baseReasons||[];if(!options.length){status.textContent='A 99Food não enviou motivos para recusa deste reembolso.';return;}const selected=await window.RotaMotoDialog.prompt({title:'Motivo da recusa',message:'Selecione um motivo fornecido pela 99Food.',fieldLabel:'Motivo',options:options.map((entry,index)=>({value:String(index),label:entry.label}))});if(selected===null)return;const choice=options[Number(selected)];if(!choice){status.textContent='Opção de motivo inválida.';return;}commandData.baseReasonId=choice.id;commandData.baseReason=choice.label;}
            }
            if(operation==='DISPATCH_MERCHANT'&&order.provider==='keeta'){const url=await window.RotaMotoDialog.prompt({title:'Rastreamento da entrega',message:'Informe o link HTTPS de acompanhamento da entrega própria.',fieldLabel:'Link HTTPS',inputType:'url',maxLength:2048,validate:value=>{try{return new URL(value).protocol==='https:'||'Informe um link HTTPS válido.'}catch(_){return 'Informe um link HTTPS válido.'}}});if(!url)return;commandData.deliveryTrackingInfo={externalTrackingURL:url};}
            button.disabled=true;try{const result=await request(`/admin/marketplace/orders/${encodeURIComponent(order.domainOrderId)}/commands`,{method:'POST',body:JSON.stringify({operation,idempotencyKey:crypto.randomUUID(),commandData})});
              status.textContent=result.status==='pending'?'Comando aceito; aguardando confirmação da plataforma.':'Comando registrado para execução.';await loadAdmin();}
            catch(error){button.disabled=false;status.textContent=message(error);}});item.append(button);});
        const providerPage=providerPageByCode.get(String(order.provider||'').toLowerCase());if(providerPage)providerPage.append(item);
      });
      for(const [providerCode,providerPage] of providerPageByCode){if(marketplaceOrders.loaded&&!orderRows.some(order=>String(order.provider||'').toLowerCase()===providerCode)){const empty=document.createElement('p');empty.textContent='Nenhum pedido recebido desta plataforma. Os pedidos aparecerão aqui após uma conexão real e confirmação do servidor.';providerPage.append(empty)}}
      if(integrations.integrations.length)list.append(providerNav,providerPages);else{const empty=document.createElement('p');empty.textContent='Nenhuma plataforma de delivery está disponível neste servidor.';list.append(empty)}
    }
    const roleSelect = $('[data-invite] select'); roleSelect.replaceChildren();
    const assignableRoles = roles.roles.filter(role => role.permissions.every(permission => current.permissions.includes(permission)));
    assignableRoles.forEach(role => { const option = document.createElement('option'); option.value = role.id; option.textContent = role.name; roleSelect.append(option); });
    const permissionBox = $('[data-permissions]'); permissionBox.replaceChildren();
    const grantablePermissionKeys = current.permissions;
    appendPermissionOptions(permissionBox, permissionResult.permissions, [], grantablePermissionKeys);
    const roleList = $('[data-roles-list]'); roleList.replaceChildren();
    const roleCount=document.createElement('p');roleCount.className='rm-team-section-note';roleCount.textContent=`${roles.roles.length} ${roles.roles.length===1?'perfil disponível':'perfis disponíveis'} nesta empresa.`;roleList.append(roleCount);
    roles.roles.forEach(role => {
      const card = document.createElement('article'); card.className = 'rm-team-role';
      const disclosure=document.createElement('details');disclosure.className='rm-team-disclosure rm-team-role-disclosure';
      const summary=document.createElement('summary');summary.className='rm-team-row-summary';
      const summaryName=document.createElement('strong');summaryName.textContent=role.name;
      const roleState=document.createElement('span');roleState.className='rm-team-state';roleState.textContent=role.key==='owner'||role.systemTemplate?'Protegido':role.id===current.activeRoleId?'Perfil da sua sessão':'Perfil da empresa';
      const summaryArrow=document.createElement('span');summaryArrow.className='rm-team-chevron';summaryArrow.setAttribute('aria-hidden','true');summaryArrow.textContent='›';
      summary.append(summaryName,roleState,summaryArrow);disclosure.append(summary);
      const roleDetails=document.createElement('div');roleDetails.className='rm-team-disclosure-content';
      if(role.description){const description=document.createElement('p');description.className='rm-team-section-note';description.textContent=role.description;roleDetails.append(description)}
      const permissionSummary=document.createElement('div');permissionSummary.className='rm-team-role-permission-summary';
      appendPermissionOptions(permissionSummary,permissionResult.permissions,role.permissions,grantablePermissionKeys,{readOnly:true});
      roleDetails.append(permissionSummary);
      if (role.key === 'owner' || role.systemTemplate) {
        const note = document.createElement('p'); note.className='rm-team-protected-note';note.textContent = 'Este perfil é protegido para preservar os acessos essenciais. Suas permissões não podem ser alteradas pelo editor comum.'; roleDetails.append(note);
        if (role.key === 'owner' && role.id === current.activeRoleId && current.permissions.includes('company.manage')) {
          const financeKeys = ['finance.read', 'finance.manage'];
          const missingFinance = financeKeys.filter(key => !role.permissions.includes(key));
          if (missingFinance.length) {
            const help = document.createElement('p'); help.textContent = 'Faltam acessos financeiros neste perfil. Você pode restaurar somente as permissões financeiras do proprietário desta empresa.'; roleDetails.append(help);
            const restore = document.createElement('button'); restore.type = 'button'; restore.textContent = 'Restaurar acessos financeiros do proprietário';
            const feedback = document.createElement('p'); feedback.setAttribute('role', 'status'); roleDetails.append(restore, feedback);
            restore.addEventListener('click', async () => {
              const confirmation=await window.RotaMotoDialog.confirm({title:'Restaurar acessos financeiros essenciais?',message:'Serão adicionadas somente as permissões de consulta e gestão financeira ao perfil protegido desta empresa. A alteração será validada e auditada pelo servidor.',confirmLabel:'Restaurar acessos'});if(!confirmation?.confirmed)return;
              restore.disabled = true;
              try { await request('/admin/roles/owner/restore-finance', { method: 'POST', body: JSON.stringify({}) }); feedback.textContent = 'Acessos financeiros restaurados. Atualizando a sessão…'; window.location.reload(); }
              catch (error) { feedback.textContent = message(error); restore.disabled = false; }
            });
          } else { const complete = document.createElement('p'); complete.className='rm-team-section-note';complete.textContent = 'Acessos financeiros essenciais já estão configurados.'; roleDetails.append(complete); }
        }
      } else if (role.id === current.activeRoleId) { const note = document.createElement('p');note.className='rm-team-protected-note'; note.textContent = 'Este é o perfil associado à sua sessão e não pode ser alterado por você.'; roleDetails.append(note);
      } else if (!role.permissions.every(permission => current.permissions.includes(permission))) { const note = document.createElement('p');note.className='rm-team-protected-note'; note.textContent = 'Este perfil inclui acessos acima do seu nível. Você pode consultar as permissões, mas somente um administrador com nível suficiente pode alterá-las.'; roleDetails.append(note);
      } else {
      const editorSource=document.createElement('div');editorSource.className='rm-admin-role-editor-source';
      const nameLabel = document.createElement('label'); nameLabel.textContent = 'Nome do perfil'; const nameInput = document.createElement('input'); nameInput.name = 'name'; nameInput.required = true; nameInput.maxLength = 100; nameInput.value = role.name; nameLabel.append(nameInput);
      const descriptionLabel=document.createElement('label');descriptionLabel.textContent='Descrição';const descriptionInput=document.createElement('input');descriptionInput.name='description';descriptionInput.maxLength=240;descriptionInput.value=role.description||'';descriptionLabel.append(descriptionInput);
      const fieldset = document.createElement('fieldset'); const legend = document.createElement('legend'); legend.textContent = 'Permissões'; fieldset.append(legend);
      const checks = document.createElement('div'); checks.className = 'rm-role-permissions';
      appendPermissionOptions(checks, permissionResult.permissions, role.permissions, grantablePermissionKeys);
      fieldset.append(checks);const editForm=document.createElement('form');editForm.append(nameLabel,descriptionLabel,fieldset);
      const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Salvar perfil'; const feedback = document.createElement('p'); feedback.setAttribute('role', 'status'); editForm.append(feedback);roleDetails.append(editorSource);
      const dialog=window.RotaMotoAdminFormDialog.create({source:editorSource,form:editForm,title:`Editar perfil: ${role.name}`,description:'As permissões disponíveis são limitadas pelo seu nível de acesso e confirmadas pelo servidor.',triggerLabel:'Editar perfil',submitButton:save});
      if(dialog){dialog.trigger.classList.add('rm-team-section-action');roleDetails.append(dialog.trigger,dialog.dialog)}
      editForm.addEventListener('submit', async event => { event.preventDefault(); if (!nameInput.reportValidity()||save.disabled) return; setBusy(editForm,true);let persisted=false;
        const permissions = [...checks.querySelectorAll('input:checked')].map(input => input.value);
        try { const result=await request(`/admin/roles/${encodeURIComponent(role.id)}`, { method: 'PATCH', body: JSON.stringify({ name: nameInput.value.trim(), description:descriptionInput.value.trim(), permissions }) });if(result?.id!==role.id||!Array.isArray(result.permissions))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});persisted=true;dialog.markSaved();const refreshed=await loadAdmin();const savedRole=refreshed?.roles?.roles?.find(item=>item.id===role.id);if(!savedRole||savedRole.name!==nameInput.value.trim()||JSON.stringify([...savedRole.permissions].sort())!==JSON.stringify([...permissions].sort()))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});const teamFeedback=adminPage.querySelector('[data-team-feedback]');if(teamFeedback)teamFeedback.textContent='Perfil atualizado e confirmado na lista do servidor.'; }
        catch (error) { if(persisted){const teamFeedback=adminPage.querySelector('[data-team-feedback]');if(teamFeedback)teamFeedback.textContent=`Perfil salvo, mas a lista não pôde ser atualizada: ${message(error)}`}else{feedback.textContent = message(error);feedback.hidden=false} } finally { setBusy(editForm,false); }
      });
      }
      disclosure.append(roleDetails);card.append(disclosure);roleList.append(card);
    });
    const invitationList=adminPage.querySelector('[data-team-invitations]');
    const pendingInvitations=members.members.filter(member=>member.status==='invited');
    const memberRows=members.members.filter(member=>member.status!=='invited');
    const memberCount=adminPage.querySelector('[data-team-member-count]');
    const inviteCount=adminPage.querySelector('[data-team-invite-count]');
    if(memberCount)memberCount.textContent=canReadMembers?`${memberRows.filter(member=>member.status==='active'&&!member.disabled).length} integrantes ativos`:'Integrantes: sem acesso à consulta';
    if(inviteCount)inviteCount.textContent=canReadMembers?`Convites para acompanhar: ${pendingInvitations.length}`:'Convites: sem acesso à consulta';
    const list = $('[data-members]'); list.replaceChildren();
    if(!canReadMembers){const empty=document.createElement('p');empty.textContent='Seu perfil não permite consultar os integrantes desta empresa.';list.append(empty);}
    else if(!memberRows.length){const empty=document.createElement('p');empty.textContent='Nenhum integrante com vínculo ativo ou encerrado nesta empresa.';list.append(empty);}
    if(invitationList){invitationList.replaceChildren();if(!canReadMembers){const empty=document.createElement('p');empty.textContent='Seu perfil não permite consultar os convites desta empresa.';invitationList.append(empty)}else if(!pendingInvitations.length){const empty=document.createElement('p');empty.textContent='Não há convites aguardando ativação.';invitationList.append(empty)}else pendingInvitations.forEach(member=>{
      const card=document.createElement('article');card.className='rm-team-invitation';
      const identity=document.createElement('div');identity.className='rm-team-invitation-identity';
      const email=document.createElement('strong');email.textContent=member.email;
      const state=document.createElement('span');state.className='rm-team-state';
      const expiresAt=Date.parse(member.invitationExpiresAt||'');
      state.textContent=Number.isFinite(expiresAt)?(expiresAt<=Date.now()?'Convite expirado · reenvie para emitir outro':member.userId?'Conta existente · aguardando ativação':'Aguardando aceitação'):'Convite sem validade ativa · reenvie para emitir outro';
      const role=document.createElement('small');role.textContent=`Perfil: ${member.roleName}`;identity.append(email,state,role);card.append(identity);
      const feedback=document.createElement('p');feedback.className='rm-team-row-feedback';feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');card.append(feedback);
      const actions=document.createElement('div');actions.className='rm-team-row-actions';
      if(current.permissions.includes('members.invite')){const resend=document.createElement('button');resend.type='button';resend.className='rm-secondary';resend.textContent='Reenviar convite';resend.addEventListener('click',async()=>{resend.disabled=true;card.setAttribute('aria-busy','true');feedback.textContent='Enviando convite…';const teamFeedback=adminPage.querySelector('[data-team-feedback]');try{const result=await request('/admin/invitations',{method:'POST',body:JSON.stringify({email:member.email,roleId:member.roleId})});if(result?.delivery!=='sent'||result.membershipId!==member.membershipId)throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});if(teamFeedback)teamFeedback.textContent='Novo convite enviado. O anterior deixou de ser válido.';try{const refreshed=await loadAdmin();if(!refreshed?.members?.members?.some(item=>item.membershipId===member.membershipId&&item.status==='invited'))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});}catch(error){if(teamFeedback)teamFeedback.textContent=`Convite enviado, mas a lista não pôde ser atualizada: ${message(error)}`;}}catch(error){feedback.textContent=message(error);resend.disabled=false;}finally{card.removeAttribute('aria-busy')}});actions.append(resend)}
      if(current.permissions.includes('company.manage')){const revoke=document.createElement('button');revoke.type='button';revoke.className='rm-secondary';revoke.textContent='Revogar convite';revoke.addEventListener('click',async()=>{const confirmation=await window.RotaMotoDialog.confirm({title:'Revogar convite?',message:`O convite enviado a ${member.email} deixará de ser válido.`,danger:true,confirmLabel:'Revogar convite'});if(!confirmation?.confirmed)return;revoke.disabled=true;card.setAttribute('aria-busy','true');feedback.textContent='Revogando convite…';const teamFeedback=adminPage.querySelector('[data-team-feedback]');try{const result=await request(`/admin/memberships/${member.membershipId}`,{method:'PATCH',body:JSON.stringify({status:'revoked'})});if(result?.membershipId!==member.membershipId||result.status!=='revoked')throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});if(teamFeedback)teamFeedback.textContent='Convite revogado pelo servidor.';try{const refreshed=await loadAdmin();if(refreshed?.members?.members?.some(item=>item.membershipId===member.membershipId&&item.status==='invited'))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});}catch(error){if(teamFeedback)teamFeedback.textContent=`Convite revogado, mas a lista não pôde ser atualizada: ${message(error)}`;}}catch(error){feedback.textContent=message(error);revoke.disabled=false;}finally{card.removeAttribute('aria-busy')}});actions.append(revoke)}
      if(actions.childElementCount)card.append(actions);else{const note=document.createElement('p');note.className='rm-team-section-note';note.textContent='Seu perfil pode consultar este convite, mas não pode reenviá-lo nem revogá-lo.';card.append(note)}
      invitationList.append(card);
    })}
    const driverList = $('[data-driver-members]'); if(driverList) driverList.replaceChildren();
    memberRows.forEach(member => {
      const card = document.createElement('article'); card.className = 'rm-team-member';
      const memberStatus = member.disabled ? 'Conta desativada'
        : member.status === 'active' ? 'Ativo'
          : member.status === 'suspended' ? 'Acesso suspenso'
            : member.status === 'revoked' ? 'Vínculo encerrado'
              : 'Estado não disponível';
      const details=document.createElement('details');details.className='rm-team-disclosure rm-team-member-disclosure';
      const summary=document.createElement('summary');summary.className='rm-team-row-summary';
      const title=document.createElement('strong');title.textContent=member.email;
      const meta=document.createElement('span');meta.className='rm-team-state';meta.textContent=`${member.roleName} · ${memberStatus}`;
      const arrow=document.createElement('span');arrow.className='rm-team-chevron';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';summary.append(title,meta,arrow);details.append(summary);
      const controls=document.createElement('div');controls.className='rm-team-disclosure-content';
      const rowFeedback=document.createElement('p');rowFeedback.className='rm-team-row-feedback';rowFeedback.setAttribute('role','status');rowFeedback.setAttribute('aria-live','polite');
      if(member.driverId){const driverNote=document.createElement('p');driverNote.className='rm-team-section-note';driverNote.textContent=memberStatus==='Ativo'?'Há um cadastro operacional de motoboy vinculado.':'O cadastro operacional de motoboy permanece vinculado; o acesso segue o estado desta associação.';controls.append(driverNote)}
      if (member.userId !== current.userId) {
        const currentRole = roles.roles.find(role => role.id === member.roleId);
        const canReassignCurrent = currentRole?.permissions.every(permission => current.permissions.includes(permission)) ?? false;
        if (canReassignCurrent) {
        const select = document.createElement('select'); select.setAttribute('aria-label', `Perfil de ${member.email}`);
        roles.roles.filter(role => role.id === member.roleId || role.permissions.every(permission => current.permissions.includes(permission)))
          .forEach(role => { const option = document.createElement('option'); option.value = role.id; option.textContent = role.name; option.selected = role.id === member.roleId; select.append(option); });
        const save = document.createElement('button'); save.type = 'button'; save.className='rm-primary';save.textContent = 'Salvar função';save.disabled=true;
        const originalRole=member.roleId;select.addEventListener('change',()=>{save.disabled=select.value===originalRole});
        save.addEventListener('click', async () => { const requestedRole=select.value;if(!requestedRole||requestedRole===originalRole)return;save.disabled=true;controls.setAttribute('aria-busy','true');rowFeedback.textContent='Salvando função…';let persisted=false;try{const result=await request(`/admin/memberships/${member.membershipId}`,{method:'PATCH',body:JSON.stringify({roleId:requestedRole})});if(result?.membershipId!==member.membershipId||result.roleId!==requestedRole)throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});persisted=true;const refreshed=await loadAdmin();if(!refreshed?.members?.members?.some(item=>item.membershipId===member.membershipId&&item.roleId===requestedRole))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});adminPage.querySelector('[data-team-feedback]').textContent='Função atualizada e confirmada pelo servidor.';}catch(error){const text=persisted?`Função salva, mas a lista não pôde ser confirmada: ${message(error)}`:message(error);rowFeedback.textContent=text;if(persisted)adminPage.querySelector('[data-team-feedback]').textContent=text;if(!persisted)save.disabled=false;}finally{controls.removeAttribute('aria-busy')}});
        const roleAction=document.createElement('div');roleAction.className='rm-team-role-action';roleAction.append(select,save);controls.append(roleAction);
        }
      if (member.status === 'active' || member.status === 'suspended') { const stateButton = document.createElement('button'); stateButton.type = 'button'; stateButton.className = 'rm-secondary'; stateButton.textContent = member.status === 'active' ? 'Suspender' : 'Reativar';
          stateButton.addEventListener('click', async () => { if (member.status === 'active') { const confirmation=await window.RotaMotoDialog.confirm({title:'Suspender acesso?',message:`O acesso empresarial de ${member.email} será suspenso.`,danger:true,confirmLabel:'Suspender acesso'});if(!confirmation?.confirmed)return; } stateButton.disabled = true;controls.setAttribute('aria-busy','true');rowFeedback.textContent=member.status==='active'?'Suspendendo acesso…':'Reativando acesso…';let persisted=false;try{const nextStatus=member.status==='active'?'suspended':'active';const result=await request(`/admin/memberships/${member.membershipId}`,{method:'PATCH',body:JSON.stringify({status:nextStatus})});if(result?.membershipId!==member.membershipId||result.status!==nextStatus)throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});persisted=true;const refreshed=await loadAdmin();if(!refreshed?.members?.members?.some(item=>item.membershipId===member.membershipId&&item.status===nextStatus))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});adminPage.querySelector('[data-team-feedback]').textContent=nextStatus==='suspended'?'Acesso suspenso e confirmado pelo servidor.':'Acesso reativado e confirmado pelo servidor.';}catch(error){const text=persisted?`Alteração confirmada, mas a lista não pôde ser atualizada: ${message(error)}`:message(error);rowFeedback.textContent=text;if(persisted)adminPage.querySelector('[data-team-feedback]').textContent=text;if(!persisted)stateButton.disabled=false;}finally{controls.removeAttribute('aria-busy')}}); controls.append(stateButton); }
      }
      if(member.userId===current.userId){const ownNote=document.createElement('p');ownNote.className='rm-team-protected-note';ownNote.textContent='Seu próprio vínculo administrativo não pode ser alterado nesta tela.';controls.append(ownNote)}
      controls.append(rowFeedback);
      details.append(controls);card.append(details);
      list.append(card);
    });
    if(driverList){
      const driverSummary=adminPage.querySelector('[data-driver-summary]');
      const driverFeedback=adminPage.querySelector('[data-driver-feedback]');
      const linkedMembers=memberRows.filter(member=>member.driverId);
      const accountCandidates=memberRows.filter(member=>!member.driverId&&
        (member.permissions?.includes('sync.pull')||member.permissions?.includes('sync.push')));
      const linkedIds=new Set(linkedMembers.map(member=>member.driverId));
      const identityEmails=new Set(memberRows.map(member=>String(member.email||'').trim().toLowerCase()).filter(Boolean));
      const unlinkedDrivers=driverRows.filter(row=>!linkedIds.has(row.id)&&!identityEmails.has(String(row.record?.email||'').trim().toLowerCase()));
      const linkableStatuses=new Set(['ACTIVE','AVAILABLE','DISPONIVEL','EM ROTA','CHEGOU','IN ROUTE','ARRIVED',
        'OFFLINE','UNAVAILABLE','INDISPONIVEL','BUSY','OCUPADO','PAUSED','PAUSADO']);
      const normalizedStatus=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/gu,'').trim().toUpperCase();
      const driverStatusLabel=value=>({ACTIVE:'Ativo',AVAILABLE:'Disponível',DISPONIVEL:'Disponível','EM ROTA':'Em rota',
        CHEGOU:'Chegou','IN ROUTE':'Em rota',ARRIVED:'Chegou',OFFLINE:'Offline',UNAVAILABLE:'Indisponível',
        INDISPONIVEL:'Indisponível',BUSY:'Ocupado',OCUPADO:'Ocupado',PAUSED:'Pausado',PAUSADO:'Pausado',
        DISABLED:'Desativado',INACTIVE:'Inativo',INATIVO:'Inativo',INATIVA:'Inativo'})[normalizedStatus(value)]||
        (value?'Estado não reconhecido':'Estado não informado');
      const availabilityLabel=driverId=>{
        if(availabilityReadFailed)return 'Disponibilidade não consultada';
        const availability=availabilityByDriver.get(driverId);
        if(!availability)return 'Disponibilidade não informada';
        return availability.effectiveStatus==='online'?'Online agora':'Offline';
      };
      if(driverSummary)driverSummary.textContent=`${linkedMembers.length} contas vinculadas · ${driverRows.length} cadastros operacionais`;
      if(driverFeedback)driverFeedback.textContent=availabilityReadFailed?'A disponibilidade não pôde ser consultada; os vínculos e cadastros foram carregados normalmente.':'';
      const group=(title,description,items,emptyText)=>{
        const section=document.createElement('section');section.className='rm-driver-group';
        const heading=document.createElement('div');heading.className='rm-driver-group-heading';
        const copy=document.createElement('div');const label=document.createElement('h3');label.textContent=`${title} · ${items.length}`;
        const note=document.createElement('p');note.textContent=description;copy.append(label,note);heading.append(copy);section.append(heading);
        const rows=document.createElement('div');rows.className='rm-driver-group-rows';
        if(!items.length){const empty=document.createElement('p');empty.className='rm-driver-empty';empty.textContent=emptyText;rows.append(empty)}
        section.append(rows);driverList.append(section);return rows;
      };
      const linkedRows=group('Contas vinculadas','A conta, o perfil e o cadastro operacional são exibidos separadamente.',linkedMembers,'Nenhuma conta está vinculada a um cadastro de motoboy.');
      for(const member of linkedMembers){
        const driver=driverRows.find(row=>row.id===member.driverId);
        const details=document.createElement('details');details.className='rm-driver-card';
        const summary=document.createElement('summary');summary.className='rm-driver-row';
        const identity=document.createElement('span');identity.className='rm-driver-row-identity';
        const email=document.createElement('strong');email.textContent=member.email;
        const meta=document.createElement('small');meta.textContent=`${member.roleName} · ${member.disabled?'Conta desativada':member.status==='active'?'Conta ativa':member.status==='suspended'?'Acesso suspenso':member.status==='revoked'?'Vínculo encerrado':'Estado não disponível'}`;
        const arrow=document.createElement('span');arrow.className='rm-team-chevron';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';identity.append(email,meta);summary.append(identity,arrow);details.append(summary);
        const content=document.createElement('div');content.className='rm-driver-card-content';
        const driverName=document.createElement('strong');driverName.textContent=driver?.record?.name||driver?.record?.displayName||'Cadastro operacional não carregado';content.append(driverName);
        const driverState=document.createElement('p');driverState.textContent=`Cadastro: ${driverStatusLabel(driver?.record?.status)}`;content.append(driverState);
        const availability=document.createElement('p');availability.textContent=`Disponibilidade: ${availabilityLabel(member.driverId)}`;content.append(availability);
        const status=document.createElement('p');status.className='rm-driver-link-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
        if(driver&&!linkableStatuses.has(normalizedStatus(driver.record?.status)))status.textContent='Este cadastro está inativo ou sem estado reconhecido. O Motoboy não autoriza o acesso operacional.';
        else if(!driver)status.textContent='O vínculo permanece registrado, mas o cadastro não veio na lista atual. Atualize a lista antes de qualquer alteração.';
        const unlink=document.createElement('button');unlink.type='button';unlink.className='rm-secondary';unlink.textContent='Encerrar vínculo';
        unlink.addEventListener('click',async()=>{
          const confirmation=await window.RotaMotoDialog.confirm({title:'Encerrar vínculo com o Motoboy?',
            message:`A conta ${member.email} perderá o acesso ao cadastro operacional. Entregas em andamento precisam ser reatribuídas ou concluídas antes; o histórico será preservado.`,
            danger:true,confirmLabel:'Encerrar vínculo'});if(!confirmation?.confirmed)return;
          unlink.disabled=true;content.setAttribute('aria-busy','true');status.textContent='Verificando e encerrando o vínculo…';let persisted=false;
          try{
            const result=await request(`/admin/memberships/${member.membershipId}/driver`,{method:'DELETE'});
            if(result?.membershipId!==member.membershipId||result.driverId!==null||typeof result.changed!=='boolean')throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});
            persisted=true;const refreshed=await loadAdmin();
            if(!refreshed?.members?.members?.some(item=>item.membershipId===member.membershipId&&item.driverId===null))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});
            if(driverFeedback)driverFeedback.textContent=result.changed?'Vínculo encerrado e confirmado pelo servidor. A disponibilidade e a presença operacional foram finalizadas quando estavam ativas.':'Esta conta já não tinha um vínculo ativo.';
          }catch(error){const text=persisted?`Vínculo encerrado, mas a lista não pôde ser confirmada: ${message(error)}`:message(error);status.textContent=text;if(driverFeedback)driverFeedback.textContent=text;if(!persisted)unlink.disabled=false;}
          finally{content.removeAttribute('aria-busy')}
        });
        content.append(status,unlink);details.append(content);linkedRows.append(details);
      }
      const accountRows=group('Contas autorizadas sem cadastro','Somente contas ativas, confirmadas e autorizadas podem ser vinculadas.',accountCandidates,'Nenhuma conta com acesso de sincronização aguarda um cadastro.');
      for(const member of accountCandidates){
        const details=document.createElement('details');details.className='rm-driver-card';const summary=document.createElement('summary');summary.className='rm-driver-row';
        const identity=document.createElement('span');identity.className='rm-driver-row-identity';const email=document.createElement('strong');email.textContent=member.email;
        const accountState=document.createElement('small');accountState.textContent=`${member.roleName} · ${member.disabled?'Conta desativada':member.status==='active'?'Conta ativa':member.status==='invited'?'Aguardando convite':member.status==='suspended'?'Acesso suspenso':'Vínculo encerrado'}`;
        const arrow=document.createElement('span');arrow.className='rm-team-chevron';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';identity.append(email,accountState);summary.append(identity,arrow);details.append(summary);
        const content=document.createElement('div');content.className='rm-driver-card-content';
        const eligible=member.status==='active'&&!member.disabled&&member.emailVerified&&member.permissions?.includes('sync.pull')&&member.permissions?.includes('sync.push');
        const note=document.createElement('p');note.className='rm-driver-link-status';note.setAttribute('role','status');
        if(!eligible)note.textContent='Ative a conta, confirme o email e revise as permissões de sincronização em Equipe e permissões.';
        else if(!canReadDrivers)note.textContent='Seu perfil não pode listar os cadastros operacionais desta empresa.';
        else{
          const select=document.createElement('select');select.setAttribute('aria-label',`Cadastro operacional para ${member.email}`);
          const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Selecione um cadastro operacional';select.append(placeholder);
          const linkedElsewhere=new Set(memberRows.filter(item=>item.membershipId!==member.membershipId&&item.driverId).map(item=>item.driverId));
          driverRows.filter(row=>!linkedElsewhere.has(row.id)).forEach(row=>{
            const statusKey=normalizedStatus(row.record?.status),linkable=linkableStatuses.has(statusKey);
            const option=document.createElement('option');option.value=row.id;option.disabled=!linkable;
            const name=row.record?.name||row.record?.displayName||'Motoboy';
            option.textContent=`${name} · ${driverStatusLabel(row.record?.status)}${linkable?'':' · indisponível para vínculo'}`;select.append(option);
          });
          const link=document.createElement('button');link.type='button';link.className='rm-primary';link.textContent='Vincular cadastro';link.disabled=true;
          select.addEventListener('change',()=>{link.disabled=!select.value});
          link.addEventListener('click',async()=>{
            const selectedDriverId=select.value;if(!selectedDriverId)return;
            link.disabled=true;content.setAttribute('aria-busy','true');note.textContent='Confirmando o vínculo no servidor…';let persisted=false;
            try{
              const result=await request(`/admin/memberships/${member.membershipId}/driver`,{method:'PUT',body:JSON.stringify({driverId:selectedDriverId})});
              if(result?.membershipId!==member.membershipId||result.driverId!==selectedDriverId||typeof result.changed!=='boolean')throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});
              persisted=true;const refreshed=await loadAdmin();
              if(!refreshed?.members?.members?.some(item=>item.membershipId===member.membershipId&&item.driverId===selectedDriverId))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});
              const driverFeedback=adminPage.querySelector('[data-driver-feedback]');if(driverFeedback)driverFeedback.textContent='Vínculo confirmado pelo servidor e relido da empresa.';
            }catch(error){const text=persisted?`Vínculo salvo, mas a lista não pôde ser confirmada: ${message(error)}`:message(error);note.textContent=text;if(!persisted)link.disabled=!select.value;}
            finally{content.removeAttribute('aria-busy')}
          });
          content.append(select,link,note);
        }
        if(!eligible||!canReadDrivers)content.append(note);
        details.append(content);accountRows.append(details);
      }
      const unlinkedMessage=!canReadDrivers?'Seu perfil não pode consultar os cadastros operacionais desta empresa.':'Todos os cadastros carregados já têm uma conta reconhecida ou vínculo.';
      const unlinkedRows=group('Cadastros sem conta vinculada','Cadastros operacionais não são contas e não enviam convites por si só.',unlinkedDrivers,unlinkedMessage);
      for(const row of unlinkedDrivers){
        const item=document.createElement('article');item.className='rm-driver-card rm-driver-unlinked';
        const identity=document.createElement('div');identity.className='rm-driver-row-identity';const name=document.createElement('strong');name.textContent=row.record?.name||row.record?.displayName||'Motoboy';
        const state=document.createElement('small');state.textContent=`Cadastro ${driverStatusLabel(row.record?.status)} · sem conta vinculada`;identity.append(name,state);
        item.append(identity);
        if(current.permissions.includes('members.invite')){
          const inviteButton=document.createElement('button');inviteButton.type='button';inviteButton.className='rm-secondary';inviteButton.textContent='Convidar pessoa';
          inviteButton.addEventListener('click',()=>{adminPage.showPage?.('team');const emailInput=$('[data-invite] input[name="email"]');if(emailInput&&row.record?.email)emailInput.value=row.record.email;emailInput?.focus();});
          item.append(inviteButton);
        }else{
          const inviteNote=document.createElement('small');inviteNote.className='rm-driver-link-status';inviteNote.textContent='Seu perfil não permite enviar convites.';item.append(inviteNote);
        }
        unlinkedRows.append(item);
      }
    }
    if (driverCursor && canReadDrivers) {
      const more = document.createElement('button'); more.type = 'button'; more.className = 'rm-secondary'; more.textContent = 'Carregar mais motoristas';
      more.addEventListener('click', async () => { more.disabled = true; try { await loadAdmin({ appendDrivers: true }); } catch (error) { $('[data-admin-error]').textContent = message(error); more.disabled = false; } });
      driverList?.append(more);
    }
    try{await loadMfaRecoveryRequests()}catch(error){const recoveryList=adminPage.querySelector('[data-mfa-recovery-requests]');if(recoveryList){recoveryList.replaceChildren();const status=document.createElement('p');status.setAttribute('role','status');status.textContent=`As solicitações de recuperação não puderam ser atualizadas: ${message(error)}`;recoveryList.append(status)}}
    return {company,members,roles,permissions:permissionResult};
  }
  if (serverUpdateBus && appKind === 'restaurante') {
    serverUpdateBus.subscribe(({ topic }) => {
      if (adminPage.hidden || !current || document.visibilityState === 'hidden') return;
      const companyForm = $('[data-company-setup]');
      if (companyForm?.dataset.dirty === 'true') return;
      if (['company', 'team', 'drivers', 'integrations'].includes(topic)) {
        loadAdmin().catch(error => { $('[data-admin-error]').textContent = message(error); });
      }
    });
  }
  $('[data-refresh-admin]')?.addEventListener('click', () => loadAdmin().catch(error => { $('[data-admin-error]').textContent = message(error); }));
  async function loadMfaRecoveryRequests(){
    const section=$('[data-mfa-recovery-admin]'),list=$('[data-mfa-recovery-requests]');
    if(!current?.permissions?.includes('company.manage')||!current.mfaVerified){section.hidden=true;return}
    section.hidden=false;list.replaceChildren();
    const result=await request('/admin/mfa-recovery');
    if(!result.requests.length){const empty=document.createElement('p');empty.textContent='Nenhuma solicitação pendente.';list.append(empty);return}
    for(const item of result.requests){const row=document.createElement('article'),label=document.createElement('p'),feedback=document.createElement('p');
      label.textContent=`Solicitação de recuperação recebida em ${new Date(item.requestedAt).toLocaleString()}; expira em ${new Date(item.expiresAt).toLocaleString()}.`;
      if(item.requestedByCurrentUser)feedback.textContent='Solicitação própria: outro administrador com MFA deve aprovar. Se você for o único administrador, use o procedimento local auditado.';
      else{const approve=document.createElement('button');approve.type='button';approve.textContent='Aprovar e exigir novo MFA';approve.addEventListener('click',async()=>{approve.disabled=true;try{await request(`/admin/mfa-recovery/${encodeURIComponent(item.id)}/approve`,{method:'POST',body:'{}'});feedback.textContent='Fator revogado, sessões invalidadas. O usuário deverá configurar MFA novamente.';await loadMfaRecoveryRequests()}catch(error){feedback.textContent=message(error);approve.disabled=false}});row.append(approve)}
      row.prepend(label);row.append(feedback);list.append(row)
    }
  }
  $('[data-refresh-mfa-recovery]')?.addEventListener('click',()=>loadMfaRecoveryRequests().catch(error=>{$('[data-admin-error]').textContent=message(error)}));
  $('[data-company-setup]')?.addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget;if(!form.reportValidity()||!companySnapshot)return;setBusy(form,true);const status=$('[data-company-setup-status]');status.textContent='Salvando…';
    try{const address=form.elements.address.value.trim()||null;const profile=await request('/admin/company/profile',{method:'PUT',body:JSON.stringify({expectedVersion:companySnapshot.settingsVersion,name:form.elements.name.value.trim(),supportPhone:form.elements.supportPhone.value.trim()||null})});if(!profile||typeof profile.name!=='string')throw Object.assign(new Error(),{code:'COMPANY_PROFILE_SAVE_UNCONFIRMED'});const settings=await request('/admin/company',{method:'PUT',body:JSON.stringify({timeZone:form.elements.timeZone.value})});if(settings?.timeZone!==form.elements.timeZone.value)throw Object.assign(new Error(),{code:'COMPANY_SETTINGS_SAVE_UNCONFIRMED'});if(address!==(companySnapshot.operationalLocation?.address||null)){const location=await request('/admin/company/location',{method:'PUT',body:JSON.stringify({expectedVersion:companySnapshot.operationalLocationVersion,address,latitude:null,longitude:null})});if(!location||!Object.prototype.hasOwnProperty.call(location,'operationalLocation'))throw Object.assign(new Error(),{code:'COMPANY_LOCATION_SAVE_UNCONFIRMED'})}form.dataset.dirty='';status.textContent='Configuração confirmada pelo servidor.';await loadAdmin()}
    catch(error){form.dataset.dirty='';const text=message(error);await loadAdmin().catch(()=>{});status.textContent=text}finally{setBusy(form,false)}
  });
  $('[data-company-setup]')?.addEventListener('input',event=>{if(event.target?.form===event.currentTarget)event.currentTarget.dataset.dirty='true'});
  $('[data-company-setup]')?.addEventListener('change',event=>{if(event.target?.form===event.currentTarget)event.currentTarget.dataset.dirty='true'});
  $('[data-invite]')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()||form.dataset.submitting==='true') return; setBusy(form, true);form.dataset.submitting='true';
    const result=$('[data-invite-result]'),feedback=adminPage.querySelector('[data-team-feedback]');let saved=false;let invitedMembershipId=null;
    try { const response=await request('/admin/invitations', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value.trim(), roleId: form.elements.roleId.value }) });if(typeof response?.membershipId!=='string'||response.delivery!=='sent')throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});invitedMembershipId=response.membershipId;saved=true;form.reset();if(feedback)feedback.textContent='Convite enviado e confirmado pelo servidor.'; }
    catch (error) { result.hidden=false;result.textContent = message(error); }
    finally { setBusy(form, false);delete form.dataset.submitting;if(saved){result.textContent='';result.hidden=true;markAdminFormSaved(form);try{const refreshed=await loadAdmin();if(!refreshed?.members?.members?.some(member=>member.membershipId===invitedMembershipId))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});}catch(error){if(feedback)feedback.textContent=`Convite enviado, mas a lista não pôde ser confirmada: ${message(error)}`}} }
  });
  $('[data-create-role]')?.addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity()||form.dataset.submitting==='true') return; setBusy(form, true);form.dataset.submitting='true';
    const result=$('[data-role-result]'),feedback=adminPage.querySelector('[data-team-feedback]');let saved=false;
    let createdId=null;const permissions = [...form.querySelectorAll('[data-permissions] input:checked')].map(input => input.value);
    try { const response=await request('/admin/roles', { method: 'POST', body: JSON.stringify({ name: form.elements.name.value.trim(), description:form.elements.description.value.trim(), permissions }) });if(typeof response?.id!=='string'||!Array.isArray(response.permissions))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});createdId=response.id;saved=true;form.reset();if(feedback)feedback.textContent='Perfil criado e confirmado pelo servidor.'; }
    catch (error) { result.hidden=false;result.textContent = message(error); }
    finally { setBusy(form, false);delete form.dataset.submitting;if(saved){result.textContent='';result.hidden=true;markAdminFormSaved(form);try{const refreshed=await loadAdmin();const role=refreshed?.roles?.roles?.find(item=>item.id===createdId);if(!role||JSON.stringify([...role.permissions].sort())!==JSON.stringify([...permissions].sort()))throw Object.assign(new Error(),{code:'INVALID_RESPONSE'});}catch(error){if(feedback)feedback.textContent=`Perfil criado, mas a lista não pôde ser confirmada: ${message(error)}`}} }
  });
  window.addEventListener('online', async () => { if (!current && !offlineMode) { const session = await restore(); if (session) await syncAfterAuthentication(); } else if (current) await syncAfterAuthentication(); });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !current) return;
    const session = await restore();
    if (session && !mfaLocked) await syncAfterAuthentication();
  });
  window.addEventListener('rotamoto:session-expired', expireSession);
  const initialAppRoot = document.querySelector('#app'); if (initialAppRoot) { initialAppRoot.hidden = true; initialAppRoot.inert = true; initialAppRoot.setAttribute('aria-hidden', 'true'); }
  offlineMode = false; host.dataset.gated = 'true'; trigger.hidden = true; updateTriggerLabel(); setStatus('Verificando sua sessão…'); setOpen(false); restore().then(async session => { if (session) { if (mfaLocked) setOpen(true); else { panel.hidden = true; await syncAfterAuthentication(); } } else { panel.hidden = false; setOpen(true); } }).catch(() => { panel.hidden = false; setOpen(true); });
  const appRoot = document.querySelector('#app');
  if (appRoot) new MutationObserver(placeTrigger).observe(appRoot, { childList: true, subtree: true });
  window.RotaMotoIdentity = Object.freeze({ restore, getSession: () => current, isOfflineMode: () => offlineMode });
})();
