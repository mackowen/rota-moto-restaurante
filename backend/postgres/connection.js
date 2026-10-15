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
function createPool(options) {
  const pool=new Pool(withExplicitPassword(options));
  // pg-pool emits `error` when an idle client loses its socket. Without a pool
  // listener EventEmitter treats that expected outage as an uncaught exception
  // and terminates long-running API/worker processes. Keep the diagnostic
  // useful while excluding server messages, connection strings and credentials.
  pool.on('error',error=>{
    try {
      const code=typeof error?.code==='string'&&/^[A-Z0-9_]{2,10}$/u.test(error.code)?error.code:'DATABASE_ERROR';
      process.stderr.write(`${JSON.stringify({event:'postgres.pool.error',code})}\n`);
    } catch(_) {}
  });
  // pg-pool removes its idle-client error listener while a client is checked
  // out. A socket loss in that window can otherwise emit an unhandled Client
  // error and terminate the API process before the active query can recover.
  // Query/transaction callers still receive the rejected operation; this
  // listener only contains the EventEmitter error path for the checked-out
  // client. Idle client failures continue through pg-pool's own listener.
  pool.on('connect',client=>client.on('error',()=>{}));
  return pool;
}

module.exports = { connectionTarget, resolvePgpassPassword, withExplicitPassword, createClient, createPool };
