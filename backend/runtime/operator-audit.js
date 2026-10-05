'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
async function appendOperatorAudit(action, details = {}) {
  const file = process.env.ROTAMOTO_OPERATOR_AUDIT_LOG, actorRef = process.env.ROTAMOTO_OPERATOR_ACTOR_REF;
  if (!file || !path.isAbsolute(file) || !actorRef || !/^[A-Za-z0-9_.:@/-]{1,128}$/u.test(actorRef) || !/^[a-z][a-z0-9_.-]{2,63}$/u.test(action)) throw new Error('Identidade e arquivo privado de auditoria do operador são obrigatórios.');
  const flags = require('node:fs').constants.O_CREAT | require('node:fs').constants.O_APPEND | require('node:fs').constants.O_WRONLY | (require('node:fs').constants.O_NOFOLLOW || 0);
  const handle = await fs.open(file, flags, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) || stat.nlink !== 1) throw new Error('Arquivo de auditoria do operador inseguro.');
    const safeDetails = Object.fromEntries(Object.entries(details).filter(([key,value]) => /^[a-zA-Z0-9_.-]{1,48}$/u.test(key) && !/(?:secret|password|token|email|path|url)/iu.test(key) &&
      (typeof value === 'string' && value.length <= 160 || typeof value === 'number' || typeof value === 'boolean')));
    await handle.write(`${JSON.stringify({ at: new Date().toISOString(), actorRef, action, details: safeDetails })}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}
module.exports = { appendOperatorAudit };
