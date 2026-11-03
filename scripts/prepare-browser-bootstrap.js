'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { loadOperatorRuntimeConfig } = require('../backend/runtime/operator-config');
const { createPool } = require('../backend/postgres/connection');
const { createFileSecretProvider } = require('../backend/runtime/file-secret-provider');
const { loadSecretProvider, loadLocalSecretProvider } = require('../backend/runtime/secret-provider');
const { appendOperatorAudit } = require('../backend/runtime/operator-audit');

async function main() {
  if (stdin.isTTY !== true || stdout.isTTY !== true || !isLocalTermuxOperator(process.platform, process.env) ||
      !process.argv.includes('--confirm-database=rotamoto'))
    throw safeError('BOOTSTRAP_TTY_REQUIRED', 'Use um terminal local interativo do Termux, sem SSH, e confirme --confirm-database=rotamoto.');
  // The HTTP runtime intentionally does not receive keystore paths. Resolve
  // the private operator configuration rather than relying on shell exports.
  let config;
  try { config = await loadOperatorRuntimeConfig(); }
  catch (error) {
    throw safeError('BOOTSTRAP_OPERATOR_CONFIGURATION_INVALID',
      'A configuração privada do operador não passou na validação.', error);
  }
  const database = new URL(config.databaseUrl);
  if (config.nodeEnv === 'test' || database.pathname !== '/rotamoto' ||
      !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(database.hostname) ||
      decodeURIComponent(database.username) !== 'rotamoto_app' || database.password)
    throw safeError('BOOTSTRAP_TARGET_INVALID', 'A autorização só pode ser preparada para o serviço local rotamoto_app/rotamoto.');

  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    if (await terminal.question('Digite PREPARAR PRIMEIRA INSTALACAO para emitir uma autorização de uso único: ') !==
        'PREPARAR PRIMEIRA INSTALACAO') throw safeError('BOOTSTRAP_CONFIRMATION_REQUIRED', 'Confirmação local não reconhecida.');
  } finally { terminal.close(); }

  let secrets;
  try { secrets = await loadConfiguredSecretProvider(config); }
  catch (error) {
    throw safeError('BOOTSTRAP_KEYSTORE_UNAVAILABLE', 'O keystore não passou na validação local.', error);
  }
  if (!secrets || typeof secrets.put !== 'function' || typeof secrets.get !== 'function' || typeof secrets.remove !== 'function')
    throw safeError('BOOTSTRAP_KEYSTORE_UNAVAILABLE', 'Configure um keystore protegido com leitura, gravação e remoção antes da instalação.');
  try { await verifyKeystore(secrets); }
  catch (error) { throw safeError('BOOTSTRAP_KEYSTORE_UNAVAILABLE', 'O keystore não passou na verificação local.', error); }

  const pool = createPool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 3000,
    application_name: 'rotamoto-browser-bootstrap-operator' });
  let capability = Buffer.alloc(0);
  let digest = Buffer.alloc(0);
  let client;
  let committed = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    const issued = await issueBrowserBootstrapAuthorization(client);
    capability = issued.capability;
    digest = issued.digest;
    await client.query('COMMIT'); committed = true;
    try {
      await appendOperatorAudit('identity.bootstrap.browser_authorization_prepared',
        { database: 'rotamoto', expiresInMinutes: 10 }, config.operatorAudit);
    } catch (error) {
      throw safeError('BOOTSTRAP_AUDIT_UNAVAILABLE',
        'A auditoria local falhou; a autorização não será disponibilizada.', error);
    }
    stdout.write('\nAutorização inicial (válida por 10 minutos; use uma única vez):\n');
    stdout.write(`${capability.toString('base64url')}\n\n`);
    stdout.write('Cole o código somente na página local de primeira instalação. Não o salve nem o envie a outra pessoa.\n');
  } catch (error) {
    if (!committed) await client?.query('ROLLBACK').catch(() => {});
    else {
      try {
        await client?.query('BEGIN');
        await client?.query('UPDATE rotamoto.bootstrap_authorizations SET consumed_at=now() WHERE token_digest=$1 AND consumed_at IS NULL', [digest]);
        await client?.query('COMMIT');
      } catch (cleanupError) {
        await client?.query('ROLLBACK').catch(() => {});
        throw safeError('BOOTSTRAP_AUTHORIZATION_CLEANUP_FAILED',
          'Não foi possível confirmar o cancelamento seguro. Não tente outra emissão agora; aguarde a expiração e consulte o operador.', cleanupError);
      }
    }
    throw error;
  } finally {
    client?.release(); await pool.end(); capability.fill(0); digest.fill(0);
  }
}

