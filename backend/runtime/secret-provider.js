'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { contextOf } = require('./file-secret-provider');

function loadSecretProvider(modulePath) {
  if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath)) {
    throw new Error('ROTAMOTO_SECRET_PROVIDER_MODULE deve apontar para um módulo absoluto externo ao repositório.');
  }
  const projectRoot=fs.realpathSync(path.resolve(__dirname,'../..'));
  const providerPath=fs.realpathSync(modulePath);
  const relative=path.relative(projectRoot,providerPath);
  if(relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)))
    throw new Error('Secret provider deve estar fora do repositório.');
  const provider = require(providerPath);
  if (!provider || typeof provider.getDatabasePassword !== 'function') {
    throw new Error('Secret provider não implementa getDatabasePassword.');
  }
  const wrapped = {
    async get(ref, context) {
      if (typeof provider.get !== 'function') throw new Error('Secret provider não implementa get(ref, context).');
      validateReference(ref);
      const value = await provider.get(ref, Object.freeze({ ...contextOf(context || {}) }));
      if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 16384)
        throw new Error('Secret provider retornou valor inválido.');
      return value;
    },
    async getDatabasePassword(context) {
      const password = await provider.getDatabasePassword(Object.freeze({ ...context }));
      if (typeof password !== 'string' || password.length < 1 || password.length > 4096) {
        throw new Error('Secret provider retornou credencial inválida.');
      }
      return password;
    }
  };
  if (typeof provider.put === 'function') {
    wrapped.put = async input => {
      if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['name', 'scope', 'tenantId', 'value', 'ref'].includes(key)))
        throw new Error('Parâmetros de escrita do keystore inválidos.');
      const context = contextOf({ name: input.name, scope: input.scope, tenantId: input.tenantId ?? null });
      if (typeof input.value !== 'string' || Buffer.byteLength(input.value, 'utf8') < 1 ||
          Buffer.byteLength(input.value, 'utf8') > 16 * 1024)
        throw new Error('Secret fora do limite permitido.');
      if (input.ref !== undefined && input.ref !== null) validateReference(input.ref);
      const result = await provider.put(Object.freeze({ ...context, value: input.value,
        ...(input.ref == null ? {} : { ref: input.ref }) }));
      validateReference(result?.secretRef);
      return Object.freeze({ secretRef: result.secretRef });
    };
  }
  if (typeof provider.remove === 'function') {
    wrapped.remove = async ref => provider.remove(validateReference(ref));
  }
  return Object.freeze(wrapped);
}

function validateReference(ref) {
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 512 || /[\u0000-\u001f\u007f]/u.test(ref))
    throw new Error('Referência de secret inválida.');
  return ref;
}

function loadLocalSecretProvider({ directory, masterKeyFile }) {
  const { createFileSecretProvider } = require('./file-secret-provider');
  return createFileSecretProvider({ directory, masterKeyFile }).then(provider => Object.freeze({
    ...provider,
    async getDatabasePassword() {
      const reference = process.env.ROTAMOTO_DATABASE_PASSWORD_REF;
      if (typeof reference !== 'string' || !reference) throw new Error('ROTAMOTO_DATABASE_PASSWORD_REF obrigatório.');
      return provider.get(reference, { name: 'database/rotamoto_app', scope: 'installation' });
    }
  }));
}

module.exports = { loadSecretProvider, loadLocalSecretProvider };
