'use strict';

const { URL } = require('node:url');
const { isIP } = require('node:net');
const path = require('node:path');

const DEVELOPMENT_DATABASE_URL = 'postgresql://rotamoto_app@127.0.0.1:5432/rotamoto';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function parseOrigins(values, { production }) {
  const origins = [...new Set(values.flatMap(splitList))];
  for (const value of origins) {
    let parsed;
    try { parsed = new URL(value); } catch (_) { throw new Error('ALLOWED_ORIGINS contém uma origem inválida.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value ||
        production && parsed.protocol !== 'https:') {
      throw new Error('ALLOWED_ORIGINS deve conter origins exatas; produção exige HTTPS.');
    }
  }
  return Object.freeze(origins);
}

function validateDatabaseUrl(value, { production }) {
  if (!value && production) throw new Error('DATABASE_URL runtime é obrigatória em produção.');
  const connectionString = value || DEVELOPMENT_DATABASE_URL;
  let parsed;
  try { parsed = new URL(connectionString); } catch (_) { throw new Error('DATABASE_URL runtime inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== 'rotamoto_app' || parsed.password ||
      !parsed.hostname || parsed.pathname !== '/rotamoto' || parsed.hash) {
    throw new Error('DATABASE_URL deve apontar sem senha para rotamoto_app no banco rotamoto.');
  }
  const databaseHost = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (production && (LOOPBACK_HOSTS.has(databaseHost) || databaseHost.endsWith('.localhost'))) {
    throw new Error('DATABASE_URL de produção não pode usar loopback.');
  }
  if(production&&parsed.searchParams.get('sslmode')!=='verify-full')
    throw new Error('DATABASE_URL de produção exige sslmode=verify-full.');
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta PostgreSQL inválida.');
  if([...parsed.searchParams.keys()].some(key=>key!=='sslmode')||parsed.searchParams.has('password'))
    throw new Error('DATABASE_URL contém parâmetros não permitidos; segredo não pode estar na URL.');
  return connectionString;
}

function normalizeHosts(values) {
  const hosts = [...new Set(values.flatMap(splitList).map(value => value.toLowerCase()))];
  for (const host of hosts) {
    if(host==='[::1]'||host==='::1')continue;
    if (host.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::\d{1,5})?$/u.test(host)) {
      throw new Error('ALLOWED_HOSTS contém host inválido.');
    }
    const port=host.match(/:(\d+)$/u)?.[1];
    if(port&&(Number(port)<1||Number(port)>65535))throw new Error('ALLOWED_HOSTS contém porta inválida.');
  }
  return Object.freeze(hosts);
}

function loadRuntimeConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV === undefined ? 'development' : env.NODE_ENV;
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV inválido.');
  const production = nodeEnv === 'production';
  const host = env.HOST || (production ? '' : '127.0.0.1');
  if (!host || !LOOPBACK_HOSTS.has(String(host).toLowerCase())) {
    throw new Error('HOST deve ser explicitamente loopback; acesso remoto deve passar pelo proxy local.');
  }
  const port = Number(env.PORT || (production ? NaN : 8787));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida ou ausente.');
  if (production && env.MIGRATOR_DATABASE_URL) throw new Error('O processo HTTP não pode receber MIGRATOR_DATABASE_URL.');
  if (production && env.TRUST_PROXY && env.TRUST_PROXY !== 'false') {
    throw new Error('Use TRUSTED_PROXY_ADDRESSES para allowlist exata de proxies confiáveis.');
  }

  const databaseUrl = validateDatabaseUrl(env.DATABASE_URL, { production });
  const origins = parseOrigins(production ? [env.ALLOWED_ORIGINS] : [env.ALLOWED_ORIGIN || 'http://localhost:8787', env.ALLOWED_ORIGINS], { production });
  if (production && !origins.length) throw new Error('ALLOWED_ORIGINS HTTPS é obrigatória em produção.');
  const allowedHosts = normalizeHosts(production ? [env.ALLOWED_HOSTS] : [env.ALLOWED_HOSTS || 'localhost,127.0.0.1,[::1]']);
  if (production && !allowedHosts.length) throw new Error('ALLOWED_HOSTS é obrigatória em produção.');
  const trustedProxyAddresses=Object.freeze([...new Set(splitList(env.TRUSTED_PROXY_ADDRESSES))]);
  if(trustedProxyAddresses.some(address=>!isIP(address))||production&&!trustedProxyAddresses.length)
    throw new Error('TRUSTED_PROXY_ADDRESSES deve conter IPs exatos dos proxies confiáveis em produção.');
  const secretProviderModule = env.ROTAMOTO_SECRET_PROVIDER_MODULE || null;
  const secretStoreDirectory = env.ROTAMOTO_SECRET_STORE_DIRECTORY || null;
  const secretMasterKeyFile = env.ROTAMOTO_SECRET_MASTER_KEY_FILE || null;
  if (production && Boolean(secretProviderModule) === Boolean(secretStoreDirectory && secretMasterKeyFile))
    throw new Error('Configure exatamente um secret provider externo ou o keystore local completo.');
  if (Boolean(secretStoreDirectory) !== Boolean(secretMasterKeyFile) ||
      [secretStoreDirectory, secretMasterKeyFile].some(value => value && !path.isAbsolute(value)))
    throw new Error('Paths absolutos do keystore devem ser configurados em conjunto.');
  if (production && secretStoreDirectory && !env.ROTAMOTO_DATABASE_PASSWORD_REF)
    throw new Error('ROTAMOTO_DATABASE_PASSWORD_REF é obrigatória com keystore local.');
  if(production&&(!env.DATABASE_TLS_CA_FILE||!path.isAbsolute(env.DATABASE_TLS_CA_FILE)))
    throw new Error('DATABASE_TLS_CA_FILE absoluto é obrigatório em produção.');

  const smtp = Object.freeze({ host: env.SMTP_HOST || null, port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
    secure: env.SMTP_SECURE === 'true', user: env.SMTP_USER || null, passwordRef: env.SMTP_PASSWORD_REF || null,
    from: env.SMTP_FROM || null, baseUrl: env.PUBLIC_BASE_URL || null });
  const smtpConfigured = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD_REF', 'SMTP_FROM'].some(key => Boolean(env[key]));
  if (production && smtpConfigured &&
      (!smtp.host || !smtp.passwordRef || !smtp.from || !smtp.baseUrl || !Number.isInteger(smtp.port) || smtp.port < 1 || smtp.port > 65535))
    throw new Error('Configuração SMTP incompleta.');
  if (production && (smtpConfigured || smtp.baseUrl)) {
    let publicBase;
    try { publicBase = new URL(smtp.baseUrl); } catch (_) { throw new Error('PUBLIC_BASE_URL inválida.'); }
    if (publicBase.protocol !== 'https:' || publicBase.username || publicBase.password || publicBase.search || publicBase.hash)
      throw new Error('PUBLIC_BASE_URL deve ser HTTPS sem credenciais, query ou fragmento.');
  }
  const mediaDirectory = env.ROTAMOTO_MEDIA_DIRECTORY || null;
  const backupDirectory = env.ROTAMOTO_BACKUP_DIRECTORY || null;
  if ([mediaDirectory, backupDirectory].some(value => value && !path.isAbsolute(value)))
    throw new Error('Paths de storage e backup devem ser absolutos.');

  return Object.freeze({ nodeEnv, production, host, port, databaseUrl, allowedOrigins: origins, smtp, mediaDirectory, backupDirectory,
    allowedHosts, trustedProxyAddresses, trustProxy: trustedProxyAddresses.length>0,
    databaseTlsCaFile:production?env.DATABASE_TLS_CA_FILE:null, requestTimeoutMs: 30_000, headersTimeoutMs: 10_000,
    keepAliveTimeoutMs: 5_000, shutdownTimeoutMs: 10_000,
    secretProviderModule: production ? secretProviderModule : null,
    secretStoreDirectory: production ? secretStoreDirectory : null,
    secretMasterKeyFile: production ? secretMasterKeyFile : null });
}

function hostAllowed(header, allowedHosts, production = false) {
  if (typeof header !== 'string' || !header || /[\s,/@]/u.test(header)) return false;
  let parsed;
  try { parsed = new URL(`http://${header}`); } catch (_) { return false; }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  return production ? allowedHosts.includes(parsed.host.toLowerCase()) : allowedHosts.includes(parsed.hostname.toLowerCase());
}

function resolveClientAddress(req, config) {
  const peer=String(req.socket?.remoteAddress||'unknown').replace(/^::ffff:/iu,'');
  if(!config.trustedProxyAddresses.includes(peer))return peer;
  const forwarded=String(req.headers['x-forwarded-for']||'').trim();
  return isIP(forwarded)?forwarded:peer;
}

module.exports = { loadRuntimeConfig, validateDatabaseUrl, hostAllowed, resolveClientAddress, DEVELOPMENT_DATABASE_URL };
