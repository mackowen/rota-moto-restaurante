'use strict';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function targetError() {
  const error = new Error('Bootstrap local aceito somente no ambiente E2E rotamoto_e2e.');
  error.code = 'E2E_BOOTSTRAP_TARGET_INVALID';
  return error;
}

function resolveE2eBootstrapTarget(env = process.env) {
  if (env.NODE_ENV !== 'test' || env.ROTAMOTO_E2E_CAMPAIGN !== '0243' || env.DATABASE_URL ||
      env.MIGRATOR_DATABASE_URL || env.ROTAMOTO_SECRET_PROVIDER_MODULE || env.SMTP_HOST || env.SMTP_USER ||
      env.SMTP_FROM || env.PUBLIC_BASE_URL) throw targetError();
  let url;
  try { url = new URL(env.E2E_RUNTIME_DATABASE_URL || ''); } catch (_) { throw targetError(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.password ||
      decodeURIComponent(url.username) !== 'rotamoto_e2e_app' || url.pathname !== '/rotamoto_e2e' ||
      !LOOPBACK.has(url.hostname.toLowerCase()) || url.hash || [...url.searchParams.keys()].length) throw targetError();
  const port = Number(url.port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw targetError();
  return Object.freeze({ connectionString: url.toString(), host: url.hostname.toLowerCase(), port,
    database: 'rotamoto_e2e', sessionUser: 'rotamoto_e2e_app', applicationRole: 'rotamoto_app' });
}

function validateE2eDatabaseIdentity(row) {
  if (!row || row.database !== 'rotamoto_e2e' || row.current_user !== 'rotamoto_app' ||
      row.session_user !== 'rotamoto_e2e_app' || !LOOPBACK.has(String(row.server_address || '').toLowerCase())) {
    const error = new Error('Identidade PostgreSQL não corresponde ao runtime E2E isolado.');
    error.code = 'E2E_BOOTSTRAP_IDENTITY_MISMATCH';
    throw error;
  }
  return true;
}

module.exports = { resolveE2eBootstrapTarget, validateE2eDatabaseIdentity };
