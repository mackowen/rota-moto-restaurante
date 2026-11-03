'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../bootstrap-wizard'), 'utf8');
const expected = {
  SMTP_DNS_FAILED: 'DNS', SMTP_TCP_REFUSED: 'TCP', SMTP_TIMEOUT: 'tempo limite',
  SMTP_STARTTLS_FAILED: 'STARTTLS', SMTP_CERTIFICATE_FAILED: 'certificado TLS',
  SMTP_AUTH_REJECTED: 'autenticação', SMTP_SENDER_REJECTED: 'remetente',
  SMTP_RECIPIENT_REJECTED: 'destinatário', SMTP_MESSAGE_REJECTED: 'rejeitou a mensagem',
  SMTP_SUBMISSION_UNKNOWN: 'pode ter sido aceita'
};
for (const [code, wording] of Object.entries(expected)) {
  assert.match(source, new RegExp(`${code}: '[^']*${wording}[^']*'`, 'u'), `${code} has a phase-specific operator message`);
}
assert.match(source, /SMTP_AUTH_REJECTED:[^\n]*senha de app válida/u);
assert.match(source, /SMTP_ACCEPTED_AUDIT_FAILED:[^\n]*servidor aceitou/u);
assert.match(source, /SMTP_ACCEPTED_CONFIGURATION_SAVE_FAILED:[^\n]*servidor aceitou/u);
assert.match(source, /smtpRetryConfirmationRequired/u);
assert.match(source, /A mensagem pode ter sido enviada; confira o estado antes de repetir/u);
assert.match(source, /SMTP_TEST_FAILED: 'O provedor não aceitou o teste/u, 'unknown errors retain the generic safe fallback');
console.log('Bootstrap SMTP error messages distinguish operational phases and retain the safe generic fallback: PASS');
