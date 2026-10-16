'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { loadRuntimeConfig } = require('../backend/runtime/config');
const { createPool } = require('../backend/postgres/connection');
const { createIdentityService } = require('../backend/identity/service');
const { createNativeMfaProvider } = require('../backend/identity/native-mfa-provider');
const { createSmtpMailProvider } = require('../backend/identity/smtp-mail-provider');
const { createFileSecretProvider } = require('../backend/runtime/file-secret-provider');
const { loadSecretProvider, loadLocalSecretProvider } = require('../backend/runtime/secret-provider');
const { appendOperatorAudit } = require('../backend/runtime/operator-audit');

async function main() {
  const retryKey = process.argv.find(value => value.startsWith('--retry-key='))?.slice('--retry-key='.length) || null;
  if (stdin.isTTY !== true || stdout.isTTY !== true || !process.argv.includes('--confirm-database=rotamoto'))
    throw new Error('Bootstrap exige terminal interativo e confirmação explícita --confirm-database=rotamoto.');
  if (retryKey && !/^bootstrap-[A-Za-z0-9-]{36}$/u.test(retryKey)) throw new Error('Chave de retry inválida.');
  const config = loadRuntimeConfig();
  if (config.nodeEnv === 'test') throw new Error('Bootstrap real não pode ser executado em modo de teste.');
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let companyName, email;
  try {
    companyName = terminalLine(await terminal.question('Nome da empresa inicial: '), 160);
    email = terminalLine(await terminal.question('Email do proprietário (receberá convite): '), 320).toLowerCase();
    if ((await terminal.question('Digite PROVISIONAR PRIMEIRO PROPRIETARIO para continuar: ')) !== 'PROVISIONAR PRIMEIRO PROPRIETARIO')
      throw new Error('Confirmação local não reconhecida.');
  } finally { terminal.close(); }

  const database = new URL(config.databaseUrl);
  if (database.pathname !== '/rotamoto' || decodeURIComponent(database.username) !== 'rotamoto_app' || database.password)
    throw new Error('Bootstrap aceita somente rotamoto_app no banco rotamoto.');
  let secrets = null;
  if (config.production) secrets = config.secretProviderModule
    ? loadSecretProvider(config.secretProviderModule)
    : await loadLocalSecretProvider({ directory: config.secretStoreDirectory, masterKeyFile: config.secretMasterKeyFile });
  else if (process.env.ROTAMOTO_SECRET_STORE_DIRECTORY && process.env.ROTAMOTO_SECRET_MASTER_KEY_FILE)
    secrets = await createFileSecretProvider({ directory: process.env.ROTAMOTO_SECRET_STORE_DIRECTORY,
      masterKeyFile: process.env.ROTAMOTO_SECRET_MASTER_KEY_FILE });
  if (!secrets) throw new Error('Keystore local protegido ou secret provider obrigatório para cadastro e MFA.');

  const pool = createPool({ connectionString: config.databaseUrl, max: 2, connectionTimeoutMillis: 3000,
    ...(config.production ? { password: () => secrets.getDatabasePassword({ host: database.hostname,
      port: Number(database.port || 5432), database: 'rotamoto', user: 'rotamoto_app' }) } : {}),
    ...(config.databaseTlsCaFile ? { ssl: { ca: fs.readFileSync(config.databaseTlsCaFile, 'utf8'), rejectUnauthorized: true } } : {}) });
  const capability = crypto.randomBytes(32);
  const capabilityDigest = crypto.createHash('sha256').update(capability).digest();
  const idempotencyKey = retryKey || `bootstrap-${crypto.randomUUID()}`;
  const idempotencyDigest = crypto.createHash('sha256').update(idempotencyKey, 'utf8').digest();
  let databaseClient;
  try {
    await appendOperatorAudit(retryKey ? 'identity.bootstrap.retry_started' : 'identity.bootstrap.started', { database: 'rotamoto' });
    databaseClient = await pool.connect();
    await databaseClient.query('BEGIN');
    await databaseClient.query("SET LOCAL lock_timeout='3s'");
    const identity = await databaseClient.query('SELECT current_database() AS database,current_user AS role');
    if (identity.rows[0]?.database !== 'rotamoto' || identity.rows[0]?.role !== 'rotamoto_app')
      throw new Error('Conexão de bootstrap não corresponde a rotamoto/rotamoto_app.');
    const latch = await databaseClient.query(`SELECT completed_at,request_digest FROM rotamoto.installation_bootstrap
      WHERE singleton=true FOR UPDATE`);
    if (!latch.rowCount || latch.rows[0].completed_at &&
        !Buffer.from(latch.rows[0].request_digest || []).equals(idempotencyDigest))
      throw new Error('Instalação já inicializada ou migrations pendentes; somente retry da operação original pode prosseguir.');
    await databaseClient.query(`UPDATE rotamoto.bootstrap_authorizations SET consumed_at=now()
      WHERE consumed_at IS NULL AND expires_at>now()`);
    await databaseClient.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
      VALUES($1,'rotamoto',now()+interval '10 minutes')`, [capabilityDigest]);
    await databaseClient.query('COMMIT');

    const emailProvider = config.smtp?.host ? { async send(message) {
      const password = await secrets.get(config.smtp.passwordRef, { name: 'smtp/password', scope: 'installation' });
      return createSmtpMailProvider({ ...config.smtp, password }).send(message);
    } } : null;
    const identityService = createIdentityService({ pool, emailProvider,
      mfaProvider: createNativeMfaProvider({ secretProvider: secrets }), secretProvider: secrets,
      requireBootstrapAuthorization: true,
      authorizeProvisioner: async () => ({ actorRef: 'local-deployment-operator', bootstrapCapabilityDigest }) });
    const result = await identityService.provisionInitialOwner({ companyName, email, idempotencyKey });
    await appendOperatorAudit('identity.bootstrap.owner_provisioned', { delivery: result.delivery, replayed: result.replayed });
    stdout.write(`${JSON.stringify({ event: 'identity.bootstrap.owner_provisioned', companyId: result.companyId,
      userId: result.userId, delivery: result.delivery, operationKey: idempotencyKey, next: result.delivery === 'sent'
        ? 'O proprietário deve ativar pelo convite e concluir MFA antes de usar recursos administrativos.'
        : 'A entrega falhou; preserve o identificador desta operação e corrija o SMTP antes de solicitar retry.' })}\n`);
    if (result.delivery !== 'sent') process.exitCode = 2;
  } catch (error) {
    if (databaseClient) await databaseClient.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    databaseClient?.release();
    await pool.end();
    capabilityDigest.fill(0);
    idempotencyDigest.fill(0);
    capability.fill(0);
  }
}

function terminalLine(value, maxBytes) {
  if (typeof value !== 'string') throw new Error('Entrada inválida.');
  const normalized = value.trim().normalize('NFC');
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/u.test(normalized))
    throw new Error('Entrada inválida.');
  return normalized;
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({ event: 'identity.bootstrap.failed', code: /^[A-Z0-9_]{2,48}$/u.test(error.code || '') ? error.code : 'BOOTSTRAP_FAILED' })}\n`);
  process.exitCode = 1;
});
