'use strict';

const assert = require('node:assert/strict');
const { assertOfficialOperatorConfig, applyOfficialOperatorConfig } = require('../scripts/official-api-runtime');

const config = { nodeEnv: 'development', production: false, databaseName: 'rotamoto', databaseUser: 'rotamoto_app',
  databaseSessionUser: 'rotamoto_app', host: '127.0.0.1', port: 8788,
  secretStoreDirectory: '/private/identity/keystore', secretMasterKeyFile: '/private/identity/keys/master.key',
  smtp: { host: 'smtp.gmail.com', port: 465, secure: true, user: 'operator-account',
    passwordRef: 'local-v1:00000000-0000-4000-8000-000000000000', from: 'RotaMoto <operator@example.invalid>', baseUrl: null } };
assert.equal(assertOfficialOperatorConfig(config), config);
const env = { NODE_ENV: 'development', DATABASE_URL: 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto' };
applyOfficialOperatorConfig(config, env);
assert.equal(env.ROTAMOTO_SECRET_STORE_DIRECTORY, config.secretStoreDirectory);
assert.equal(env.ROTAMOTO_SECRET_MASTER_KEY_FILE, config.secretMasterKeyFile);
assert.equal(env.ROTAMOTO_OFFICIAL_OPERATOR_CONFIG, 'true');
assert.equal(env.SMTP_HOST, 'smtp.gmail.com');
assert.equal(env.SMTP_PORT, '465');
assert.equal(env.SMTP_SECURE, 'true');
assert.equal(env.SMTP_PASSWORD_REF, config.smtp.passwordRef, 'only the reference, never the secret value, reaches process configuration');
assert.equal(env.PUBLIC_BASE_URL, '', 'missing public URL remains unconfigured');
assert.equal(env.DATABASE_URL, 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto');
const configured = { ...config, smtp: { ...config.smtp, baseUrl: 'https://restaurante.example.org/app' } };
assert.equal(assertOfficialOperatorConfig(configured), configured);
const configuredEnv = { ALLOWED_ORIGINS: 'http://127.0.0.1:8083' };
applyOfficialOperatorConfig(configured, configuredEnv);
assert.equal(configuredEnv.ALLOWED_ORIGINS, 'http://127.0.0.1:8083,https://restaurante.example.org');
for (const baseUrl of ['http://restaurante.example.org', 'https://localhost/app', 'https://user:pass@restaurante.example.org'])
  assert.throws(() => assertOfficialOperatorConfig({ ...config, smtp: { ...config.smtp, baseUrl } }),
    { code: 'OFFICIAL_PUBLIC_URL_INVALID' });
for (const patch of [
  { databaseName: 'rotamoto_e2e' }, { databaseUser: 'rotamoto_e2e_app' }, { databaseSessionUser: 'rotamoto_e2e_app' },
  { nodeEnv: 'test' }, { production: true }, { host: '0.0.0.0' }, { port: 8787 },
  { secretStoreDirectory: null }, { secretMasterKeyFile: null }
]) assert.throws(() => assertOfficialOperatorConfig({ ...config, ...patch }), { code: 'OFFICIAL_RUNTIME_TARGET_INVALID' });

console.log('official API operator config: exact rotamoto target, local keystore, private SMTP reference, and fail-closed target guards PASS');
