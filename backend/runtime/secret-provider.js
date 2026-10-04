'use strict';

const path = require('node:path');
const fs = require('node:fs');

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
  return Object.freeze({
    async getDatabasePassword(context) {
      const password = await provider.getDatabasePassword(Object.freeze({ ...context }));
      if (typeof password !== 'string' || password.length < 1 || password.length > 4096) {
        throw new Error('Secret provider retornou credencial inválida.');
      }
      return password;
    }
  });
}

module.exports = { loadSecretProvider };
