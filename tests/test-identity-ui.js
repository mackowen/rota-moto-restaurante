'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const uiPath = path.join(__dirname, '..', 'identity-ui.js');
const htmlPath = path.join(__dirname, '..', 'index.html');
const source = fs.readFileSync(uiPath, 'utf8');
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
assert.match(appSource, /if\(generation!==companyProfileLoadGeneration\|\|companyId!==syncSession\?\.companyId\)return;if\(name\)name\.disabled=false/u, 'stale asynchronous company responses cannot re-enable or overwrite the active form');
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
assert.match(source, /if \(current && appKind === 'restaurante' && !mfaLocked\) \{\s*document\.dispatchEvent\(new CustomEvent\('rotamoto:open-account-settings'\)\)/u,
  'an authenticated Restaurante trigger navigates to the dedicated account settings page');
assert.match(source, /trigger\.setAttribute\('aria-controls', opensAccountPage \? 'rmAccountSettingsPage' : 'rmIdentityPanel'\)/u,
  'the top-bar trigger identifies the destination it controls');
assert.match(source, /function setOpen\(open, returnFocusTarget = null\)[\s\S]*?previousFocus = returnFocusTarget\?\.isConnected \? returnFocusTarget : document\.activeElement/u,
  'touch activation remembers the invoking control even when the browser does not focus it');
assert.match(appSource, /rotamoto:open-account-settings[\s\S]*?state\.settingsOpen='seguranca'[\s\S]*?requestAnimationFrame\(\(\)=>document\.querySelector\('#rmAccountSettingsPage h2'\)\?\.focus\(\)\)/u,
  'account navigation opens the dedicated settings page and moves focus to its heading');
assert.match(source, /document\.addEventListener\('rotamoto:settings-page',[\s\S]*?loadAdmin\(\)/u, 'each company settings page loads its server snapshot from the single navigation');
assert.match(appSource, /settings-cards[\s\S]*?settings-card/u, 'all Ajustes categories render as selectable cards on mobile and desktop');
assert.match(appSource, /data-settings-back/u, 'each Ajustes category page has a clear return to the card grid');
assert.match(appStyles, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u, 'the mobile Ajustes card grid uses two columns when space permits');
assert.doesNotMatch(source, /adminParent = app\?\.querySelector\('\.top-actions'\)/u, 'company administration is never injected into the top bar');
assert.match(styles, /#rmCompanyAdminPage,\s*#rmPlatformAdminPage \{\s*position: static/u, 'administrative pages stay in normal Settings document flow');
assert.match(styles, /\.rm-admin-subpage\[hidden\] \{ display:none !important; \}/u, 'inactive administrative pages respect their hidden state despite grid layout');
assert.match(source, /QR Code indisponível; a chave manual continua disponível/u, 'QR rendering failure preserves an actionable manual enrollment path');
const identityAsset = html.match(/identity-ui\.js\?v=[^"']+/u)?.[0];
assert(identityAsset, 'identity UI bundle has a cache busting version');
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
assert.match(sw, /CACHE_NAME = `\$\{CACHE_PREFIX\}v\d+`/u, 'service worker uses a versioned cache');
assert.ok(sw.includes(`'/${identityAsset}'`), 'current identity UI asset is included in the offline shell');
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
assert.match(source, /normalize\('NFD'\)[\s\S]*?authorizedDriverStatuses\.has\(driverStatus\)/u,
  'Driver status labels normalize canonical status casing and accent rules before reporting access');
assert.match(source, /\['ACTIVE','AVAILABLE','DISPONIVEL','EM ROTA','CHEGOU','IN ROUTE','ARRIVED'[\s\S]*?'OFFLINE','UNAVAILABLE','INDISPONIVEL','BUSY','OCUPADO','PAUSED','PAUSADO'\]/u,
  'Driver UI authorization status vocabulary stays aligned with the backend access allowlist');
assert.match(source, /Convite pendente/u, 'membership invitation state is presented in plain language');
assert.match(source, /Aguardando vínculo operacional/u, 'an activated identity without an operational Driver binding is clearly distinguished');
assert.match(appSource, /company-admin-team[\s\S]*?company-admin-drivers[\s\S]*?company-admin-integrations/u, 'team, drivers and integrations are first-class Ajustes categories');
assert.match(source, /Acesso e funções de pessoas vinculadas à empresa/u, 'team page has its own heading and contextual description');
assert.doesNotMatch(source, /data-admin-close|data-platform-close/u, 'administrative pages do not add redundant return-to-settings controls');
assert.doesNotMatch(source, /data-admin-page="/u, 'company pages do not duplicate category navigation inside the content');
assert.match(source, /dataset\.providerPage[\s\S]*?dataset\.providerTab/u, 'delivery platform configuration and received orders have separate provider pages');
assert.match(source, /textContent='Detalhes técnicos'/u, 'protocol capability details stay behind an optional disclosure');
assert.match(source, /operationLabels=\{CONFIRM:'Confirmação do pedido'/u, 'provider operation states use clear Portuguese labels');
assert.match(source, /A atualização não foi concluída\. Tente novamente ou peça ajuda ao suporte da empresa\./u, 'provider command errors have a user-facing explanation');
assert.match(source, /summary\.textContent='Código para suporte'/u, 'technical provider error identifiers stay in an optional disclosure');
assert.doesNotMatch(source, /\$\{order\.lastErrorCode\?` \(\$\{order\.lastErrorCode\}\)`/u, 'raw provider error codes are not included in ordinary status text');
assert.match(source, /function appendPermissionOptions\([\s\S]*groupNames[\s\S]*permission\.description/u, 'role permissions are grouped and described in plain language while retaining internal keys');
assert.match(source, /Atualizar situação no RotaMoto/u, 'provider state refresh is distinct from an external connection test');
assert.match(source, /window\.confirm\('Desconectar esta loja do RotaMoto/u, 'local provider disconnection requires explicit confirmation and explains portal authorization remains separate');
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
assert.match(source, /visibleControls\(\)/u, 'account dialog keeps keyboard focus within visible controls');
assert.match(source, /driverCursor/u, 'driver linking can navigate a paginated driver list');
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
assert.match(appSource, /let settingsWriteQueue=Promise\.resolve\(\),localSettingsSavePending=false/u, 'local settings writes serialize and retain failed drafts for retry');
assert.match(appSource, /beforeunload[\s\S]{0,100}hasUnsavedSettingsDraft/u, 'pending local/company drafts guard page exit');
assert.match(source, /MFA_REQUIRED/u, 'MFA errors remain visible and fail closed');
assert.match(source, /Última sincronização:|conexão ainda não está ativa/u, 'integration state distinguishes account authorization from an active connection and records sync time');
assert.match(source, /rotamoto:session-expired/u, 'sync session expiry returns the app to authentication');
assert.match(source, /function expireSession/u, 'an HTTP 401 also clears the authenticated UI state');
assert.match(source, /error\.status !== 401 && hadAuthenticatedSession/u, 'temporary network failures on resume do not discard a valid in-memory identity');
assert.match(source, /document\.addEventListener\('visibilitychange'/u, 'foreground resume revalidates session with the server');
assert.match(source, /rotamoto:app-ready/u, 'server sync waits until IndexedDB settings have finished hydrating');
assert.match(source, /Verificando sua sessão…/u, 'the initial identity state stays neutral until session verification completes');
assert.match(source, /\$\('\[data-mfa-start\]'\)\.hidden=!Boolean\(session\.mfaEnrollmentRequired\)/u, 'MFA enrollment guidance is not shown for an already configured factor');

assert.match(source, /response\.status === 401 && path !== '\/identity\/session'\) expireSession\(\)/u, 'session restoration applies its own generation check before changing identity');
assert.doesNotMatch(source, /data-offline/u, 'unauthenticated users cannot bypass identity through local mode');

assert.match(source, /offlineMode = false;/u, 'local mode cannot authorize an operational session');
assert.doesNotMatch(source, /localStorage\.(?:removeItem|setItem)\([^)]*local-mode/u, 'session changes do not mutate persisted local-mode preferences');
assert.match(source, /if \(!sessionReadGuard\.isCurrent\(readVersion\)\) return current;/u, 'late session results cannot replace newer user intent');
assert.match(html, /identity-session-guard\.js[\s\S]{0,300}identity-ui\.js/u, 'session read guard loads before identity UI');
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
