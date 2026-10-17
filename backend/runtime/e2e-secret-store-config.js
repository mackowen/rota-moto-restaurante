'use strict';

const path = require('node:path');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const CAMPAIGN = '0243';

function configurationError() {
  const error = new Error('E2E secret-store configuration is not permitted for this runtime.');
  error.code = 'E2E_SECRET_STORE_CONFIGURATION_INVALID';
  return error;
}

function inside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function resolveE2eSecretStore(env = process.env, { repositoryRoot = path.resolve(__dirname, '../..') } = {}) {
  const directory = env.ROTAMOTO_E2E_SECRET_STORE_DIRECTORY || null;
  const masterKeyFile = env.ROTAMOTO_E2E_SECRET_MASTER_KEY_FILE || null;
  if (!directory && !masterKeyFile) return null;
  if (!directory || !masterKeyFile || env.NODE_ENV !== 'test' || env.ROTAMOTO_E2E_CAMPAIGN !== CAMPAIGN ||
      env.ROTAMOTO_E2E_RUNTIME_ROLE !== 'rotamoto_e2e_app' || env.DATABASE_URL || env.MIGRATOR_DATABASE_URL ||
      env.ROTAMOTO_SECRET_PROVIDER_MODULE || env.ROTAMOTO_SECRET_STORE_DIRECTORY || env.ROTAMOTO_SECRET_MASTER_KEY_FILE ||
      !path.isAbsolute(directory) || !path.isAbsolute(masterKeyFile) ||
      inside(repositoryRoot, directory) || inside(repositoryRoot, masterKeyFile)) throw configurationError();
  let database;
  try { database = new URL(env.E2E_RUNTIME_DATABASE_URL || ''); } catch (_) { throw configurationError(); }
  const hostname = database.hostname.toLowerCase();
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.password ||
      decodeURIComponent(database.username) !== 'rotamoto_e2e_app' || database.pathname !== '/rotamoto_e2e' ||
      !LOOPBACK.has(hostname) || database.hash || [...database.searchParams.keys()].some(key => key !== 'sslmode')) {
    throw configurationError();
  }
  return Object.freeze({ directory: path.resolve(directory), masterKeyFile: path.resolve(masterKeyFile) });
}

module.exports = { resolveE2eSecretStore };
