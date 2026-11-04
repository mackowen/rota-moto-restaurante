'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const uiPath = path.join(__dirname, '..', 'identity-ui.js');
const assetManifest = require('./helpers/asset-manifest').readAssetManifest();
const htmlPath = path.join(__dirname, '..', 'index.html');
const source = fs.readFileSync(uiPath, 'utf8');
assert.match(source, /INVALID_TOKEN:\s*'Este código não é válido, expirou ou já foi usado/u,
  'expired or already consumed invitation tokens receive clear, non-technical feedback');
const adminDialogSource = fs.readFileSync(path.join(__dirname, '..', 'admin-form-dialog.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
assert.match(appSource, /Situação do cadastro<select class="select" name="status">/u,
  'Driver edit presents its administrative status separately from operational availability');
assert.match(appSource, /Email de contato<input class="input" name="email" type="email"[\s\S]*?não altera identidade, convite ou vínculo/u,
  'Driver contact email remains operational data and does not imply an identity or membership edit');
assert.match(appSource, /value="ACTIVE"[^>]*>Ativo/u, 'Driver can be administratively activated');
assert.match(appSource, /value="DISABLED"[^>]*>Inativo — acesso operacional bloqueado/u,
  'Driver deactivation is explicit and described as blocking operational access');
assert.doesNotMatch(appSource, /name="status">\$\{\['DISPONÍVEL','EM ROTA','CHEGOU','OFFLINE'\]/u,
  'operational presence values are not offered as Driver administrative statuses');
const html = fs.readFileSync(htmlPath, 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'identity-ui.css'), 'utf8');
const appStyles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.match(html, /identity-session-guard\.js[\s\S]*?app\.js/u, 'shared session/CSRF guard loads before the sync client');
assert.match(html, /<div id="app" hidden inert aria-hidden="true">/u, 'the operational app starts inert before identity/session authorization resolves');

assert.match(source, /autocomplete="current-password"/u);
assert.match(source, /data-login-presentation aria-labelledby="rm-login-heading"/u, 'unauthenticated login includes the desktop presentation region');
assert.match(source, /Gestão completa de entregas para o seu restaurante/u, 'login copy follows the approved composition');
assert.match(source, /data-login-mobile-brand/u, 'mobile login has a compact brand treatment');
assert.match(source, /data-toggle-password/u, 'password visibility is a real accessible control');
assert.match(source, /autocomplete="username"/u, 'email uses the username autocomplete contract');
assert.doesNotMatch(source.match(/<form data-login[\s\S]*?<\/form>/u)?.[0] || '', /name="companyId"/u,
  'email and password login does not require or submit a tenant identifier');
assert.match(source, /data-login-context[\s\S]*Onde deseja continuar\?[\s\S]*platformAdmin/u,
  'multi-company and global-admin contexts are selected by a post-authentication prompt');
assert.match(source, /código \$\{shortCodes\[index\]\.slice\(-codeLength\)\}/u,
  'companies with duplicate names receive a distinguishable, user-facing short code');
assert.doesNotMatch(source, /hintedCompany\(\)|data-login\] \[name=companyId\]|localStorage\.getItem\(['"]rotaMoto\.activeCompanyHint/u,
  'login does not restore tenant context from browser storage');
assert.match(source, /data-recovery-request/u, 'the existing access recovery flow remains present');
assert.match(source, /data-accept-invitation/u, 'the existing invitation flow remains present');
assert.match(source, /data-recovery-choice="request-code"[\s\S]*data-recovery-choice="reset-password"[\s\S]*data-recovery-choice="recover-mfa"/u,
  'recovery is presented as three mutually exclusive navigation options');
assert.match(source, /function setRecoveryStep\(step[\s\S]*screen\.hidden = screen\.dataset\.recoveryScreen !== recoveryStep/u,
  'only the selected recovery form screen is visible');
assert.match(source, /function setAuthView\(view[\s\S]*authView !== 'login'[\s\S]*authView !== 'recovery'[\s\S]*authView !== 'invitation'/u,
  'login, recovery and invitation are switched as exclusive authentication views');
assert.match(source, /data-recovery-back[\s\S]*Voltar ao login/u, 'recovery provides a contextual back action to the login');
assert.match(source, /data-invitation-back[\s\S]*Voltar ao login/u, 'invitation provides a contextual back action to the login');
assert.doesNotMatch(source, /<details data-recovery>|<details data-invitation>|<details><summary>Perdi o autenticador/u,
  'unauthenticated recovery and invitation do not use nested disclosure cards');
assert.match(source, /setAuthView\('recovery',false\);setOpen\(true\)/u, 'email recovery links open the matching recovery view without changing token validation');
assert.match(source, /setAuthView\('invitation',false\);setOpen\(true\)/u, 'invitation links open the single invitation view');
assert.match(source, /working \|\| !form\.reportValidity\(\)/u, 'recovery and invitation submissions guard against duplicate requests');
assert.match(source, /Se a conta puder ser recuperada, as instruções serão entregues ao email cadastrado\./u,
  'password recovery retains a neutral response that does not reveal account existence');
assert.match(styles, /\.rm-auth-flow \{[\s\S]*?border: 1px solid var\(--rm-id-border\)/u, 'secondary authentication flows use one outer surface');
assert.match(styles, /\.rm-auth-flow-screen form \{[\s\S]*?padding: 0; border: 0/u, 'forms inside recovery do not create nested cards');
assert.doesNotMatch(source, /name="rememberMe"|data-remember-me|localStorage\.setItem\([^\n]*password/iu, 'login does not introduce insecure remembered credentials');
assert.match(styles, /#rmIdentityRoot\[data-gated="true"\][\s\S]*?grid-template-columns: minmax\(0, 1\.08fr\) minmax\(360px, \.92fr\)/u, 'desktop login uses a two-region composition');
assert.match(styles, /@media \(max-width: 860px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/u, 'tablet login stacks presentation and form only when the effective layout width cannot support both columns');
assert.match(styles, /grid-template-rows: auto;[\s\S]*?align-content: start;/u, 'desktop login grows as one row and keeps secondary actions reachable through the page scroll');
assert.match(styles, /#rmIdentityRoot\[data-gated="true"\] \.rm-identity-content \{[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/u, 'desktop login does not create a nested scroll area for the form and secondary actions');
assert.match(styles, /@media \(max-width: 600px\)[\s\S]*?\.rm-login-presentation \{ display: none; \}/u, 'mobile login prioritizes the form and hides promotional presentation');
assert.match(styles, /@media \(orientation: landscape\) and \(max-height: 500px\)[\s\S]*?\.rm-login-presentation \{ display: none; \}/u, 'short mobile landscape login prioritizes the form');
assert.match(styles, /env\(safe-area-inset-(?:top|right|bottom|left)\)/u, 'login gutters respect device safe areas');
assert.match(source, /autocomplete="one-time-code"/u);
assert.match(source, /data-mfa-qr width="208" height="208"/u, 'TOTP enrollment includes an accessible local QR target');
assert.match(source, /renderMfaQr\(result\.otpauthUri\)/u, 'the enrollment URI is rendered by the bundled offline QR encoder');
assert.match(source, /data-mfa-start-status role="alert" aria-live="assertive"/u, 'enrollment errors are announced outside the initially hidden confirmation form');
assert.match(source, /!companyForm\.dataset\.dirty/u, 'fresh server company data refreshes a form unless the user is editing it');
assert.match(source, /Configuração confirmada pelo servidor/u, 'company save feedback is tied to server response validation');
assert.match(source, /freshStatus\.textContent=message\(error\)/u, 'provider refresh reports errors in the newly rendered accessible page');
assert.match(source, /refreshProvider\.dataset\.providerRefresh=providerCode/u, 'provider refresh controls remain identifiable after a server snapshot reload');
assert.match(source, /actionArea\.replaceChildren\(\)/u, 'starting a provider connection replaces prior instructions instead of stacking them');
assert.match(source, /actionArea\.replaceChildren\(note\)/u, 'provider connection failures reuse a single visible message area');
assert.match(appSource, /Email de contato \(opcional\)/u, 'driver registration can retain a contact email for an explicit later invitation');
assert.match(appSource, /O convite ainda não foi enviado/u, 'adding a driver never implies that an invitation was sent');
assert.match(source, /CSRF_INVALID: 'A sessão de segurança foi renovada/u, 'a failed CSRF refresh gives a visible recovery instruction');
assert.match(source, /if\(mfaStarting\)return/u, 'duplicate enrollment clicks are ignored while the request is pending');
assert.match(source, /serverUpdateBus\.publish\(topic\)/u, 'confirmed administrative mutations announce only a safe refresh category to other tabs');
assert.match(source, /serverUpdateBus\.subscribe\(\(\{ topic \}\)/u, 'open administrative pages reload authoritative server snapshots after cross-tab changes');
assert.match(appSource, /companyAdminSettingsMount/u, 'company administration mounts inside Settings instead of a fixed overlay');
assert.match(appSource, /body\.timeZone[\s\S]*body\.operationalLocation[\s\S]*restaurantAddress/u, 'the single Empresa page reads timezone and address from the canonical company endpoint');
assert.match(appSource, /companyProfileDraftDirty[\s\S]*companyAddressDraftDirty/u, 'late server responses preserve fields the user has started editing');
assert.match(appSource, /Object\.assign\(new Error\(body\.error\?\.code\|\|'COMPANY_READ_FAILED'\),\{status:response\.status\}\)/u, 'company read failures retain HTTP status for distinct 401 and 403 messages');
assert.match(appSource, /if\(generation!==companyProfileLoadGeneration\|\|companyId!==syncSession\?\.companyId\)return;[\s\S]*?companyProfileDraftDirty/u, 'stale asynchronous company responses cannot overwrite the active form');
assert.match(appSource, /finally\{if\(generation===companyProfileLoadGeneration\)/u, 'only the current company request can re-enable its form controls');
assert.match(source, /root\.querySelector\(selector\) \|\| \(root === host \? document\.querySelector\(selector\) : null\)/u, 'identity operations continue resolving controls after their page moves into the application shell');
assert.match(source, /const mfaQrCanvas = \$\('\[data-mfa-qr\]'\)[\s\S]*const mfaSecretInput = \$\('\[data-mfa-secret\]'\)/u, 'MFA cleanup retains references before the account page can be detached');
assert.match(source, /function clearMfaEnrollment\(\)\{const canvas=mfaQrCanvas[\s\S]*if\(mfaSecretInput\)mfaSecretInput\.value=''/u, 'closing an account page cannot throw while clearing detached enrollment controls');
assert.match(source, /rotamoto:settings-page/u, 'administration navigation uses the application settings route');
assert.match(source, /class="rm-account-trigger" data-account-security/u,
  'the top-bar account trigger carries the marker consumed by the delegated account-opening handler');
assert.doesNotMatch(source, /\$\('\.rm-account-trigger'\)\?\.addEventListener\('click',\s*\(\)\s*=>\s*\{\}\)/u,
  'the account trigger has no placeholder click handler that can mask a missing navigation contract');
assert.match(source, /const accountTrigger = event\.target\?\.closest\?\.\('\[data-account-security\]'\)[\s\S]*?setOpen\(true, accountTrigger\)/u,
  'an unauthenticated trigger opens the identity panel and retains its focus target');
assert.match(source, /if \(current && !mfaLocked\) \{\s*if \(appKind === 'restaurante'\) document\.dispatchEvent\(new CustomEvent\('rotamoto:open-account-settings'\)\);\s*else openAccountPageOverlay\(accountTrigger\)/u,
  'an authenticated account trigger opens the account settings surface in both applications');
assert.match(source, /trigger\.setAttribute\('aria-controls', opensAccountPage \? 'rmAccountSettingsPage' : 'rmIdentityPanel'\)/u,
  'the top-bar trigger identifies the destination it controls');
assert.match(source, /function setOpen\(open, returnFocusTarget = null\)[\s\S]*?previousFocus = returnFocusTarget\?\.isConnected \? returnFocusTarget : document\.activeElement/u,
  'touch activation remembers the invoking control even when the browser does not focus it');
assert.match(appSource, /rotamoto:open-account-settings[\s\S]*?state\.settingsOpen='seguranca'[\s\S]*?requestAnimationFrame\(\(\)=>document\.querySelector\('#rmAccountSettingsPage h2'\)\?\.focus\(\)\)/u,
  'account navigation opens the dedicated settings page and moves focus to its heading');
const accountNavigation = appSource.match(/document\.addEventListener\('rotamoto:open-account-settings',([\s\S]*?)\);document\.addEventListener\('rotamoto:navigate-settings'/u)?.[1] || '';
assert.equal((accountNavigation.match(/history\.pushState/g) || []).length, 2, 'closing Conta returns to the route that was active before opening it, without an intermediate settings-grid history entry');
assert.match(source, /async function syncAfterAuthentication\(\{ onAppReady \} = \{\}\)[\s\S]*?if \(appKind === 'restaurante'\)[\s\S]*?onAppReady\?\.\(\)[\s\S]*?syncNow/u,
  'Restaurant login can leave the identity panel as soon as the authenticated app is ready, before remote sync finishes');
assert.match(source, /window\.addEventListener\('rotamoto:app-ready'/u,
  'identity waits on the same window event target used by authenticated app bootstrap');
assert.match(appSource, /window\.dispatchEvent\(new CustomEvent\('rotamoto:app-ready'/u,
  'authenticated app bootstrap publishes readiness on window');
assert.match(source, /if\(session\.mfaEnrollmentRequired\)[\s\S]*?await syncAfterAuthentication\(\{onAppReady:\(\)=>setOpen\(false\)\}\)/u,
  'a valid login closes Conta only after app bootstrap and does not wait for sync completion');
assert.doesNotMatch(source, /await syncAfterAuthentication\(\);setOpen\(false\)/u,
  'closing the login panel is not coupled to completion of the entire synchronization');
assert.match(source, /document\.addEventListener\('rotamoto:settings-page',[\s\S]*?loadAdmin\(\)/u, 'each company settings page loads its server snapshot from the single navigation');
assert.match(appSource, /settings-cards[\s\S]*?settings-card/u, 'all Ajustes categories render as selectable cards on mobile and desktop');
assert.match(appSource,/identitySession\)cats\.push\(\['platform-admin',platformAdmin\?'Super ADM Global'/u,'authenticated server identity sees a clear global-admin status separate from company settings');
assert.match(appSource,/Sem acesso de Super ADM Global[\s\S]*?administração empresarial não concede privilégios globais/u,'company ownership is not presented as global administration');
assert.match(source,/aria-label', 'Administração global'[\s\S]*?data-platform-list="companies"/u,'global administration is mounted below the single application topbar');
assert.doesNotMatch(source,/platformAdminPage\.innerHTML\s*=\s*'<header/u,'global admin does not render a second page header');
assert.match(appSource,/settings-back-action" data-settings-back aria-label="Voltar para Ajustes"/u,'settings return is integrated into the application topbar');
assert.doesNotMatch(appSource.match(/function settings\(\)[\s\S]*?\nfunction backupCenter/u)?.[0]||'',/class="settings-back"/u,'settings categories do not place a detached return row above the topbar');
assert.match(appSource,/'company-admin-team':'Equipe e permissões'/u,'team settings use a context-specific topbar title');
assert.match(appSource,/return header\(title,[\s\S]*section==='seguranca'\?'Ajustes':undefined\)/u,
  'Account uses the Ajustes topbar context while keeping its own page heading');
assert.match(appSource,/'system-admin':'Sistema local'/u,'local system settings use a context-specific topbar title');
assert.match(adminDialogSource,/function create\([\s\S]*?aria-modal[\s\S]*?aria-labelledby[\s\S]*?dialog\.showModal\(\)/u,'administrative forms use an accessible native modal with managed focus');
assert.match(adminDialogSource,/Há alterações não salvas[\s\S]*?dialog\.addEventListener\('cancel'/u,'Escape and explicit close protect unsaved administrative form edits');
assert.match(source,/source:invite\.closest\('details'\)[\s\S]*?triggerLabel:'Convidar pessoa'/u,'the supported user-creation flow is presented as an invitation modal');
assert.match(source,/const canInvite = Boolean\(session\?\.permissions\?\.includes\('members\.invite'\)\)[\s\S]*?inviteTrigger\.hidden = !canInvite/u,'invitation trigger visibility follows the effective invite permission');
assert.match(source,/source:createRole\.closest\('details'\)[\s\S]*?triggerLabel:'Criar perfil'/u,'role creation is presented in the shared administrative modal');
assert.match(source,/window\.RotaMotoAdminFormDialog\.create\(\{source:editorSource,form:editForm/u,'role editing uses the same modal component as invitations');
assert.match(styles,/\.rm-admin-form-dialog__body \{[^}]*overflow:auto/u,'long administrative forms scroll independently within the dialog');
assert.match(styles,/\.rm-admin-form-dialog__actions \{[^}]*safe-area-inset-bottom/u,'dialog actions respect the mobile safe area');
assert.match(appSource, /data-settings-back/u, 'each Ajustes category page has a clear return to the card grid');
const adminDialogAsset = html.match(/admin-form-dialog\.js\?v=[^"']+/u)?.[0];
assert(adminDialogAsset && html.indexOf(adminDialogAsset) < html.indexOf('identity-ui.js?'), 'admin dialog component loads before the identity UI');
assert.match(appSource, /data-settings-open.*?history\.pushState\(\{rotamotoView:true,tab:state\.tab,settingsOpen:state\.settingsOpen\|\|''\}.*?history\.pushState\(\{rotamotoView:true,tab:state\.tab,settingsOpen:next\}/u, 'opening a settings category records both the previous view and active route for reliable back navigation');
assert.match(appSource, /data-settings-back[\s\S]*?history\.state\.settingsOpen===state\.settingsOpen/u, 'the integrated topbar back control only uses browser history for its matching settings route');
assert.match(appStyles, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u, 'the mobile Ajustes card grid uses two columns when space permits');
assert.doesNotMatch(source, /adminParent = app\?\.querySelector\('\.top-actions'\)/u, 'company administration is never injected into the top bar');
assert.match(styles, /#rmCompanyAdminPage,\s*#rmPlatformAdminPage \{\s*position: static/u, 'administrative pages stay in normal Settings document flow');
assert.match(styles, /\.rm-admin-subpage\[hidden\] \{ display:none !important; \}/u, 'inactive administrative pages respect their hidden state despite grid layout');
assert.match(source, /QR Code indisponível; a chave manual continua disponível/u, 'QR rendering failure preserves an actionable manual enrollment path');
const identityAsset = html.match(/identity-ui\.js\?v=[^"']+/u)?.[0];
assert(identityAsset, 'identity UI bundle has a cache busting version');
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
assert.match(sw, /CACHE_NAME = self\.RotaMotoAssetManifest\.cacheName/u, 'service worker derives its cache key from the generated asset manifest');
assert(assetManifest.assets.includes(`./${identityAsset}`), 'current identity UI asset is included in the offline shell');
assert.match(assetManifest.cacheName, new RegExp(`^${assetManifest.cachePrefix}[a-f0-9]{16}$`, 'u'));
assert.match(html, /identity-ui\.css\?v=[a-f0-9]{16}/u, 'updated recovery flow CSS uses a content revision');
assert.match(html, /identity-ui\.js\?v=[a-f0-9]{16}/u, 'updated recovery navigation uses a content revision');
assert.doesNotMatch(html, /<script[^>]+rotamoto-map-runtime/u, 'heavy cartography runtime is not loaded before authentication');
assert.doesNotMatch(sw.split('const OPTIONAL_ASSETS')[0], /rotamoto-map-runtime|maplibre-gl-worker/u, 'large map runtime and worker are not precached with the login shell');
assert.match(appSource, /function ensureMapRuntime\(\)[\s\S]*rotamoto-map-runtime\.js[\s\S]*?function initRouteMap\(\)[\s\S]*await ensureMapRuntime\(\)/u, 'map runtime loads on demand before route map initialization');
assert.match(source, /function clearMfaEnrollment[\s\S]{0,180}clearRect/u, 'closing or completing enrollment clears QR pixels');
assert(html.indexOf('qr-local.js') >= 0 && html.indexOf('qr-local.js') < html.indexOf('identity-ui.js'),
  'offline QR encoder loads before identity UI');
const qrWindow = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'qr-local.js'), 'utf8'), { window: qrWindow });
const qr = new qrWindow.RotaMotoQRCode(0, qrWindow.RotaMotoQRErrorCorrectLevel.M);
qr.addData('otpauth://totp/RotaMoto:qa%40example.invalid?secret=synthetic'); qr.make();
const qrModules = qr.getModuleCount(); let qrDarkModules = 0;
for (let row = 0; row < qrModules; row += 1) for (let column = 0; column < qrModules; column += 1)
  if (qr.isDark(row, column)) qrDarkModules += 1;
assert(qrModules >= 21 && qrDarkModules > 0 && qrDarkModules < qrModules ** 2, 'offline TOTP QR encoder creates a nonempty matrix');
assert.match(source, /credentials: 'include'/u, 'identity uses the protected cookie session');
assert.match(source, /X-CSRF-Token/u);
assert.match(source, /\/identity\/session/u);
assert.match(source, /\/identity\/recovery\/consume/u);
assert.match(source, /\/identity\/membership-invitations\/accept/u);
assert.match(source, /\/admin\/memberships/u);
assert.match(source, /\/admin\/roles/u);
assert.match(source, /\/admin\/invitations/u);
assert.match(source, /members\.invite/u, 'invitation controls are gated by the effective permission');
assert.match(source, /canReadMembers/u, 'membership data is fetched only with its read permission');
assert.match(source, /memberships\/\$\{member\.membershipId\}\/driver/u, 'administrators use the tenant-scoped membership-to-driver endpoints');
assert.match(source, /O convite cria ou associa uma conta pelo email[\s\S]*?cadastro operacional correto de motoboy/u, 'the admin UI explains the identity invitation and operational Driver registration are separate');
assert.match(source, /código técnico é gerado automaticamente/u, 'role creation does not require a user-generated identifier');
assert.match(source, /data-permissions/u, 'role permissions retain the server permission catalog');
assert.match(appSource, /Controles locais deste aparelho/u, 'local users and profiles are clearly scoped to this browser');
assert.match(source, /Reenviar convite/u, 'pending invitations can be resent through the existing identity invitation service');
assert.match(source, /Revogar convite/u, 'pending invitations can be revoked through audited membership status changes');
assert.match(source, /normalizedStatus=value=>String\(value\|\|''\)\.normalize\('NFD'\)[\s\S]*?linkableStatuses\.has\(normalizedStatus\(driver\.record\?\.status\)\)/u,
  'Driver status labels normalize canonical status casing and accents before reporting access');
assert.match(source, /const linkableStatuses=new Set\(\['ACTIVE','AVAILABLE','DISPONIVEL','EM ROTA','CHEGOU','IN ROUTE','ARRIVED'[\s\S]*?'OFFLINE','UNAVAILABLE','INDISPONIVEL','BUSY','OCUPADO','PAUSED','PAUSADO'\]\)/u,
  'Driver UI authorization status vocabulary stays aligned with the backend access allowlist');
assert.match(source, /Convites para acompanhar: \$\{pendingInvitations\.length\}/u, 'pending and expired invitations are counted independently from team members');
assert.match(source, /members\.members\.filter\(member=>member\.status==='invited'\)/u, 'invitation records are rendered in a separate team section');
assert.match(source, /member\.status === 'suspended' \? 'Acesso suspenso'[\s\S]*member\.status === 'revoked' \? 'Vínculo encerrado'/u, 'suspended and revoked membership states remain distinct');
assert.match(source, /data-team-member-count/u, 'the team overview reports the authorized active member count');
assert.match(source, /data-team-invitations/u, 'pending invitations have their own list and empty state');
assert.match(source, /Função salva, mas a lista não pôde ser confirmada/u, 'membership edits distinguish server ACK from failed canonical readback');
assert.match(source, /Novo convite enviado\. O anterior deixou de ser válido\./u, 'resend action reports the API-confirmed delivery result');
assert.match(source, /response\.delivery!=='sent'/u, 'invitation creation requires a server delivery acknowledgement');
assert.match(source, /Date\.parse\(member\.invitationExpiresAt\|\|''\)[\s\S]*Convite expirado · reenvie para emitir outro/u,
  'expired invitations are distinguished from active and unavailable invitation links');
assert.doesNotMatch(source, /Aguardando vínculo operacional/u, 'identity UI no longer implies that an owner company membership is an awaiting operational association');
assert.match(appSource, /company-admin-team[\s\S]*?company-admin-drivers[\s\S]*?company-admin-integrations/u, 'team, drivers and integrations are first-class Ajustes categories');
assert.match(source, /Gerencie quem tem acesso a esta empresa, os convites e os perfis autorizados/u, 'team page retains concise context under the single topbar title');
assert.match(source, /Perfis e permissões/u, 'roles and permissions are presented in their own section');
assert.match(source, /rm-team-disclosure rm-team-member-disclosure/u, 'member details are compact and expandable');
assert.match(source, /rm-team-disclosure rm-team-role-disclosure/u, 'permission details are compact and expandable by profile');
assert.match(styles, /\.rm-team-summary\s*\{[^}]*display:flex/su, 'team counts use a compact responsive summary');
assert.doesNotMatch(source, /data-admin-close|data-platform-close/u, 'administrative pages do not add redundant return-to-settings controls');
assert.doesNotMatch(source, /data-admin-page="/u, 'company pages do not duplicate category navigation inside the content');
assert.match(source, /dataset\.providerPage[\s\S]*?dataset\.providerTab/u, 'delivery platform configuration and received orders have separate provider pages');
assert.match(source, /textContent='Detalhes técnicos'/u, 'protocol capability details stay behind an optional disclosure');
assert.match(source, /operationLabels=\{CONFIRM:'Confirmação do pedido'/u, 'provider operation states use clear Portuguese labels');
assert.match(source, /A atualização não foi concluída\. Tente novamente ou peça ajuda ao suporte da empresa\./u, 'provider command errors have a user-facing explanation');
assert.match(source, /summary\.textContent='Código para suporte'/u, 'technical provider error identifiers stay in an optional disclosure');
assert.doesNotMatch(source, /\$\{order\.lastErrorCode\?` \(\$\{order\.lastErrorCode\}\)`/u, 'raw provider error codes are not included in ordinary status text');
assert.match(source, /function appendPermissionOptions\([\s\S]*groupNames[\s\S]*permission\.description/u, 'role permissions are grouped and described in plain language while retaining internal keys');
assert.match(source, /Não delegável pelo seu perfil/u, 'permissions outside the actor grant ceiling remain visible and explicitly non-delegable');
assert.match(source, /Concedida neste perfil/u, 'granted permission state is explicit in the profile editor');
assert.match(source, /Não concedida/u, 'denied permission state is explicit in the profile editor');
assert.match(source, /Super ADM Global é um acesso da plataforma/u, 'global platform authority is identified as not applicable to tenant role delegation');
assert.match(styles, /\.rm-permission-copy \{ display:grid/u, 'permission descriptions and state fit the responsive option layout');
assert.match(source, /finance: 'Financeiro'/u, 'financial permissions have a dedicated category in role settings');
assert.match(source, /Consultar relatórios e registros financeiros da empresa/u, 'financial read access is described in restaurant language');
assert.match(source, /Gerenciar operações financeiras da empresa/u, 'financial management access is described in restaurant language');
assert.match(source, /roles\/owner\/restore-finance/u, 'only the active owner receives an explicit tenant-scoped recovery action for missing finance permissions');
assert.match(source, /Este perfil é protegido para preservar os acessos essenciais/u, 'essential owner permissions remain protected from generic role edits');
assert.match(source, /result\?\.id!==role\.id\|\|!Array\.isArray\(result\.permissions\)/u, 'role writes require a valid API acknowledgement');
assert.match(source, /Perfil atualizado e confirmado na lista do servidor/u, 'role changes require canonical readback before success feedback');
assert.match(adminDialogSource, /Confirmação para descartar alterações/u, 'unsaved edits use an inline discard confirmation in the same dialog');
assert.match(adminDialogSource, /Continuar editando/u, 'the inline discard prompt preserves a path back to the form');
assert.match(adminDialogSource, /aria-haspopup','dialog'/u, 'dialog triggers identify their popup semantics');
assert.doesNotMatch(adminDialogSource, /RotaMotoDialog\?\.confirm/u, 'discard confirmation does not open a nested dialog');
assert.match(styles, /\.rm-admin-form-dialog__actions\[hidden\]\s*\{\s*display:none !important/u,
  'a dirty-form discard prompt cannot leave the primary dialog actions visible behind it');
assert.match(source, /Atualizar situação no RotaMoto/u, 'provider state refresh is distinct from an external connection test');
assert.match(source, /RotaMotoDialog\.confirm\(\{title:'Desconectar loja\?',message:'O recebimento de pedidos será interrompido\. Esta ação não revoga a autorização no portal da plataforma\.'/u, 'provider disconnection uses the accessible custom confirmation and keeps the portal authorization boundary explicit');
assert.match(styles, /\.rm-provider-nav/u, 'provider navigation remains touch friendly and horizontally scrollable');
assert.match(source, /sections\.get\('drivers'\)[\s\S]*?driverMembers/u, 'driver links have a dedicated administration page');
assert.match(source, /rotamoto:settings-page/u, 'company administration is reached through the existing settings navigation');
assert.doesNotMatch(source, /data-sync/u, 'the account panel contains no operational synchronization action');
assert.match(source, /adminPage\.hidden = true/u, 'company administration starts hidden and is revealed only inside its authorized Settings mount');
assert.match(source, /const canManageCompany=Boolean\(current&&appKind==='restaurante'&&!mfaLocked&&current\.permissions\?\.includes\('company\.manage'\)\)/u, 'company administration requires a live authorized session and is withheld during MFA');
assert.match(source, /role="main" aria-labelledby="rmIdentityTitle"/u, 'unauthenticated access is a dedicated full-page authentication screen');
assert.match(source, /rotamoto:auth-ready[\s\S]*rotamoto:auth-revoked/u, 'the app mounts only after a valid session and unmounts when authorization is lost');
assert.match(appSource, /window\.addEventListener\('rotamoto:auth-ready',startAuthenticatedApp\)/u, 'operational bootstrap waits for identity authorization');
assert.match(appSource, /window\.addEventListener\('rotamoto:auth-revoked',[\s\S]*root\.replaceChildren\(\)/u, 'logout and expiry remove operational UI from the DOM');
assert.match(source, /rmAccountSettingsPage/u, 'account management has a dedicated page mounted under Ajustes');
const accountMarkup = source.match(/accountPage\.innerHTML = `([\s\S]*?)`;/u)?.[1] || '';
assert(accountMarkup, 'account settings overview has a dedicated semantic template');
assert.match(accountMarkup, /data-account-overview[\s\S]*Minha conta[\s\S]*aria-labelledby="rmAccountSecurityTitle"[\s\S]*Segurança[\s\S]*data-account-open="password"[\s\S]*data-account-open="mfa"[\s\S]*data-account-open="recovery-codes"[\s\S]*aria-labelledby="rmAccountAccessTitle"[\s\S]*Empresas e acesso[\s\S]*data-account-open="companies"[\s\S]*data-account-open="invitation"[\s\S]*data-account-open="logout"/u,
  'the compact overview groups security, company access and session actions');
assert.equal((accountMarkup.match(/class="rm-account-setting-row(?: rm-account-setting-row--session)?"/gu) || []).length, 6,
  'every existing account operation remains a full-row button');
assert.match(accountMarkup, /data-account-open="mfa"[\s\S]*aria-haspopup="dialog"[\s\S]*data-account-mfa-summary/u,
  'the MFA row exposes its live status and opens the existing accessible dialog');
assert.match(accountMarkup, /rm-account-setting-row--session[\s\S]*data-account-open="logout"/u,
  'logout remains visually separated as its own session action');
assert.doesNotMatch(accountMarkup, /rm-account-settings-card|<article\b/u,
  'the overview no longer uses tall nested setting cards');
assert.doesNotMatch(accountMarkup, /<form\b/u, 'operational forms are not rendered on the account overview');
assert.match(styles, /\.rm-account-settings-page \.rm-account-setting-row\s*\{[^}]*min-height:\s*58px/su,
  'compact setting rows retain comfortable mobile touch targets');
assert.match(styles, /\.rm-account-setting-row:focus-visible|\.rm-account-settings-page button:focus-visible/u,
  'the compact settings rows retain a visible keyboard focus treatment');
assert.match(styles, /\.rm-account-setting-icon\s*\{[^}]*background:\s*var\(--accent-soft,\s*var\(--accent-bg/u,
  'account row icons follow the application accent token in both themes');
assert.match(styles, /\.rm-account-setting-title\s*\{\s*color:\s*var\(--rm-id-text\)/u,
  'setting titles use the semantic text color rather than relying on native button defaults');
assert.match(accountMarkup, /<dialog[^>]*data-account-dialog[^>]*aria-modal="true"[^>]*aria-labelledby/u, 'account actions use a single accessible modal dialog');
assert.equal((accountMarkup.match(/data-account-panel="/gu) || []).length, 6, 'dialog content is divided into exclusive action panels');
assert.match(source, /accountPanelContent\('password'\)\?\.append\(passwordChangeForm\)/u, 'password form is mounted only in its own action panel');
assert.match(source, /accountPanelContent\('mfa'\)\?\.append\(mfaSection\)/u, 'MFA controls are mounted only in their action panel');
assert.match(source, /accountPanelContent\('companies'\)\?\.append\(switchForm\)/u, 'company switching is separated into the company management panel');
assert.match(accountMarkup, /data-account-companies-state[\s\S]*data-account-companies-list[\s\S]*data-account-companies-retry/u, 'linked-company management has explicit loading, content, and retry regions');
assert.match(source, /<form data-switch hidden>[\s\S]*<select name="companyId"/u, 'company switching starts hidden and can select only server-provided memberships');
assert.match(source, /async function loadLinkedCompanies[\s\S]*request\('\/identity\/companies'\)[\s\S]*renderLinkedCompanies/u, 'linked companies come from the authenticated backend contract');
assert.match(source, /Esta conta tem somente uma empresa vinculada; não há outra para trocar/u, 'one-company accounts are told clearly that switching is unavailable');
assert.match(source, /Registro empresarial[\s\S]*Identificador: \$\{company\.companyId\}/u, 'technical company identifiers appear only in a collapsed details section');
assert.match(source, /const pendingAction = mfaStarting[\s\S]*activeForm\?\.dataset\.saving/u, 'account dialog closure is gated by the active account operation rather than unrelated sync work');
assert.match(source, /function syncAccountDialogActions[\s\S]*pendingEnrollment[\s\S]*identityStep[\s\S]*recoveryCodesVisible[\s\S]*regenerateConfirmation/u, 'MFA and recovery steps hide redundant outer dismissal actions');
assert.match(source, /enrollmentUri\.searchParams\.get\('secret'\)!==result\.secret/u, 'MFA setup is rendered only when the enrollment URI matches the authorized secret');
assert.match(source, /syncAccountDialogActions\(\)[\s\S]*?pendingEnrollment[\s\S]*?identityStep/u, 'the MFA identity and enrollment steps are isolated before the next state opens');
assert.match(source, /\$\('\[data-mfa-qr\]'\)\.hidden=true/u, 'an unavailable QR renderer does not leave an empty QR area');
assert.match(source, /accountPanelContent\('invitation'\)\?\.append\(invitationForm\)/u, 'invitation acceptance is separated from company switching');
assert.match(source, /function accountPanelHasDraft[\s\S]*?showAccountDiscardPrompt[\s\S]*?function closeAccountDialog/u,
  'closing an edited form requires a custom discard decision and keeps the draft until confirmation');
assert.match(source, /accountDialogInitialDraft = accountPanelFormSnapshot\(panelName\)[\s\S]*?function accountPanelFormSnapshot[\s\S]*?accountPanelFormSnapshot\(panelName\) !== accountDialogInitialDraft/u,
  'prefilled values are not mistaken for edits when the user opens a form');
assert.match(source, /data-account-discard-confirm[\s\S]*?accountPanel\('discard'\)\.hidden = true[\s\S]*?closeAccountDialog\(true\)/u,
  'explicitly confirming draft disposal closes the correct discard panel and the dialog');
assert.match(source, /accountDialog\?\.addEventListener\('cancel',[\s\S]*?closeAccountDialog\(\)/u, 'Escape follows the same unsaved-draft and MFA safety guards');
assert.match(source, /accountDialog\?\.addEventListener\('close',[\s\S]*?if \(accountDialog\.open\) return;/u, 'a delayed close event cannot clear the state of a newly reopened account dialog');
assert.match(source, /function setAccountMfaView[\s\S]*section\.hidden = section\.dataset\.accountMfaView !== view/u,
  'MFA setup and one-time recovery-code views are mutually exclusive');
assert.match(source, /data-recovery-codes-dismiss[\s\S]*?else closeAccountDialog\(true\)/u,
  'dismissing regenerated recovery codes closes their dedicated modal when no mandatory MFA gate remains');
assert.match(source, /pendingEnrollment[\s\S]*?Para sair, cancele primeiro a configuração pendente/u,
  'a pending MFA replacement cannot be dismissed without safely cancelling enrollment');
assert.match(styles, /\.rm-account-dialog\s*\{[^}]*max-height:[^}]*safe-area-inset/u,
  'account dialogs fit the viewport and device safe area');
assert.match(styles, /\.rm-account-dialog-body\s*\{[^}]*overflow:auto/u, 'long account flows scroll inside the dialog body');
assert.match(styles, /\.rm-account-dialog-body\s*\[hidden\]\s*\{\s*display:none\s*!important/u,
  'CSS cannot visually override the hidden state of another account-dialog step');
assert.match(styles, /\.rm-account-dialog-surface > header\[hidden\],\.rm-account-dialog-footer\[hidden\]\s*\{\s*display:none\s*!important/u,
  'hidden dialog actions collapse completely instead of leaving a blank row');
assert.match(styles, /\.rm-account-dialog-footer\s*\{[^}]*safe-area-inset-bottom/u, 'account action buttons remain above the mobile home indicator');
assert.doesNotMatch(source, /window\.(?:confirm|alert|prompt)\s*\(/u, 'account flows do not fall back to native JavaScript dialogs');
assert.match(source, /visibleControls\(\)/u, 'account dialog keeps keyboard focus within visible controls');
assert.match(source, /driverCursor/u, 'driver linking can navigate a paginated driver list');
assert.match(source, /data-driver-summary[\s\S]*?contas vinculadas/u, 'Motoboys has a compact summary of server-loaded identity links and operational records');
assert.match(source, /if\(current\.permissions\.includes\('members\.invite'\)\)[\s\S]*?Convidar pessoa[\s\S]*?Seu perfil não permite enviar convites/u,
  'the driver page only offers invitation navigation to identities authorized to invite');
assert.match(source, /const driverPage = canReadDrivers[\s\S]*?if\(generation!==adminLoadGeneration\)return;[\s\S]*?availabilityByDriver/u,
  'stale driver and availability responses cannot render over a newer company admin load');
assert.match(source, /request\('\/driver-availability'\)[\s\S]*?Disponibilidade não consultada/u, 'live availability is queried separately and is not inferred from Driver registration state');
assert.match(source, /Vínculo confirmado pelo servidor e relido da empresa/u, 'link feedback requires server acknowledgement and membership readback');
assert.match(source, /refreshed\?\.members\?\.members\?\.some\(item=>item\.membershipId===member\.membershipId&&item\.driverId===null\)/u, 'unlink feedback follows a canonical membership readback');
assert.match(source, /DRIVER_HAS_ACTIVE_DELIVERIES: 'Reatribua ou conclua/u, 'an unlink blocked by ongoing work has a user-readable explanation');
assert.match(styles, /\.rm-admin-subpage\[data-admin-subpage="drivers"\][\s\S]*?\.rm-driver-group[\s\S]*?@media\(max-width:520px\)[\s\S]*?\.rm-driver-unlinked/u, 'Motoboys uses scoped compact and mobile-adaptive layout rules');
const linkableMatch = source.match(/const linkableStatuses=new Set\(\[([\s\S]*?)\]\);/u);
assert(linkableMatch, 'link selector exposes a finite operational status allowlist');
const uiDriverStatuses = new Set(vm.runInNewContext(`[${linkableMatch[1]}]`));
assert.deepEqual([...uiDriverStatuses].sort(), [...require('../backend/domain/driver-access').AUTHORIZED_DRIVER_STATUSES].sort(),
  'UI and backend share the same allowed Driver identity states');
assert.match(source, /app\.inert = open \|\| gated/u, 'authentication keeps the application inaccessible until authorized');
assert.match(source, /mfaLocked = Boolean\(session && \(session\.mfaEnrollmentRequired \|\| \(session\.mfaRequired && !session\.mfaVerified\)\)\)/u,
  'an enrollment-pending or unverified required-MFA session locks the application root');
assert.match(source, /if \(mfaLocked\) open = true/u, 'closing the account dialog cannot dismiss mandatory MFA setup');
assert.match(source, /if \(mfaLocked\) return;/u, 'background synchronization never starts before MFA confirmation');
assert.match(source, /document\.querySelector\('#app, \.app'\)/u, 'the gate covers both Restaurante and Motoboy application roots');
assert.match(appSource, /error\.status!==401&&sameIdentity/u, 'transient session checks do not revoke a same-account session, while identity changes remain isolated');
assert.match(appSource, /let modalReturnFocus=null/u, 'operational dialogs remember their invoking control');
assert.match(appSource, /document\.addEventListener\('keydown',e=>\{const dialog=/u, 'operational dialogs trap keyboard focus and handle Escape');
assert.match(appSource, /Buscar pedidos e entregas/u, 'delivery search has an accessible name');
assert.match(appSource, /Escopo dos ajustes[\s\S]{0,500}Preferências visuais e locais são salvas automaticamente neste aparelho[\s\S]{0,200}Dados da empresa só são confirmados após resposta válida do servidor/u, 'settings distinguish local autosave from server-confirmed company data');
assert.match(appSource, /const persisted=await getMeta\('settings'\);[\s\S]{0,180}SETTINGS_SAVE_UNCONFIRMED/u, 'local settings report success only after IndexedDB readback confirms the snapshot');
assert.match(appSource, /const enqueueSettingsWrite=RotaMotoCompanySettingsPersistence\.createSerialQueue\(\)[\s\S]{0,100}localSettingsSavePending=false/u, 'local settings writes serialize and retain failed drafts for retry');
assert.match(appSource, /beforeunload[\s\S]{0,100}hasUnsavedSettingsDraft/u, 'pending local/company drafts guard page exit');
assert.match(source, /MFA_REQUIRED/u, 'MFA errors remain visible and fail closed');
assert.match(source, /Última sincronização:|conexão ainda não está ativa/u, 'integration state distinguishes account authorization from an active connection and records sync time');
assert.match(source, /rotamoto:session-expired/u, 'sync session expiry returns the app to authentication');
assert.match(source, /function expireSession/u, 'an HTTP 401 also clears the authenticated UI state');
assert.match(source, /error\.status !== 401 && hadAuthenticatedSession/u, 'temporary network failures on resume do not discard a valid in-memory identity');
assert.match(source, /document\.addEventListener\('visibilitychange'/u, 'foreground resume revalidates session with the server');
assert.match(source, /rotamoto:app-ready/u, 'server sync waits until IndexedDB settings have finished hydrating');
assert.match(source, /Verificando sua sessão…/u, 'the initial identity state stays neutral until session verification completes');
assert.match(source, /\$\('\[data-mfa-start\]'\)\.hidden=Boolean\(session\.mfaConfigured&&!session\.mfaEnrollmentRequired\)[\s\S]*?\$\('\[data-mfa-replace\]'\)\.hidden=!\(session\.mfaConfigured&&session\.mfaVerified&&!session\.mfaEnrollmentRequired\)/u, 'optional MFA setup and authenticated factor replacement are shown only in valid session states');
assert.match(source, /\$\('\[data-password-change\]'\)\.addEventListener\('submit'[\s\S]*?request\('\/identity\/password\/change'[\s\S]*?result\?\.changed!==true/u, 'password settings require current credentials and a confirmed server response');
assert.match(source, /\$\('\[data-password-change\]'\)\.addEventListener\('submit',[\s\S]*?if\(form\.dataset\.saving==='true'\)return/u, 'password changes use a local duplicate-submit guard independent of background sync');
assert.match(source, /function showSession\(session\)\s*\{\s*if \(!session\) clearSensitiveAccountState\(\)/u, 'logout and session expiration clear account secrets and pending drafts from the hidden DOM');
assert.match(source, /companySummary\.replaceChildren\(document\.createTextNode\('Empresa ativa · '\), companyName\)[\s\S]*\$\('\[data-company-name\]'\)\.textContent = companyLabel[\s\S]*accountPage\.querySelector\('\[data-account-mfa-summary\]'\)\.textContent/u,
  'session restoration keeps the active-company label around the canonical company name and updates the MFA summary');
assert.doesNotMatch(source, /querySelector\('\[data-account-summary-company\]'\)\.textContent/u,
  'the session renderer does not write through the company summary placeholder after it has been replaced');
assert.match(source, /accountPage\.parentElement === panel \|\| !accountPage\.isConnected[\s\S]*?host\.append\(accountPage\)/u,
  'the account settings subtree stays attached when authentication removes the application view');
assert.match(source, /addEventListener\('rotamoto:auth-revoked'[\s\S]*?if \(!accountPage\.isConnected\) \{ host\.append\(accountPage\)/u,
  'logout reattaches account controls before a later login reads the MFA form');
assert.match(source, /host\.append\(accountPage\);\s*accountPage\.hidden=true/u,
  'leaving the Account and security page hides it in its persistent identity host');
assert.match(source, /function clearSensitiveAccountState\(\)[\s\S]*?passwordChangeForm\?\.reset\(\)[\s\S]*?clearMfaEnrollment\(\)[\s\S]*?recoveryCodes\.hidden = true/u, 'sensitive account forms, pending MFA key, and recovery codes are removed from the page when the session ends');
assert.match(source, /currentPassword:form\.elements\.currentPassword\.value,currentMfaCode:form\.elements\.currentMfaCode\.value/u, 'factor replacement requires the current password and a fresh TOTP or unused recovery code');
assert.match(source, /Código TOTP ou de recuperação[\s\S]*maxlength="23"/u, 'factor replacement UI accepts a TOTP code or a single-use recovery code');
assert.match(source, /\/identity\/mfa\/enrollment\/cancel/u, 'pending MFA secrets can be cancelled and removed server-side');
assert.match(source, /session\.emailVerified\?'Email confirmado':'Email ainda não confirmado'/u, 'account displays server-confirmed email verification');

assert.match(source, /response\.status === 401 && path !== '\/identity\/session'\) expireSession\(\)/u, 'session restoration applies its own generation check before changing identity');
assert.doesNotMatch(source, /data-offline/u, 'unauthenticated users cannot bypass identity through local mode');

assert.match(source, /offlineMode = false;/u, 'local mode cannot authorize an operational session');
assert.doesNotMatch(source, /localStorage\.(?:removeItem|setItem)\([^)]*local-mode/u, 'session changes do not mutate persisted local-mode preferences');
assert.match(source, /if \(!sessionReadGuard\.isCurrent\(readVersion\)\) return current;/u, 'late session results cannot replace newer user intent');
const sessionReadGuardIndex = html.indexOf('identity-session-guard.js');
const identityUiIndex = html.indexOf('identity-ui.js');
assert.ok(sessionReadGuardIndex >= 0 && identityUiIndex > sessionReadGuardIndex, 'session read guard loads before identity UI');
assert.match(source, /clearSession/u, 'logout clears in-memory sync credentials');

assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\(['"](?:session|csrf|password|token)/iu);
assert.match(html, /identity-ui\.css/u);
assert.match(html, /identity-ui\.js/u);
assert.equal(fs.existsSync(path.join(__dirname, '..', 'identity-ui.css')), true);
assert.match(styles, /#rmIdentityRoot \[hidden\],[\s\S]*?display:\s*none\s*!important/u,
  'auth form and permission-gated controls honor the hidden state despite component display rules');
assert.match(styles, /z-index:\s*2302/u, 'account dialog appears above fixed application navigation');
assert.match(styles, /body\[data-mfa-locked="true"\] \.rm-identity-panel[\s\S]*?width:\s*100vw/u,
  'the mandatory MFA dialog covers desktop and mobile viewports');
assert.match(styles, /safe-area-inset-bottom/u, 'identity panel respects device safe areas');
assert.match(styles, /prefers-reduced-motion:\s*reduce/u, 'identity panel respects reduced motion');
console.log('identity UI and secure session client contract: OK');
