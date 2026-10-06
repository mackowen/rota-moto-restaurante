'use strict';

const { createClient, resolvePgpassPassword } = require('../../backend/postgres/connection');

function storedLoopbackCredential(role, database) {
  const lookup = targetDatabase => resolvePgpassPassword({ host: '127.0.0.1', port: 5432,
    database: targetDatabase, user: role }, { required: false });
  return async () => {
    const exact = await lookup(database);
    // PostgreSQL passwords belong to cluster roles. Existing local operator
    // pgpass entries for the same role can authenticate that role to the
    // isolated database; never copy or print the secret.
    if (exact) return exact;
    if (role === 'rotamoto_app' && (database === 'rotamoto_e2e' || database === 'rotamoto_disposable_0068_source')) return lookup('rotamoto');
    return undefined;
  };
}

function validateConnectionUrl(value, { database, role, nodeEnv }) {
  if (nodeEnv !== 'test') throw new Error('O lifecycle de fixtures exige NODE_ENV=test.');
  if (typeof value !== 'string' || !value) throw new Error('URL de conexão E2E ausente.');
  let parsed;
  try { parsed = new URL(value); } catch (_) { throw new Error('URL de conexão E2E inválida.'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.username !== role || parsed.password ||
      parsed.hostname !== '127.0.0.1' || parsed.port !== '5432' || parsed.pathname !== `/${database}` ||
      parsed.search || parsed.hash) {
    throw new Error(`O lifecycle E2E aceita somente ${role}@127.0.0.1:5432/${database}, sem senha/argumentos na URL.`);
  }
  return value;
}

function resolveE2eTargets(env = process.env) {
  if (env.NODE_ENV !== 'test') throw new Error('O lifecycle de fixtures exige NODE_ENV=test.');
  if (env.ROTAMOTO_DISPOSABLE_CAMPAIGN === '0068') {
    const database = 'rotamoto_disposable_0068_source';
    return Object.freeze({
      runtime: validateConnectionUrl(env.ROTAMOTO_DISPOSABLE_RUNTIME_DATABASE_URL,
        { database, role: 'rotamoto_app', nodeEnv: env.NODE_ENV }),
      migrator: validateConnectionUrl(env.ROTAMOTO_DISPOSABLE_MIGRATOR_DATABASE_URL,
        { database, role: 'rotamoto_migrator', nodeEnv: env.NODE_ENV }), database
    });
  }
  return Object.freeze({
    runtime: validateConnectionUrl(env.E2E_RUNTIME_DATABASE_URL,
      { database: 'rotamoto_e2e', role: 'rotamoto_app', nodeEnv: env.NODE_ENV }),
    migrator: validateConnectionUrl(env.E2E_MIGRATOR_DATABASE_URL,
      { database: 'rotamoto_e2e', role: 'rotamoto_migrator', nodeEnv: env.NODE_ENV })
  });
}

function createE2eClients(env = process.env, ClientType = createClient) {
  const targets = resolveE2eTargets(env); // Both targets fail closed before either client is constructed.
  const database = targets.database || 'rotamoto_e2e';
  const clientConfig = (value, role) => {
    return { connectionString: value, password: storedLoopbackCredential(role, database), connectionTimeoutMillis: 5000 };
  };
  return Object.freeze({
    runtime: new ClientType({ ...clientConfig(targets.runtime, 'rotamoto_app'),
      application_name: 'rotamoto-e2e-fixture-runtime' }),
    migrator: new ClientType({ ...clientConfig(targets.migrator, 'rotamoto_migrator'),
      application_name: 'rotamoto-e2e-fixture-verifier' })
  });
}

async function assertConnectedIdentity(client, { database = 'rotamoto_e2e', role, env = process.env }) {
  const identity = (await client.query(`SELECT current_database() AS database,current_user AS role,
    inet_server_addr()::text AS server_address,
    r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if (!identity || identity.database !== database || identity.role !== role || identity.server_address !== '127.0.0.1/32' ||
      identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolreplication || identity.rolbypassrls) {
    throw new Error('Identidade PostgreSQL E2E ou atributos do role inesperados.');
  }
  if (role === 'rotamoto_app') {
    const membership = (await client.query(`SELECT pg_has_role('rotamoto_app','rotamoto_migrator','MEMBER') AS member,
      pg_has_role('rotamoto_app','rotamoto_migrator','USAGE') AS can_set_role`)).rows[0];
    if (membership.member || membership.can_set_role) throw new Error('Runtime E2E pode herdar o role migrator.');
    const dbAcl = (await client.query(`SELECT has_database_privilege(current_user,current_database(),'CONNECT') AS connect,
      has_database_privilege(current_user,current_database(),'CREATE') AS create,
      has_database_privilege(current_user,current_database(),'TEMPORARY') AS temporary`)).rows[0];
    if (!dbAcl.connect || dbAcl.create || dbAcl.temporary) throw new Error('Privilégios de database do runtime E2E divergem do perfil aprovado.');
  }
  if (database === 'rotamoto_disposable_0068_source' &&
      (env.NODE_ENV !== 'test' || env.ROTAMOTO_DISPOSABLE_CAMPAIGN !== '0068')) {
    throw new Error('Identidade de origem descartável exige guard explícito da campanha 0068.');
  }
  return identity;
}

module.exports = { validateConnectionUrl, resolveE2eTargets, createE2eClients, assertConnectedIdentity,
  storedLoopbackCredential };
