'use strict';

const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { StringDecoder } = require('node:string_decoder');
const { stdin, stdout, stderr } = require('node:process');
const { createPool } = require('../backend/postgres/connection');
const { createIdentityService } = require('../backend/identity/service');
const { createEmailDeliveryProvider } = require('../backend/identity/email-provider');
const { createNativeMfaProvider } = require('../backend/identity/native-mfa-provider');
const { validatePassword } = require('../backend/identity/passwords');
const { createFileSecretProvider } = require('../backend/runtime/file-secret-provider');
const { resolveE2eSecretStore } = require('../backend/runtime/e2e-secret-store-config');
const { resolveE2eBootstrapTarget, validateE2eDatabaseIdentity } = require('../backend/identity/e2e-bootstrap-guard');

const CONFIRMATION = 'CRIAR PRIMEIRO PROPRIETARIO E2E';

function cleanLine(value, label, maxBytes) {
  const normalized = String(value || '').trim().normalize('NFC');
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw Object.assign(new Error(`${label} inválido.`), { code: 'E2E_BOOTSTRAP_INPUT_INVALID' });
  }
  return normalized;
}

function promptHidden(label) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') throw Object.assign(new Error('TTY seguro obrigatório.'), { code: 'E2E_BOOTSTRAP_TTY_REQUIRED' });
  stdout.write(label);
  const decoder = new StringDecoder('utf8');
  let value = '';
  const previousRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    const finish = (error = null) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(previousRaw);
      stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const char of decoder.write(chunk)) {
        if (char === '\u0003') { value = ''; finish(Object.assign(new Error('Entrada cancelada.'), { code: 'E2E_BOOTSTRAP_CANCELLED' })); return; }
        if (char === '\r' || char === '\n') { finish(); return; }
        if (char === '\u007f' || char === '\b') { value = [...value].slice(0, -1).join(''); continue; }
        if (char >= ' ' && char !== '\u007f') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

function equalSecret(left, right) {
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); }
  finally { a.fill(0); b.fill(0); }
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY || !process.argv.includes('--confirm-environment=e2e') ||
      !process.argv.includes('--confirm-database=rotamoto_e2e')) {
    throw Object.assign(new Error('Bootstrap E2E exige TTY e confirmações explícitas do ambiente e banco.'), { code: 'E2E_BOOTSTRAP_CONFIRMATION_REQUIRED' });
  }
  const target = resolveE2eBootstrapTarget(process.env);
  const store = resolveE2eSecretStore(process.env);
  if (!store) throw Object.assign(new Error('Keystore privado exclusivo do E2E é obrigatório.'), { code: 'E2E_SECRET_STORE_CONFIGURATION_INVALID' });
  const secretProvider = await createFileSecretProvider(store);
  const visiblePrompt = readline.createInterface({ input: stdin, output: stdout });
  let companyName, ownerEmail;
  try {
    companyName = cleanLine(await visiblePrompt.question('Empresa de homologação: '), 'Empresa', 160);
    ownerEmail = cleanLine(await visiblePrompt.question('Email de teste do proprietário (não será enviado): '), 'Email', 320).toLowerCase();
    if ((await visiblePrompt.question(`Digite ${CONFIRMATION} para continuar: `)) !== CONFIRMATION) {
      throw Object.assign(new Error('Confirmação local não reconhecida.'), { code: 'E2E_BOOTSTRAP_CONFIRMATION_REQUIRED' });
    }
  } finally { visiblePrompt.close(); }
  const password = await promptHidden('Senha inicial (mínimo 12 bytes; entrada oculta): ');
  const confirmation = await promptHidden('Repita a senha (entrada oculta): ');
  if (!equalSecret(password, confirmation)) throw Object.assign(new Error('As senhas não coincidem.'), { code: 'E2E_BOOTSTRAP_PASSWORD_MISMATCH' });
  validatePassword(password);

  const pool = createPool({ connectionString: target.connectionString, options: '-c role=rotamoto_app', max: 2,
    connectionTimeoutMillis: 3000, application_name: 'rotamoto-e2e-bootstrap-0243', statement_timeout: 5000 });
  const capability = crypto.randomBytes(32);
  const capabilityDigest = crypto.createHash('sha256').update(capability).digest();
  const idempotencyKey = `bootstrap-e2e-0243-${crypto.randomUUID()}`;
  let client, invitationToken = null, activePassword = password;
  try {
    client = await pool.connect();
    const identity = await client.query(`SELECT current_database() AS database,current_user,session_user,
      host(inet_server_addr()) AS server_address`);
    validateE2eDatabaseIdentity(identity.rows[0]);
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    const latch = await client.query(`SELECT completed_at,request_digest FROM rotamoto.installation_bootstrap
      WHERE singleton=true FOR UPDATE`);
    if (latch.rowCount !== 1 || latch.rows[0].completed_at !== null || latch.rows[0].request_digest !== null) {
      throw Object.assign(new Error('O latch não está disponível; nenhuma instalação será repetida.'), { code: 'BOOTSTRAP_ALREADY_INITIALIZED' });
    }
    const counts = await client.query(`SELECT
      (SELECT count(*)::int FROM rotamoto.companies) AS companies,
      (SELECT count(*)::int FROM rotamoto.users) AS users,
      (SELECT count(*)::int FROM rotamoto.provisioning_requests) AS provisionings`);
    if (counts.rows[0].companies || counts.rows[0].users || counts.rows[0].provisionings) {
      throw Object.assign(new Error('O E2E contém dados de identidade; instalação recusada sem reset.'), { code: 'E2E_NOT_EMPTY' });
    }
    await client.query(`UPDATE rotamoto.bootstrap_authorizations SET consumed_at=now()
      WHERE consumed_at IS NULL AND expires_at>now()`);
    await client.query(`INSERT INTO rotamoto.bootstrap_authorizations(token_digest,installation_scope,expires_at)
      VALUES($1,'rotamoto',now()+interval '10 minutes')`, [capabilityDigest]);
    await client.query('COMMIT');
    client.release(); client = null;

    const emailProvider = createEmailDeliveryProvider(async message => {
      if (message.kind !== 'owner_invitation' || message.to !== ownerEmail || typeof message.token !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/u.test(message.token) || invitationToken) {
        throw Object.assign(new Error('Entrega local de convite inválida.'), { code: 'E2E_LOCAL_MAIL_CAPTURE_INVALID' });
      }
      invitationToken = message.token;
      return { accepted: true };
    });
    const identityService = createIdentityService({ pool, emailProvider, secretProvider,
      mfaProvider: createNativeMfaProvider({ secretProvider }), requireBootstrapAuthorization: true,
      authorizeProvisioner: async () => ({ actorRef: 'campaign-0243-local-e2e-operator', bootstrapCapabilityDigest: Buffer.from(capabilityDigest) }) });
    const provisioned = await identityService.provisionInitialOwner({ companyName, email: ownerEmail, idempotencyKey });
    if (provisioned.delivery !== 'sent' || !invitationToken) {
      throw Object.assign(new Error('Convite não foi capturado localmente.'), { code: 'E2E_LOCAL_MAIL_CAPTURE_FAILED' });
    }
    await identityService.consumeOwnerInvitation({ token: invitationToken, password: activePassword });
    invitationToken = null;
    activePassword = null;
    stdout.write(`${JSON.stringify({ event: 'e2e_owner_activated', company: companyName,
      emailDelivery: 'local_capture_no_network', invitationConsumed: true, passwordSet: true, bootstrap: 'complete' })}\n`);
  } finally {
    if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
    await pool.end();
    capability.fill(0); capabilityDigest.fill(0);
    invitationToken = null; activePassword = null;
  }
}

main().catch(error => {
  const code = /^[A-Z0-9_]{2,48}$/u.test(error?.code || '') ? error.code : 'E2E_BOOTSTRAP_FAILED';
  stderr.write(`${JSON.stringify({ event: 'e2e_bootstrap_failed', code })}\n`);
  process.exitCode = 1;
});
