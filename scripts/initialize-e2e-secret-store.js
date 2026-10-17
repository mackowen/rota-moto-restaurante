'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { stdin, stdout, stderr } = require('node:process');
const { resolveE2eSecretStore } = require('../backend/runtime/e2e-secret-store-config');
const { initializeFileSecretStore } = require('../backend/runtime/file-secret-provider');

const CONFIRMATION = 'CRIAR CHAVE LOCAL E2E 0243';

async function ensurePrivateDirectory(anchor, target) {
  const base = path.resolve(anchor), resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    const error = new Error('Path privado E2E fora da raiz de dados.'); error.code = 'E2E_SECRET_PATH_INVALID'; throw error;
  }
  const components = [];
  let cursor = base;
  for (const part of relative.split(path.sep).filter(Boolean)) { cursor = path.join(cursor, part); components.push(cursor); }
  for (const directory of [base, ...components]) {
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077)) {
      const error = new Error('Diretórios de dados E2E devem ser privados, próprios e sem symlink.'); error.code = 'E2E_SECRET_PATH_INVALID'; throw error;
    }
  }
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY || !process.argv.includes('--confirm-e2e-secret-store=0243')) {
    const error = new Error('Exige TTY e --confirm-e2e-secret-store=0243.'); error.code = 'E2E_SECRET_STORE_CONFIRMATION_REQUIRED'; throw error;
  }
  const store = resolveE2eSecretStore(process.env);
  if (!store) { const error = new Error('Configuração de keystore E2E ausente.'); error.code = 'E2E_SECRET_STORE_CONFIGURATION_INVALID'; throw error; }
  const readLine = require('node:readline/promises').createInterface({ input: stdin, output: stdout });
  let answer;
  try { answer = await readLine.question(`Confirme digitando exatamente: ${CONFIRMATION}\n> `); }
  finally { readLine.close(); }
  if (answer !== CONFIRMATION) { const error = new Error('Confirmação local não reconhecida.'); error.code = 'E2E_SECRET_STORE_CONFIRMATION_REQUIRED'; throw error; }
  const privateRoot = path.join(require('node:os').homedir(), 'rotamoto-data');
  await ensurePrivateDirectory(privateRoot, path.dirname(store.masterKeyFile));
  await ensurePrivateDirectory(privateRoot, path.dirname(store.directory));
  try {
    await fs.lstat(store.directory);
    const error = new Error('Keystore E2E já existe; nenhuma chave será substituída.'); error.code = 'E2E_SECRET_STORE_ALREADY_EXISTS'; throw error;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await fs.lstat(store.masterKeyFile);
    const error = new Error('Chave mestre E2E já existe; nenhuma chave será substituída.'); error.code = 'E2E_SECRET_STORE_ALREADY_EXISTS'; throw error;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await initializeFileSecretStore(store);
  stdout.write('{"event":"e2e_secret_store_initialized","classification":"e2e_only"}\n');
}

main().catch(error => {
  const code = /^[A-Z0-9_]{2,48}$/u.test(error?.code || '') ? error.code : 'E2E_SECRET_STORE_INITIALIZATION_FAILED';
  stderr.write(`${JSON.stringify({ event: 'e2e_secret_store_initialization_failed', code })}\n`);
  process.exitCode = 1;
});
