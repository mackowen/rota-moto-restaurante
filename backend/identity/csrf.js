'use strict';

const crypto = require('node:crypto');

function deriveCsrfToken(sessionToken) {
  if (typeof sessionToken !== 'string' || !sessionToken) throw new TypeError('Token de sessão obrigatório.');
  return crypto.createHmac('sha256', sessionToken).update('rotamoto:csrf:v1').digest('base64url');
}

module.exports = { deriveCsrfToken };
