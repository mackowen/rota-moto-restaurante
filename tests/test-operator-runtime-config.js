'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadOperatorRuntimeConfig, parseSettings } = require('../backend/runtime/operator-config');

async function main() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-operator-config-'));
  await fs.chmod(home, 0o700);
  const identity = path.join(home, 'rotamoto-data', 'identity');
  const keys = path.join(identity, 'keys');
  await fs.mkdir(keys, { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(home, 'rotamoto-data'), 0o700);
  await fs.chmod(identity, 0o700);
  await fs.chmod(keys, 0o700);
  const refFile = path.join(keys, 'smtp-password.ref');
  await fs.writeFile(refFile, 'local-v1:123e4567-e89b-42d3-a456-426614174000\n', { mode: 0o600 });

  const config = await loadOperatorRuntimeConfig({ NODE_ENV: 'development', HOME: home,
    SMTP_USER: 'mailer@example.test', SMTP_FROM: 'RotaMoto <mailer@example.test>' });
  assert.equal(config.secretStoreDirectory, path.join(identity, 'keystore'));
  assert.equal(config.secretMasterKeyFile, path.join(keys, 'master.key'));
  assert.equal(config.smtp.host, 'smtp.gmail.com');
  assert.equal(config.smtp.port, 465);
  assert.equal(config.smtp.secure, true);
  assert.equal(config.smtp.passwordRef, 'local-v1:123e4567-e89b-42d3-a456-426614174000');
  assert.deepEqual(config.operatorAudit, { file: path.join(identity, 'audit', 'operator-audit.jsonl'), actorRef: 'operator:termux-local' });
  const auditDirectory = path.dirname(config.operatorAudit.file);
  await fs.mkdir(auditDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(auditDirectory, 0o700);
  const { appendOperatorAudit } = require('../backend/runtime/operator-audit');
  await appendOperatorAudit('smtp.verify.completed', { host: 'smtp.gmail.com', password: 'must-not-be-recorded' }, config.operatorAudit);
  const audit = await fs.readFile(config.operatorAudit.file, 'utf8');
  assert.match(audit, /"actorRef":"operator:termux-local"/u);
  assert.match(audit, /"action":"smtp.verify.completed"/u);
  assert.doesNotMatch(audit, /must-not-be-recorded/u);
  const http = require('../backend/runtime/config').loadRuntimeConfig({ NODE_ENV: 'development', HOME: home,
    ROTAMOTO_SECRET_STORE_DIRECTORY: config.secretStoreDirectory, ROTAMOTO_SECRET_MASTER_KEY_FILE: config.secretMasterKeyFile });
  assert.equal(http.secretStoreDirectory, null, 'HTTP runtime remains unable to see operator keystore paths');
  assert.equal(http.operatorAudit, null, 'HTTP runtime remains unable to see the operator audit path');

  assert.throws(() => parseSettings('SMTP_PASSWORD=plaintext'), /inválida/u);
  assert.throws(() => parseSettings('SMTP_USER=a@example.test\nSMTP_USER=b@example.test'), /inválida/u);
  await fs.chmod(refFile, 0o644);
  await assert.rejects(() => loadOperatorRuntimeConfig({ NODE_ENV: 'development', HOME: home }), /inválida/u);
  await fs.rm(home, { recursive: true, force: true });
  console.log('Operator-only config loads protected SMTP references and keeps HTTP/E2E isolated: PASS');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