async function loadConfiguredSecretProvider(config) {
  if (config.production) return config.secretProviderModule ? loadSecretProvider(config.secretProviderModule) :
    loadLocalSecretProvider({ directory: config.secretStoreDirectory, masterKeyFile: config.secretMasterKeyFile });
  if (config.secretStoreDirectory && config.secretMasterKeyFile)
    return createFileSecretProvider({ directory: config.secretStoreDirectory, masterKeyFile: config.secretMasterKeyFile });
  return null;
}

function isLocalTermuxOperator(platform, env) {
  const prefix = typeof env?.PREFIX === 'string' ? env.PREFIX : '';
  const termuxPrefix = /^\/data\/(?:data|user\/0)\/[A-Za-z0-9._-]+\/files\/usr$/u.test(prefix);
  const remoteShell = Boolean(env?.SSH_CONNECTION || env?.SSH_CLIENT || env?.SSH_TTY);
  return platform === 'android' && Boolean(env?.TERMUX_VERSION) && termuxPrefix && !remoteShell;
}

async function issueBrowserBootstrapAuthorization(client, randomBytes = crypto.randomBytes) {
  const identity = await client.query('SELECT current_database() AS database,current_user AS role,session_user AS session_role');
  if (identity.rows[0]?.database !== 'rotamoto' || identity.rows[0]?.role !== 'rotamoto_app' || identity.rows[0]?.session_role !== 'rotamoto_app')
    throw safeError('BOOTSTRAP_TARGET_INVALID', 'A conexão não corresponde à identidade local autorizada.');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rotamoto:browser-bootstrap-authorization',817231))");
  const status = await client.query('SELECT rotamoto.platform_admin_bootstrap_status() AS state');
  if (status.rows[0]?.state !== 'ready')
    throw safeError('BOOTSTRAP_NOT_AVAILABLE', 'O banco já possui instalação, reserva ou dados de identidade. Nenhuma autorização foi emitida.');
  const active = await client.query(`SELECT 1 FROM rotamoto.bootstrap_authorizations
    WHERE installation_scope='rotamoto' AND consumed_at IS NULL AND expires_at>now() LIMIT 1`);
  if (active.rowCount) throw safeError('BOOTSTRAP_AUTHORIZATION_EXISTS', 'Já existe uma autorização local ativa. Aguarde sua expiração antes de emitir outra.');
  const capability = randomBytes(32);
  const encodedCapability = capability.toString('base64url');
  const digest = crypto.createHash('sha256').update(encodedCapability, 'utf8').digest();
  try {
    await client.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
      VALUES($1,'rotamoto',now()+interval '10 minutes')`, [digest]);
    return { capability: Buffer.from(capability), digest: Buffer.from(digest) };
  } catch (error) {
    capability.fill(0); digest.fill(0); throw error;
  } finally { capability.fill(0); digest.fill(0); }
}

function completeInvitationConfiguration(smtp) {
  return Boolean(smtp?.host && smtp?.user && smtp?.passwordRef && smtp?.from && smtp?.baseUrl &&
    Number.isInteger(smtp?.port) && smtp.port >= 1 && smtp.port <= 65535);
}

async function verifyKeystore(provider) {
  const name = `bootstrap/preflight/${crypto.randomUUID()}`;
  const valueBytes = crypto.randomBytes(24);
  const value = valueBytes.toString('base64url');
  let secretRef;
  try {
    const stored = await provider.put({ name, scope: 'installation', value });
    secretRef = stored?.secretRef;
    if (typeof secretRef !== 'string' || !secretRef) throw new Error('invalid keystore reference');
    const readback = await provider.get(secretRef, { name, scope: 'installation' });
    if (readback !== value) throw new Error('keystore readback mismatch');
  } finally {
    valueBytes.fill(0);
    if (secretRef) await provider.remove(secretRef);
  }
}

async function verifyInvitationDelivery(provider, smtp) {
  try {
    const password = await provider.get(smtp.passwordRef, { name: 'smtp/password', scope: 'installation' });
    if (typeof password !== 'string' || password.length < 1)
      throw new Error('missing credential');
  } catch (_) {
    throw safeError('BOOTSTRAP_EMAIL_UNAVAILABLE', 'A credencial do serviço de convites não está disponível no keystore. Nenhum convite foi enviado.');
  }
}

function safeError(code, message, cause) {
  const error = Object.assign(new Error(message), { code });
  if (cause) error.cause = cause;
  return error;
}

function classifySafeFailure(error) {
  const known = {
    BOOTSTRAP_TTY_REQUIRED: 'Preparação disponível somente no terminal local interativo do Termux, sem SSH.',
    BOOTSTRAP_TARGET_INVALID: 'O alvo ou a identidade da conexão não corresponde ao serviço autorizado.',
    BOOTSTRAP_CONFIRMATION_REQUIRED: 'A confirmação local não foi reconhecida.',
    BOOTSTRAP_KEYSTORE_UNAVAILABLE: 'O keystore não passou na verificação local.',
    BOOTSTRAP_EMAIL_UNAVAILABLE: 'O serviço de convites não passou na verificação local.',
    BOOTSTRAP_NOT_AVAILABLE: 'O banco já possui estado de instalação; nenhuma autorização foi emitida.',
    BOOTSTRAP_AUTHORIZATION_EXISTS: 'Já há autorização local ativa; nenhuma autorização adicional foi emitida.',
    BOOTSTRAP_AUDIT_UNAVAILABLE: 'A auditoria local falhou; a autorização foi cancelada com segurança.',
    BOOTSTRAP_AUTHORIZATION_CLEANUP_FAILED: 'Não foi possível confirmar o cancelamento seguro. Não tente outra emissão agora; aguarde a expiração e consulte o operador.',
    BOOTSTRAP_OPERATOR_CONFIGURATION_INVALID: 'A configuração privada do operador está inválida.',
    BOOTSTRAP_DATABASE_UNAVAILABLE: 'Não foi possível conectar ao PostgreSQL local; nenhuma autorização foi emitida.',
    BOOTSTRAP_DATABASE_PERMISSION_DENIED: 'O papel autorizado não tem os privilégios SQL necessários.',
    BOOTSTRAP_DATABASE_BUSY: 'O PostgreSQL está ocupado; nenhuma autorização foi emitida.',
    BOOTSTRAP_DATABASE_SCHEMA_UNAVAILABLE: 'O schema do Bootstrap não está disponível ou está incompatível.',
    BOOTSTRAP_AUTHORIZATION_CONFLICT: 'O estado de autorização mudou durante a operação; tente novamente após verificar o status.'
  };
  const byCause = new Set();
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && depth < 8 && !seen.has(current); depth += 1, current = current.cause) {
    seen.add(current);
    if (known[current.code]) return { code: current.code, message: known[current.code] };
    const code = current.code;
    if (code === 'OPERATOR_AUDIT_CONFIGURATION_REQUIRED' || code === 'EACCES' || code === 'EPERM')
      byCause.add('BOOTSTRAP_AUDIT_UNAVAILABLE');
    else if (code === 'SECRET_STORE_CONFIGURATION_INVALID') byCause.add('BOOTSTRAP_KEYSTORE_UNAVAILABLE');
    else if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', '57P01', '57P03'].includes(code))
      byCause.add('BOOTSTRAP_DATABASE_UNAVAILABLE');
    else if (code === '42501') byCause.add('BOOTSTRAP_DATABASE_PERMISSION_DENIED');
    else if (['55P03', '57014'].includes(code)) byCause.add('BOOTSTRAP_DATABASE_BUSY');
    else if (['42P01', '42883', '3F000'].includes(code)) byCause.add('BOOTSTRAP_DATABASE_SCHEMA_UNAVAILABLE');
    else if (code === '23505') byCause.add('BOOTSTRAP_AUTHORIZATION_CONFLICT');
    else if (code === 'OPERATOR_CONFIGURATION_INVALID') byCause.add('BOOTSTRAP_OPERATOR_CONFIGURATION_INVALID');
  }
  const priority = ['BOOTSTRAP_AUDIT_UNAVAILABLE', 'BOOTSTRAP_KEYSTORE_UNAVAILABLE',
    'BOOTSTRAP_DATABASE_PERMISSION_DENIED', 'BOOTSTRAP_DATABASE_SCHEMA_UNAVAILABLE',
    'BOOTSTRAP_DATABASE_BUSY', 'BOOTSTRAP_DATABASE_UNAVAILABLE',
    'BOOTSTRAP_AUTHORIZATION_CONFLICT', 'BOOTSTRAP_OPERATOR_CONFIGURATION_INVALID'];
  const code = priority.find(candidate => byCause.has(candidate));
  return code ? { code, message: known[code] } : {
    code: 'BOOTSTRAP_PREPARATION_FAILED',
    message: 'Preparação não concluída. Consulte o operador local sem compartilhar diagnósticos sensíveis.'
  };
}

function reportSafeFailure(error) {
  const safe = classifySafeFailure(error);
  const code = safe.code;
  process.stderr.write(`${JSON.stringify({ event: 'identity.bootstrap.browser_authorization_failed', code })}\n`);
  process.stderr.write(`${safe.message}\n`);
  process.exitCode = 1;
}

if (require.main === module) main().catch(reportSafeFailure);

module.exports = Object.freeze({ completeInvitationConfiguration, verifyKeystore, verifyInvitationDelivery,
  isLocalTermuxOperator, loadConfiguredSecretProvider, classifySafeFailure });
