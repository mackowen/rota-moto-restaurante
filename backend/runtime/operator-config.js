'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { loadRuntimeConfig } = require('./config');

const SETTINGS = new Set(['SMTP_USER', 'SMTP_FROM', 'PUBLIC_BASE_URL']);
const REF_PATTERN = /^local-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function configError() {
  const error = new Error('Configuração privada do operador inválida.');
  error.code = 'OPERATOR_CONFIGURATION_INVALID';
  error.safeDiagnostic = 'Revise os arquivos privados de configuração do operador';
  return error;
}

async function readPrivateText(file) {
  if (!path.isAbsolute(file || '')) throw configError();
  const components = [];
  let cursor = path.resolve(file);
  while (cursor !== path.dirname(cursor)) { components.unshift(cursor); cursor = path.dirname(cursor); }
  for (const component of components) {
    try { if ((await fs.lstat(component)).isSymbolicLink()) throw configError(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw configError(); }
  }
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw configError(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || stat.size > 4096) throw configError();
  return fs.readFile(file, 'utf8');
}

function parseSettings(text) {
  const settings = {};
  for (const raw of String(text || '').split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) throw configError();
    const key = line.slice(0, index).trim(), value = line.slice(index + 1).trim();
    if (!SETTINGS.has(key) || !value || /[\u0000-\u001f\u007f]/u.test(value) || Object.hasOwn(settings, key)) throw configError();
    settings[key] = value;
  }
  return settings;
}

async function loadOperatorRuntimeConfig(env = process.env) {
  const home = env.HOME || process.env.HOME;
  if (!path.isAbsolute(home || '')) throw configError();
  const identityDirectory = path.join(home, 'rotamoto-data', 'identity');
  const settingsFile = env.ROTAMOTO_OPERATOR_SETTINGS_FILE || path.join(identityDirectory, 'operator.env');
  const referenceFile = env.ROTAMOTO_OPERATOR_SMTP_PASSWORD_REF_FILE || path.join(identityDirectory, 'keys', 'smtp-password.ref');
  const settingsText = await readPrivateText(settingsFile);
  const referenceText = env.SMTP_PASSWORD_REF ? null : await readPrivateText(referenceFile);
  const effective = { ...env, ...parseSettings(settingsText) };
  for (const key of SETTINGS) if (env[key]) effective[key] = env[key];
  effective.ROTAMOTO_SECRET_STORE_DIRECTORY ||= path.join(identityDirectory, 'keystore');
  effective.ROTAMOTO_SECRET_MASTER_KEY_FILE ||= path.join(identityDirectory, 'keys', 'master.key');
  effective.ROTAMOTO_OPERATOR_AUDIT_LOG ||= path.join(identityDirectory, 'audit', 'operator-audit.jsonl');
  effective.ROTAMOTO_OPERATOR_ACTOR_REF ||= 'operator:termux-local';
  effective.SMTP_HOST ||= 'smtp.gmail.com';
  effective.SMTP_PORT ||= '465';
  effective.SMTP_SECURE ||= 'true';
  if (!effective.SMTP_PASSWORD_REF && referenceText !== null) {
    const ref = referenceText.trim();
    if (!REF_PATTERN.test(ref)) throw configError();
    effective.SMTP_PASSWORD_REF = ref;
  }
  return loadRuntimeConfig(effective, { context: 'operator' });
}

module.exports = { loadOperatorRuntimeConfig, parseSettings, readPrivateText };
