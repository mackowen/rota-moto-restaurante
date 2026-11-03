'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../smtp-admin-ui'), 'utf8');
assert.match(source, /const transportActive = config\?\.transportConfigured === true/u);
assert.match(source, /const invitationLinksActive = config\?\.invitationLinksConfigured === true/u);
assert.match(source, /URL HTTPS pública dos convites \(opcional\)/u);
assert.doesNotMatch(source, /name="publicBaseUrl" type="url" autocomplete="url" required/u);
assert.match(source, /Envios de convite externo permanecem bloqueados até informar uma URL HTTPS pública/u);
assert.match(source, /Sem esta URL o SMTP pode ser testado e salvo/u);
console.log('SMTP admin settings UI: transport and external invitation readiness separated; public URL optional: PASS');
