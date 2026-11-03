'use strict';

const path = require('node:path');
const { loadOperatorRuntimeConfig } = require('../backend/runtime/operator-config');

function assertOfficialOperatorConfig(config) {
  if (!config || config.nodeEnv !== 'development' || config.production || config.databaseName !== 'rotamoto' ||
      config.databaseUser !== 'rotamoto_app' || config.databaseSessionUser !== 'rotamoto_app' ||
      config.host !== '127.0.0.1' || config.port !== 8788 || !config.secretStoreDirectory ||
      !config.secretMasterKeyFile) {
    const error = new Error('Official local API runtime configuration rejected.');
    error.code = 'OFFICIAL_RUNTIME_TARGET_INVALID';
    throw error;
  }
  if (config.smtp.baseUrl) {
    let base;
    try { base = new URL(config.smtp.baseUrl); } catch (_) { base = null; }
    if (!base || base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
        ['127.0.0.1', '::1', 'localhost'].includes(base.hostname.toLowerCase()) || base.hostname.endsWith('.localhost')) {
      const error = new Error('Official invitation URL must be a public HTTPS origin without credentials.');
      error.code = 'OFFICIAL_PUBLIC_URL_INVALID';
      throw error;
    }
  }
  return config;
}

function applyOfficialOperatorConfig(config, env = process.env) {
  assertOfficialOperatorConfig(config);
  env.ROTAMOTO_OFFICIAL_OPERATOR_CONFIG = 'true';
  env.ROTAMOTO_SECRET_STORE_DIRECTORY = config.secretStoreDirectory;
  env.ROTAMOTO_SECRET_MASTER_KEY_FILE = config.secretMasterKeyFile;
  env.ROTAMOTO_SMTP_CONFIG_FILE = path.join(path.dirname(config.secretStoreDirectory), 'smtp-config.json');
  if (config.operatorAudit?.file && config.operatorAudit?.actorRef) {
    env.ROTAMOTO_OPERATOR_AUDIT_LOG = config.operatorAudit.file;
    env.ROTAMOTO_OPERATOR_ACTOR_REF = config.operatorAudit.actorRef;
    env.ROTAMOTO_SMTP_DIAGNOSTIC_LOG = path.join(path.dirname(config.operatorAudit.file), 'smtp-diagnostics.jsonl');
  }
  env.SMTP_HOST = config.smtp.host || '';
  env.SMTP_PORT = String(config.smtp.port);
  env.SMTP_SECURE = String(config.smtp.secure);
  env.SMTP_USER = config.smtp.user || '';
  env.SMTP_PASSWORD_REF = config.smtp.passwordRef || '';
  env.SMTP_FROM = config.smtp.from || '';
  env.PUBLIC_BASE_URL = config.smtp.baseUrl || '';
  if (config.smtp.baseUrl) {
    const origin = new URL(config.smtp.baseUrl).origin;
    env.ALLOWED_ORIGINS = [...new Set([...(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean), origin])].join(',');
  }
  return env;
}

async function startOfficialApi(env = process.env) {
  const config = assertOfficialOperatorConfig(await loadOperatorRuntimeConfig(env));
  applyOfficialOperatorConfig(config, env);
  const api = require('../server');
  return api.startServer({ config: api.CONFIG });
}

if (require.main === module) {
  startOfficialApi().catch(error => {
    const code = /^[A-Z][A-Z0-9_]{1,63}$/u.test(error?.code || '') ? error.code : 'OFFICIAL_RUNTIME_START_FAILED';
    process.stderr.write(`${JSON.stringify({ event: 'official_api.bootstrap_failed', code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertOfficialOperatorConfig, applyOfficialOperatorConfig, startOfficialApi };
