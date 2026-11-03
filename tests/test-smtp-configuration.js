'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { initializeFileSecretStore, createFileSecretProvider } = require('../backend/runtime/file-secret-provider');
const { createSmtpConfigurationService, validateSmtpSettings } = require('../backend/identity/smtp-configuration');
const { safeSmtpError } = require('../backend/identity/smtp-configuration');
const { isPublicV4 } = require('../backend/identity/smtp-mail-provider');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-smtp-config-'));
  await fs.chmod(root, 0o700);
  const identity = path.join(root, 'identity'), keys = path.join(identity, 'keys'), store = path.join(identity, 'keystore');
  await fs.mkdir(keys, { recursive: true, mode: 0o700 }); await fs.mkdir(store, { mode: 0o700 });
  await initializeFileSecretStore({ directory: store, masterKeyFile: path.join(keys, 'master.key') });
  const secrets = await createFileSecretProvider({ directory: store, masterKeyFile: path.join(keys, 'master.key') });
  const attempts = new Set();
  const pool = { async query(sql, values = []) {
    if (/current_database\(\)/u.test(sql)) return { rows: [{ database: 'rotamoto', role: 'rotamoto_app', session_role: 'rotamoto_app' }] };
    if (/bootstrap_authorizations/u.test(sql)) return { rows: [{ ok: true }], rowCount: 1 };
    if (/platform_admin_bootstrap_status/u.test(sql)) return { rows: [{ state: 'ready' }], rowCount: 1 };
    if (/platform_admin_record_bootstrap_smtp_test/u.test(sql)) {
      const id = values[1]; const accepted = !attempts.has(id) && attempts.size < 5; attempts.add(id);
      return { rows: [{ accepted }], rowCount: 1 };
    }
    throw new Error('unexpected SQL');
  } };
  const sent = [], invitations = [];
  const service = createSmtpConfigurationService({ pool, secretProvider: secrets, configFile: path.join(identity, 'smtp-config.json'),
    resolveAddresses: async host => { assert.equal(host, 'smtp.example.test'); return ['127.0.0.1']; },
    transportFactory: options => ({ async verify() { assert.equal(options.user, 'smtp-user@example.test'); assert.equal(options.password, 'test-secret-only'); },
      async sendMail(message) { sent.push(message); return { accepted: [message.to] }; }, close() {} }),
    mailProviderFactory: options => ({ async send(message) { invitations.push({ host: options.host, message }); return true; }, close() {} }), audit: async () => {} });
  const capability = 'A'.repeat(43);
  const request = { socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'http://127.0.0.1:8083',
    'x-rotamoto-bootstrap-authorization': capability } };
  const settings = { provider: 'custom', senderEmail: 'owner@example.test', senderName: 'RotaMoto', host: 'smtp.example.test',
    port: 587, tlsMode: 'starttls', authMethod: 'password', username: 'smtp-user@example.test', password: 'test-secret-only',
    testRecipient: 'qa@example.test', publicBaseUrl: 'https://rotamoto.example.org/' };

  assert.throws(() => validateSmtpSettings({ ...settings, host: '127.0.0.1' }), /host SMTP DNS público/u);
  assert.throws(() => validateSmtpSettings({ ...settings, tlsMode: 'none' }), /sem TLS/u);
  assert.throws(() => validateSmtpSettings({ ...settings, authMethod: 'oauth' }), /OAuth ainda não está disponível/u);
  assert.throws(() => validateSmtpSettings({ ...settings, senderName: 'RotaMoto\r\nBcc: x@example.test' }), /nome de exibição/u);
  assert.throws(() => validateSmtpSettings({ ...settings, provider: 'gmail', host: 'smtp.example.test' }), /Gmail exige/u);
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.1.1','100.64.1.1','198.18.0.1','203.0.113.1']) assert.equal(isPublicV4(address), false, `${address} is not a public SMTP target`);
  assert.equal(isPublicV4('8.8.8.8'), true);
  assert.equal(safeSmtpError(Object.assign(new Error('secret smtp host details'), { code: 'EAUTH' })).message, 'O servidor SMTP recusou a autenticação.');
  assert.equal(safeSmtpError(Object.assign(new Error('raw socket data'), { code: 'ETIMEDOUT' })).code, 'ETIMEDOUT');
  const validated = await service.validate(settings);
  assert.equal(validated.valid, true); assert.equal(validated.authentication, 'password'); assert.equal(validated.oauthAvailable, false);

  const requestId = '58ecf3aa-d994-4b88-9d99-14210865e01c';
  const result = await service.test(settings, request, requestId);
  assert.deepEqual(result, { connection: 'verified', submission: 'accepted_by_smtp', delivery: 'unconfirmed', configurationSaved: true,
    notice: 'O servidor SMTP aceitou a mensagem. A entrega na caixa de entrada não é confirmada pelo SMTP.' });
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'qa@example.test');
  assert.equal(await service.readiness(), true);
  assert.equal(await service.sendInvitation({ kind: 'owner_invitation', to: 'qa-owner@example.test', token: 'opaque-test-token' }), true);
  assert.equal(invitations.length, 1); assert.equal(invitations[0].host, 'smtp.example.test');
  assert.equal(invitations[0].message.kind, 'owner_invitation', 'the saved SMTP transport is consumed by the invitation provider');
  const status = await service.status();
  assert.equal(status.configured, true); assert.equal(status.credentialStored, true);
  assert.equal(JSON.stringify(status).includes('test-secret-only'), false);
  const storedRef = JSON.parse(await fs.readFile(path.join(identity, 'smtp-config.json'), 'utf8')).passwordRef;
  const reuseSettings = { ...settings, username: '', password: '', reuseStoredCredential: true };
  assert.equal((await service.validate(reuseSettings)).valid, true, 'a protected prior credential can be validated without returning it');
  await assert.rejects(service.validate({ ...reuseSettings, host: 'smtp.other.example.test' }), /host e a conta SMTP já aprovados/u,
    'reusing a credential is pinned to its previously approved SMTP host');
  const reused = await service.test(reuseSettings, request, '98157bb2-4832-4e98-9ee0-0863c1074a26');
  assert.equal(reused.configurationSaved, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(identity, 'smtp-config.json'), 'utf8')).passwordRef, storedRef,
    'reusing a credential does not rotate or overwrite the protected key');
  const legacyService = createSmtpConfigurationService({ pool, secretProvider: secrets, configFile: path.join(identity, 'smtp-config-legacy.json'),
    existingConfig: { host: 'smtp.example.test', port: 587, secure: false, user: 'smtp-user@example.test',
      from: 'RotaMoto <owner@example.test>', passwordRef: storedRef }, resolveAddresses: async () => ['127.0.0.1'],
    transportFactory: options => ({ async verify() { assert.equal(options.password, 'test-secret-only'); },
      async sendMail(message) { return { accepted: [message.to] }; }, close() {} }), audit: async () => {} });
  const legacyState = await legacyService.status();
  assert.equal(legacyState.existingCredentialAvailable, true); assert.equal(legacyState.senderEmail, 'owner@example.test');
  assert.equal(JSON.stringify(legacyState).includes('smtp-user@example.test'), false, 'setup status does not reveal the stored SMTP login');
  assert.equal((await legacyService.test({ ...settings, senderEmail: 'owner@example.test', username: '', password: '', reuseStoredCredential: true },
    request, '6d3466fb-58b9-407a-897a-7cad152bfe41')).configurationSaved, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(identity, 'smtp-config-legacy.json'), 'utf8')).passwordRef, storedRef,
    'legacy protected reference is adopted without overwriting its key');
  const configText = await fs.readFile(path.join(identity, 'smtp-config.json'), 'utf8');
  assert.equal(configText.includes('test-secret-only'), false);
  const config = JSON.parse(configText);
  assert.match(config.passwordRef, /^local-v1:/u);
  assert.equal(await secrets.get(config.passwordRef, { name: 'smtp/password', scope: 'installation' }), 'test-secret-only');
  await assert.rejects(service.test(settings, request, requestId), /repetido|limite/u, 'request id is protected from replay');
  await assert.rejects(service.authorize({ ...request, headers: { ...request.headers, origin: 'https://attacker.example.org' } }, 'smtp.test'),
    { code: 'PROVISIONER_UNAUTHORIZED' }, 'non-local origin remains blocked');
  await assert.rejects(service.authorize({ ...request, socket: { remoteAddress: '192.168.1.8' } }, 'smtp.test'),
    { code: 'PROVISIONER_UNAUTHORIZED' }, 'non-loopback caller remains blocked');
  const concurrentId = 'e0b842f9-4317-4f0f-9128-0e31f9c4b142';
  const concurrent = await Promise.allSettled([service.test(settings, request, concurrentId), service.test(settings, request, concurrentId)]);
  assert.equal(concurrent.filter(entry => entry.status === 'fulfilled').length, 1, 'concurrent duplicate submissions send once');
  assert.equal(sent.length, 3);
  assert.deepEqual(await service.disable(), { disabled: true, configured: false });
  assert.equal((await service.status()).disabled, true, 'disable state overrides protected legacy credentials');
  assert.equal(await service.readiness(), false);
  await assert.rejects(service.sendInvitation({ kind: 'owner_invitation', to: 'qa-owner@example.test', token: 'opaque' }), /ainda não foi testado/u);
  const failurePool = { async query(sql) {
    if (/current_database\(\)/u.test(sql)) return { rows: [{ database: 'rotamoto', role: 'rotamoto_app', session_role: 'rotamoto_app' }] };
    if (/bootstrap_authorizations/u.test(sql)) return { rows: [{}], rowCount: 1 };
    if (/platform_admin_bootstrap_status/u.test(sql)) return { rows: [{ state: 'ready' }], rowCount: 1 };
    if (/platform_admin_record_bootstrap_smtp_test/u.test(sql)) return { rows: [{ accepted: true }], rowCount: 1 };
    throw new Error('unexpected failure-case SQL');
  } };
  const failureAudits = [];
  for (const [suffix, behavior, code] of [
    ['auth', { async verify() { throw Object.assign(new Error('credential detail secret'), { code: 'EAUTH' }); } }, 'EAUTH'],
    ['timeout', { async verify() { throw Object.assign(new Error('connection detail secret'), { code: 'ETIMEDOUT' }); } }, 'ETIMEDOUT'],
    ['recipient', { async verify() {}, async sendMail() { return { accepted: [] }; } }, 'EENVELOPE']
  ]) {
    const failedConfig = path.join(identity, `smtp-failure-${suffix}.json`);
    const failing = createSmtpConfigurationService({ pool: failurePool, secretProvider: secrets, configFile: failedConfig,
      resolveAddresses: async () => ['127.0.0.1'], transportFactory: () => ({ ...behavior, close() {} }), audit: async (action, details) => failureAudits.push({ action, details }) });
    await assert.rejects(failing.test(settings, request, `2a82ee31-7d52-4ce1-9f${suffix==='auth'?'00':suffix==='timeout'?'01':'02'}-14210865e01c`), error => {
      assert.equal(error.code, code); assert.doesNotMatch(error.message, /secret|detail/u); return true;
    });
    await assert.rejects(fs.access(failedConfig), { code: 'ENOENT' }, 'failed SMTP tests never persist a configuration');
  }
  assert.equal(failureAudits.length, 3); assert(failureAudits.every(event => event.action === 'smtp.bootstrap_test.failed' && !('password' in event.details)))
  const expiredPool = { ...pool, async query(sql, values = []) {
    if (/bootstrap_authorizations/u.test(sql)) return { rows: [], rowCount: 0 };
    return pool.query(sql, values);
  } };
  const expired = createSmtpConfigurationService({ pool: expiredPool, secretProvider: secrets, configFile: path.join(identity, 'smtp-config.json'),
    resolveAddresses: async () => ['127.0.0.1'], transportFactory: () => { throw new Error('expired capability must not contact SMTP'); }, audit: async () => {} });
  await assert.rejects(expired.authorize(request, 'smtp.test'), { code: 'PROVISIONER_UNAUTHORIZED' }, 'expired authorization is rejected');
  console.log('SMTP input/network guards, auth/timeout/recipient failure handling, authenticated encryption, legacy credential reuse, sanitized state, local authorization, and replay/concurrency guard: PASS');
  await fs.rm(root, { recursive: true, force: true });
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
