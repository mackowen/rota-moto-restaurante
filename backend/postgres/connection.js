'use strict';

const { Client, Pool } = require('pg');
const pgpass = require('pgpass');
const { parse: parseConnectionString } = require('pg-connection-string');

function connectionTarget(connectionString) {
  let url;
  try { url = new URL(connectionString); } catch (_) { throw new Error('Connection string PostgreSQL inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.password) {
    throw new Error('Connection string PostgreSQL deve ser válida e não pode conter senha.');
  }
  const target = {
    host: url.hostname || 'localhost',
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username || process.env.USER || '')
  };
  if (!target.user || !target.database || !Number.isInteger(target.port)) throw new Error('Alvo PostgreSQL incompleto.');
  return target;
}

function resolvePgpassPassword(target, { required = true } = {}) {
  return new Promise((resolve, reject) => {
    pgpass(target, password => {
      if (typeof password !== 'string') return required ? reject(new Error('Credencial PostgreSQL não encontrada no pgpass.')) : resolve(null);
      resolve(password);
    });
  });
}

function withExplicitPassword(options = {}) {
  const connectionString = options.connectionString;
  if (typeof connectionString !== 'string') throw new TypeError('connectionString PostgreSQL é obrigatório.');
  const target = connectionTarget(connectionString);
  const parsed = parseConnectionString(connectionString);
  const configured = options.password;
  const password = typeof configured === 'function' ? configured :
    (typeof configured === 'string' ? async () => configured : async () => resolvePgpassPassword(target));
  const { connectionString: _connectionString, ...rest } = options;
  return { ...parsed, ...rest, password };
}

function createClient(options) { return new Client(withExplicitPassword(options)); }
function createPool(options) { return new Pool(withExplicitPassword(options)); }

module.exports = { connectionTarget, resolvePgpassPassword, withExplicitPassword, createClient, createPool };
