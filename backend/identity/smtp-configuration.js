'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { createSmtpTransport, createSmtpMailProvider, resolvePublicSmtpAddresses } = require('./smtp-mail-provider');
const { appendOperatorAudit } = require('../runtime/operator-audit');

const EMAIL = /^[^\s@<>(),;:\\"\[\]]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SECRET_NAME = 'smtp/password';
const SECRET_SCOPE = 'installation';

function inputError(message = 'Revise os parâmetros SMTP informados.') {
  return Object.assign(new Error(message), { code: 'SMTP_CONFIGURATION_INVALID' });
}
function emailValid(value) { return typeof value === 'string' && value.length <= 254 && EMAIL.test(value); }
function validateSmtpSettings(input) {
  const keys = ['provider', 'senderEmail', 'senderName', 'host', 'port', 'tlsMode', 'authMethod', 'username', 'password', 'testRecipient', 'publicBaseUrl', 'reuseStoredCredential'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw inputError();
  if (input.reuseStoredCredential !== undefined && typeof input.reuseStoredCredential !== 'boolean') throw inputError();
  const provider = input.provider;
  if (!['gmail', 'microsoft365', 'custom'].includes(provider)) throw inputError('Escolha um provedor de e-mail compatível.');
  const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
  const port = Number(input.port);
  const tlsMode = input.tlsMode;
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = input.password;
  const senderEmail = typeof input.senderEmail === 'string' ? input.senderEmail.trim() : '';
  const senderName = typeof input.senderName === 'string' ? input.senderName.trim() : '';
  const testRecipient = typeof input.testRecipient === 'string' ? input.testRecipient.trim() : '';
  const publicBaseUrl = typeof input.publicBaseUrl === 'string' ? input.publicBaseUrl.trim() : '';
  if (!host || host.length > 253 || net.isIP(host) || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(host) || host === 'localhost' || host.endsWith('.localhost')) throw inputError('Informe um host SMTP DNS público válido.');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['starttls', 'tls'].includes(tlsMode)) throw inputError('Confira a porta e o tipo de TLS. O transporte sem TLS não é aceito.');
  if (provider === 'gmail' && (host !== 'smtp.gmail.com' || port !== 465 || tlsMode !== 'tls')) throw inputError('Gmail exige smtp.gmail.com, porta 465 e TLS implícito.');
  if (provider === 'microsoft365' && (host !== 'smtp.office365.com' || port !== 587 || tlsMode !== 'starttls')) throw inputError('Microsoft 365 exige smtp.office365.com, porta 587 e STARTTLS.');
  if (input.authMethod !== 'password') throw inputError('Este fluxo oferece somente autenticação por usuário e senha SMTP. OAuth ainda não está disponível.');
  if (!username || username.length > 320 || /[\r\n\u0000-\u001f\u007f]/u.test(username) || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 1 || Buffer.byteLength(password, 'utf8') > 4096 || password.includes('\0')) throw inputError('Informe usuário e credencial SMTP válidos.');
  if (!emailValid(senderEmail) || !emailValid(testRecipient)) throw inputError('Informe e-mails válidos para remetente e teste.');
  if (!senderName || Buffer.byteLength(senderName, 'utf8') > 120 || /[\r\n\u0000-\u001f\u007f]/u.test(senderName)) throw inputError('Informe um nome de exibição sem quebras de linha.');
  let base = null;
  if (publicBaseUrl) {
    try { base = new URL(publicBaseUrl); } catch (_) { throw inputError('A URL dos convites precisa ser pública e HTTPS.'); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || net.isIP(base.hostname) || ['localhost'].includes(base.hostname.toLowerCase()) || base.hostname.endsWith('.localhost')) throw inputError('A URL dos convites precisa ser pública, HTTPS e sem credenciais, query ou fragmento.');
  }
  return Object.freeze({ provider, senderEmail, senderName, host, port, tlsMode, username, password, testRecipient, publicBaseUrl: base?.toString() || '' });
}

function safeSmtpError(error) {
  const code = ['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'EAUTH', 'EENVELOPE', 'EDNS', 'ESOCKET'].includes(error?.code)
    ? error.code : 'SMTP_TEST_FAILED';
  const message = code === 'EAUTH' ? 'O servidor SMTP recusou a autenticação.' :
    code === 'ETIMEDOUT' ? 'O servidor SMTP excedeu o tempo limite.' :
    code === 'EENVELOPE' ? 'O servidor SMTP recusou o remetente ou destinatário do teste.' :
    'Não foi possível testar o envio SMTP. Confira host, porta, TLS e credenciais.';
  return Object.assign(new Error(message), { code });
}

function legacySettings(config) {
  if (!config || typeof config !== 'object' || typeof config.passwordRef !== 'string' || !config.passwordRef) return null;
  const from = String(config.from || '').trim();
  const match = /^(?:(.*?)\s*)?<([^<>]+)>$/u.exec(from);
  const senderEmail = (match?.[2] || from).trim();
  const senderName = (match?.[1] || 'RotaMoto').replace(/^"|"$/gu, '').trim() || 'RotaMoto';
  const host = typeof config.host === 'string' ? config.host.toLowerCase() : '';
  const port = Number(config.port);
  const tlsMode = config.secure ? 'tls' : 'starttls';
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !emailValid(senderEmail) ||
      typeof config.user !== 'string' || !config.user || !emailValid(config.user)) return null;
  return Object.freeze({ provider: host === 'smtp.gmail.com' && port === 465 && tlsMode === 'tls' ? 'gmail' : 'custom',
    senderEmail, senderName, testRecipient: senderEmail, host, port, tlsMode, username: config.user, passwordRef: config.passwordRef,
    publicBaseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : '' });
}

function createSmtpConfigurationService({ pool, secretProvider, configFile, existingConfig = null, audit = appendOperatorAudit,
  resolveAddresses = resolvePublicSmtpAddresses, transportFactory = createSmtpTransport, mailProviderFactory = createSmtpMailProvider } = {}) {
  if (!pool || !secretProvider || typeof secretProvider.put !== 'function' || !path.isAbsolute(configFile || ''))
    throw new TypeError('SMTP setup requires a pool, protected secret provider and absolute private config path.');
  let queue = Promise.resolve();
  const legacy = legacySettings(existingConfig);
  const serialize = action => { const current = queue.then(action); queue = current.catch(() => {}); return current; };

  async function authorize(request, action) {
    const peer = String(request?.socket?.remoteAddress || '').replace(/^::ffff:/u, '');
    let origin;
    try { origin = new URL(request?.headers?.origin || '').hostname.toLowerCase(); } catch (_) { origin = ''; }
    const capability = request?.headers?.['x-rotamoto-bootstrap-authorization'];
    if (!['smtp.validate', 'smtp.test'].includes(action) || !['127.0.0.1', '::1'].includes(peer) ||
        !['127.0.0.1', '::1', 'localhost'].includes(origin) || typeof capability !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(capability))
      throw Object.assign(new Error('Autorização temporária inválida ou expirada.'), { code: 'PROVISIONER_UNAUTHORIZED' });
    const digest = crypto.createHash('sha256').update(capability, 'utf8').digest();
    try {
      const target = await pool.query('SELECT current_database() AS database,current_user AS role,session_user AS session_role');
      if (target.rows[0]?.database !== 'rotamoto' || target.rows[0]?.role !== 'rotamoto_app' || target.rows[0]?.session_role !== 'rotamoto_app')
        throw Object.assign(new Error('Autorização temporária inválida ou expirada.'), { code: 'PROVISIONER_UNAUTHORIZED' });
      const active = await pool.query(`SELECT 1 FROM rotamoto.bootstrap_authorizations
        WHERE token_digest=$1 AND installation_scope='rotamoto' AND consumed_at IS NULL AND expires_at>now()`, [digest]);
      if (!active.rowCount) throw Object.assign(new Error('Autorização temporária inválida ou expirada.'), { code: 'PROVISIONER_UNAUTHORIZED' });
      const status = await pool.query('SELECT rotamoto.platform_admin_bootstrap_status() AS state');
      if (status.rows[0]?.state !== 'ready') throw Object.assign(new Error('A primeira instalação não está disponível.'), { code: 'BOOTSTRAP_NOT_AVAILABLE' });
      return digest;
    } catch (error) {
      if (error?.code === 'PROVISIONER_UNAUTHORIZED' || error?.code === 'BOOTSTRAP_NOT_AVAILABLE') throw error;
      throw Object.assign(new Error('Não foi possível validar a autorização temporária.'), { code: 'PROVISIONER_UNAUTHORIZED' });
    }
  }

  async function resolveSettings(input) {
    if (input?.reuseStoredCredential !== true) return { settings: validateSmtpSettings(input), passwordRef: null };
    const stored = await loadStored();
    const source = stored?.disabled ? null : stored || legacy;
    if (!source?.passwordRef) throw inputError('Não há uma credencial SMTP protegida disponível para reutilização.');
    const host = typeof input.host === 'string' ? input.host.trim().toLowerCase() : '';
    const port = Number(input.port);
    if (host !== source.host || port !== source.port || input.tlsMode !== source.tlsMode ||
        input.senderEmail?.trim().toLowerCase() !== source.senderEmail.toLowerCase() ||
        input.username && input.username.trim() !== source.username)
      throw inputError('A credencial existente só pode ser reutilizada com o host e a conta SMTP já aprovados.');
    let password;
    try { password = await secretProvider.get(source.passwordRef, { name: SECRET_NAME, scope: SECRET_SCOPE }); }
    catch (_) { throw Object.assign(new Error('A credencial SMTP protegida existente está indisponível.'), { code: 'SMTP_CONFIGURATION_UNAVAILABLE' }); }
    return { settings: validateSmtpSettings({ ...input, username: source.username, password }), passwordRef: source.passwordRef };
  }

  async function validate(input) {
    const { settings } = await resolveSettings(input);
    const addresses = await resolveAddresses(settings.host);
    return { valid: addresses.length > 0, provider: settings.provider, host: settings.host, port: settings.port,
      tlsMode: settings.tlsMode, authentication: 'password', oauthAvailable: false };
  }

  async function loadStored() {
    let text;
    try { text = await fs.readFile(configFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw Object.assign(new Error('Configuração SMTP protegida indisponível.'), { code: 'SMTP_CONFIGURATION_UNAVAILABLE' }); }
    try {
      const stat = await fs.lstat(configFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error('unsafe');
      const value = JSON.parse(text);
      if (value?.version !== 1 || value.disabled === true && Object.keys(value).some(key => !['version', 'disabled', 'disabledAt'].includes(key))) throw new Error('invalid');
      if (value.disabled === true) return value;
      if (typeof value.passwordRef !== 'string' || !EMAIL.test(value.senderEmail) || typeof value.publicBaseUrl !== 'string') throw new Error('invalid');
      if (value.publicBaseUrl) {
        const base = new URL(value.publicBaseUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || net.isIP(base.hostname) ||
            ['localhost'].includes(base.hostname.toLowerCase()) || base.hostname.endsWith('.localhost')) throw new Error('invalid');
      }
      return value;
    } catch (_) { throw Object.assign(new Error('Configuração SMTP protegida indisponível.'), { code: 'SMTP_CONFIGURATION_UNAVAILABLE' }); }
  }

  async function saveStored(value) {
    const directory = path.dirname(configFile);
    const dirStat = await fs.lstat(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) || (dirStat.mode & 0o077))
      throw Object.assign(new Error('Diretório SMTP protegido inválido.'), { code: 'SMTP_CONFIGURATION_UNAVAILABLE' });
    const temporary = `${configFile}.tmp-${crypto.randomUUID()}`;
    let handle;
    try {
      handle = await fs.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temporary, configFile);
      const dir = await fs.open(directory, fs.constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); }
    } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }

  async function executeTest(input, requestId, recordAttempt, auditAction) {
    const resolved = await resolveSettings(input);
    const parsed = resolved.settings;
    await resolveAddresses(parsed.host);
    if (typeof requestId !== 'string' || !UUID.test(requestId)) throw inputError('Identificador de teste inválido.');
    const replay = await recordAttempt(requestId);
    if (replay.rows[0]?.accepted !== true) throw Object.assign(new Error('O teste foi repetido, a autorização expirou ou o limite foi atingido.'), { code: 'RATE_LIMITED' });
    return serialize(async () => {
      let temp;
      let previous;
      try {
        const addresses = await resolveAddresses(parsed.host);
        temp = transportFactory({ host: parsed.host, port: parsed.port, secure: parsed.tlsMode === 'tls',
          requireTLS: parsed.tlsMode === 'starttls', user: parsed.username, password: parsed.password,
          resolveAddresses: async () => addresses });
        await temp.verify();
        const from = `${parsed.senderName.replace(/[\\"]/gu, '\\$&')} <${parsed.senderEmail}>`;
        const result = await temp.sendMail({ from, to: parsed.testRecipient, subject: 'Teste do transporte de e-mail RotaMoto',
          text: 'Esta mensagem confirma que o servidor SMTP aceitou o envio do teste. A entrega na caixa de entrada depende do provedor.' });
        const accepted = Array.isArray(result.accepted) && result.accepted.some(value => String(value).toLowerCase() === parsed.testRecipient.toLowerCase());
        if (!accepted) throw Object.assign(new Error('O servidor SMTP não aceitou o destinatário de teste.'), { code: 'EENVELOPE' });
        await audit(auditAction, { provider: parsed.provider });
        previous = await loadStored();
        const secret = resolved.passwordRef ? { secretRef: resolved.passwordRef } :
          await secretProvider.put({ name: SECRET_NAME, scope: SECRET_SCOPE, value: parsed.password });
        const persisted = { version: 1, provider: parsed.provider, senderEmail: parsed.senderEmail, senderName: parsed.senderName,
          host: parsed.host, port: parsed.port, tlsMode: parsed.tlsMode, username: parsed.username,
          passwordRef: secret.secretRef, publicBaseUrl: parsed.publicBaseUrl, lastTestAt: new Date().toISOString(), lastTestStatus: 'accepted_by_smtp' };
        try { await saveStored(persisted); }
        catch (error) { await secretProvider.remove(secret.secretRef).catch(() => {}); throw error; }
        if (previous?.passwordRef && previous.passwordRef !== secret.secretRef) await secretProvider.remove(previous.passwordRef).catch(() => {});
        return { connection: 'verified', submission: 'accepted_by_smtp', delivery: 'unconfirmed', configurationSaved: true,
          notice: 'O servidor SMTP aceitou a mensagem. A entrega na caixa de entrada não é confirmada pelo SMTP.' };
      } catch (error) {
        const safe = ['RATE_LIMITED', 'SMTP_CONFIGURATION_INVALID', 'SMTP_CONFIGURATION_UNAVAILABLE'].includes(error?.code) ? error : safeSmtpError(error);
        await audit(auditAction.replace(/\.accepted$/u, '.failed'), { provider: parsed.provider, errorCode: safe.code || 'SMTP_TEST_FAILED' }).catch(() => {});
        throw safe;
      } finally { temp?.close(); }
    });
  }

  async function test(input, request, requestId) {
    const digest = await authorize(request, 'smtp.test');
    try {
      return await executeTest(input, requestId,
        id => pool.query('SELECT rotamoto.platform_admin_record_bootstrap_smtp_test($1,$2::uuid) AS accepted', [digest, id]),
        'smtp.bootstrap_test.accepted');
    } finally { digest.fill(0); }
  }

  async function testAsAdmin(input, userId, requestId) {
    if (typeof userId !== 'string' || !UUID.test(userId)) throw Object.assign(new Error('Acesso administrativo não autorizado.'), { code: 'FORBIDDEN' });
    return executeTest(input, requestId,
      id => pool.query('SELECT rotamoto.platform_admin_record_smtp_admin_test($1::uuid,$2::uuid) AS accepted', [userId, id]),
      'smtp.admin_test.accepted');
  }

  async function invitationProvider() {
    const stored = await loadStored();
    if (stored?.disabled) return null;
    if (!stored || !stored.publicBaseUrl) return null;
    const password = await secretProvider.get(stored.passwordRef, { name: SECRET_NAME, scope: SECRET_SCOPE });
    return mailProviderFactory({ host: stored.host, port: stored.port, secure: stored.tlsMode === 'tls',
      requireTLS: stored.tlsMode === 'starttls', user: stored.username, password,
      from: `${stored.senderName.replace(/[\\"]/gu, '\\$&')} <${stored.senderEmail}>`, baseUrl: stored.publicBaseUrl, resolveAddresses });
  }

  async function sendInvitation(message) {
    return serialize(async () => {
      const provider = await invitationProvider();
      if (!provider) throw Object.assign(new Error('Convites por e-mail estão desativados até configurar uma URL pública HTTPS. Use o fluxo local de instalação ou configure o domínio depois.'), { code: 'INVITATION_LINKS_UNAVAILABLE' });
      try { return await provider.send(message); } finally { provider.close(); }
    });
  }

  async function readiness() {
    try {
      const stored = await loadStored();
      if (stored?.disabled) return false;
      if (!stored?.passwordRef || !stored.publicBaseUrl || stored.lastTestStatus !== 'accepted_by_smtp') return false;
      const password = await secretProvider.get(stored.passwordRef, { name: SECRET_NAME, scope: SECRET_SCOPE });
      return typeof password === 'string' && password.length > 0;
    }
    catch (_) { return false; }
  }

  async function transportReadiness() {
    try {
      const stored = await loadStored();
      if (stored?.disabled || !stored?.passwordRef || stored.lastTestStatus !== 'accepted_by_smtp') return false;
      const password = await secretProvider.get(stored.passwordRef, { name: SECRET_NAME, scope: SECRET_SCOPE });
      return typeof password === 'string' && password.length > 0;
    } catch (_) { return false; }
  }

  async function status() {
    const stored = await loadStored();
    if (stored?.disabled) return { configured: false, disabled: true, credentialStored: false, existingCredentialAvailable: false, oauthAvailable: false };
    return stored ? { configured: true, transportConfigured: stored.lastTestStatus === 'accepted_by_smtp',
      invitationLinksConfigured: Boolean(stored.publicBaseUrl), provider: stored.provider, host: stored.host, port: stored.port,
      tlsMode: stored.tlsMode, senderEmail: stored.senderEmail, senderName: stored.senderName, testRecipient: stored.senderEmail,
      publicBaseUrl: stored.publicBaseUrl || null,
      lastTestStatus: stored.lastTestStatus, lastTestAt: stored.lastTestAt, credentialStored: true, existingCredentialAvailable: false } :
      { configured: false, ...(legacy ? { provider: legacy.provider, host: legacy.host, port: legacy.port,
        tlsMode: legacy.tlsMode, senderEmail: legacy.senderEmail, senderName: legacy.senderName, testRecipient: legacy.testRecipient,
        publicBaseUrl: legacy.publicBaseUrl || null } : {}), credentialStored: false,
        existingCredentialAvailable: Boolean(legacy && await secretProvider.get(legacy.passwordRef, { name: SECRET_NAME, scope: SECRET_SCOPE }).then(() => true, () => false)), oauthAvailable: false };
  }

  async function disable() {
    return serialize(async () => {
      const stored = await loadStored();
      if (stored?.disabled) return { disabled: true, configured: false };
      await audit('smtp.admin_transport.disabled', { provider: stored?.provider || legacy?.provider || null });
      await saveStored({ version: 1, disabled: true, disabledAt: new Date().toISOString() });
      if (stored?.passwordRef && stored.passwordRef !== legacy?.passwordRef) await secretProvider.remove(stored.passwordRef).catch(() => {});
      return { disabled: true, configured: false };
    });
  }

  return Object.freeze({ authorize, validate, test, testAsAdmin, sendInvitation, readiness, transportReadiness, status, disable });
}

module.exports = { createSmtpConfigurationService, validateSmtpSettings, resolvePublicSmtpAddresses, safeSmtpError };
