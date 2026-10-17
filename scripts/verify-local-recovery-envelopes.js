'use strict';

// Local-only operator utility. It never accepts a passphrase through argv or
// environment and never prints recovered key material or archive contents.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const IDENTITY = path.join(os.homedir(), 'rotamoto-data', 'identity');
const MASTER_ENVELOPE = path.join(IDENTITY, 'keys', 'master-key-recovery.enc');
const KEYSTORE_ENVELOPE = path.join(IDENTITY, 'keys', 'keystore-recovery.enc');
const MASTER_KEY = path.join(IDENTITY, 'keys', 'master.key');
const SMTP_REF = path.join(IDENTITY, 'keys', 'smtp-password.ref');
const KEYSTORE = path.join(IDENTITY, 'keystore');
const OPENSSL = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'openssl') : 'openssl';
const TAR = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'tar') : 'tar';
const MV = process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'mv') : 'mv';
const META_ONLY = process.argv.includes('--metadata-only');
const SALTED = Buffer.from('Salted__');
const BLOCK_SIZE = 16;
const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
const REFRESH_STALE = process.argv.includes('--refresh-stale');

function fail(message, causeCode) {
  const error = new Error(message);
  error.safe = true;
  if (causeCode) error.causeCode = causeCode;
  throw error;
}

function assertPrivateFile(file, { minSize = 1, maxSize = MAX_ENVELOPE_BYTES } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (_) { fail('Arquivo de recuperação ausente ou inacessível.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < minSize || stat.size > maxSize ||
      (stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    fail('Permissões, tipo ou tamanho do arquivo privado são inválidos.');
  }
  return stat;
}

function inspectEnvelope(file) {
  const stat = assertPrivateFile(file, { minSize: 32 });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let header;
  try { header = Buffer.alloc(8); fs.readSync(fd, header, 0, 8, 0); } finally { fs.closeSync(fd); }
  if (!header.equals(SALTED) || (stat.size - 16) % BLOCK_SIZE !== 0) fail('Formato OpenSSL salted/CBC inesperado.');
  return stat.size;
}

function assertPrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let component;
    try { component = fs.lstatSync(cursor); } catch (_) { fail('Diretório privado ausente ou inacessível.'); }
    if (component.isSymbolicLink()) fail('Paths privados não podem conter symlinks.');
  }
  let stat;
  try { stat = fs.lstatSync(directory); } catch (_) { fail('Diretório privado ausente ou inacessível.'); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('Diretório operacional não é privado.');
  return stat;
}

function readHidden(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('A passphrase só pode ser informada em terminal interativo.');
  const saved = spawnSync('stty', ['-g'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'ignore'] });
  const state = saved.status === 0 ? saved.stdout.trim() : '';
  if (!state) fail('Não foi possível salvar o estado do terminal.');
  const decoder = new StringDecoder('utf8');
  const chars = [];
  return new Promise((resolve, reject) => {
    let changed = false, done = false;
    const restore = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.removeListener('SIGINT', onInt);
      process.stdin.pause();
      if (changed) {
        const result = spawnSync('stty', [state], { stdio: ['inherit', 'ignore', 'ignore'] });
        changed = false;
        if (result.status !== 0) process.exitCode = 1;
      }
      process.stderr.write('\n');
    };
    const finish = (error, value) => {
      if (done) return;
      done = true;
      if (error) { chars.fill(''); chars.length = 0; }
      restore();
      if (error) reject(error); else resolve(value);
    };
    const onInt = () => { const error = new Error('Entrada cancelada.'); error.code = 'USER_ABORTED'; finish(error); };
    const onEnd = () => finish(new Error('Terminal fechado durante a entrada.'));
    const onData = chunk => {
      for (let offset = 0, text = decoder.write(chunk); offset < text.length && !done;) {
        const code = text.codePointAt(offset), ch = String.fromCodePoint(code); offset += ch.length;
        if (ch === '\u0003' || ch === '\u0004') onInt();
        else if (ch === '\r' || ch === '\n') {
          const value = Buffer.from(chars.join(''), 'utf8'); chars.fill(''); chars.length = 0; finish(null, value);
        } else if (ch === '\u007f' || ch === '\b') chars.pop();
        else if (ch >= ' ' && ch !== '\u007f') chars.push(ch);
        if (chars.join('').length > 4096) onInt();
      }
    };
    const hidden = spawnSync('stty', ['-echo', '-icanon', 'min', '1', 'time', '0'], { stdio: ['inherit', 'ignore', 'ignore'] });
    if (hidden.status !== 0) { finish(new Error('Não foi possível desativar o eco do terminal.')); return; }
    changed = true;
    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.once('SIGINT', onInt);
    process.stderr.write(`${label}: `);
    process.stdin.resume();
  });
}

function decryptLegacy(file, passphrase, openssl = OPENSSL) {
  const input = Buffer.concat([passphrase, Buffer.from('\n')]);
  try {
    const result = spawnSync(openssl, ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-in', file, '-pass', 'stdin'],
      { input, encoding: null, maxBuffer: MAX_ENVELOPE_BYTES, stdio: ['pipe', 'pipe', 'ignore'] });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      fail('Abertura do envelope falhou; passphrase ou envelope inválido.', result.error?.code);
    }
    return result.stdout;
  } finally { input.fill(0); }
}

function encryptLegacy(inputFile, outputFile, passphrase, openssl = OPENSSL) {
  const input = Buffer.concat([passphrase, Buffer.from('\n')]);
  try {
    const result = spawnSync(openssl, ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '600000', '-in', inputFile,
      '-out', outputFile, '-pass', 'stdin'], { input, encoding: null, maxBuffer: 4096, stdio: ['pipe', 'ignore', 'ignore'] });
    if (result.error || result.status !== 0) fail('Criação do envelope atualizado falhou.', result.error?.code);
    fs.chmodSync(outputFile, 0o600);
  } finally { input.fill(0); }
}

async function promptNewPassphrase(readPassphrase = readHidden) {
  const first = await readPassphrase('Nova passphrase para o envelope atualizado (mínimo 24 caracteres)');
  let second;
  try {
    second = await readPassphrase('Confirme a nova passphrase');
    if (first.length < 24 || first.length > 1024 || !equal(first, second)) fail('A nova passphrase é inválida ou as confirmações diferem.');
    return first;
  } catch (error) { first.fill(0); throw error; }
  finally { if (second) second.fill(0); }
}

function tarMembers(archive) {
  if (!archive.length || archive.length % 512) fail('Arquivo do keystore não é um TAR completo.');
  const members = [];
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const savedChecksum = parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/u, '').trim(), 8);
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (!Number.isFinite(savedChecksum) || checksum !== savedChecksum) fail('Cabeçalho TAR inválido.');
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/u, '');
    const name = field(0, 100), prefix = field(345, 500);
    const rawName = prefix ? `${prefix}/${name}` : name;
    const normalized = path.posix.normalize(rawName.replace(/^\.\//u, ''));
    const type = String.fromCharCode(header[156] || 48);
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = sizeField ? parseInt(sizeField, 8) : 0;
    if (!rawName || path.posix.isAbsolute(rawName) || normalized === '..' || normalized.startsWith('../') ||
        /[\r\n\u0000]/u.test(rawName) || !['0', '5'].includes(type) || !Number.isSafeInteger(size) || size < 0) {
      fail('Arquivo TAR contém um membro inseguro ou não suportado.');
    }
    const start = offset + 512, end = start + size;
    if (end > archive.length) fail('Membro TAR truncado.');
    members.push({ rawName, name: normalized, type, size, data: archive.subarray(start, end) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return members;
}

function extractMember(archiveFile, member, tarCommand = TAR) {
  const result = spawnSync(tarCommand, ['-xOf', archiveFile, member.rawName],
    { encoding: null, maxBuffer: MAX_ENVELOPE_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) fail('Leitura de membro TAR falhou.', result.error?.code);
  return result.stdout;
}

function equal(a, b) { return a.length === b.length && crypto.timingSafeEqual(a, b); }

function createEncryptedStage(keysDirectory) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const file = path.join(keysDirectory, `.keystore-recovery-stage-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fs.closeSync(fd);
      return file;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  fail('Não foi possível criar o arquivo temporário privado.');
}

function publishNoReplace(stagedFile, targetFile, mover = MV) {
  // GNU mv uses a no-replace rename where supported. Unlike hard links, this
  // works on Android filesystems that deny link(2), and remains atomic.
  const result = spawnSync(mover, ['--no-clobber', '--no-target-directory', '--', stagedFile, targetFile],
    { encoding: 'utf8', maxBuffer: 4096, stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0 || fs.existsSync(stagedFile)) {
    const error = new Error('Publicação atômica indisponível ou destino já existente.');
    error.code = fs.existsSync(targetFile) ? 'EEXIST' : moverErrorCode(result.stderr) || 'EIO';
    error.safe = true;
    throw error;
  }
  assertPrivateFile(targetFile, { minSize: 32 });
  const directoryFd = fs.openSync(path.dirname(targetFile), fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function assertAtomicPublisher(mover = MV) {
  const version = spawnSync(mover, ['--version'], { encoding: 'utf8', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] });
  if (version.error) throw version.error;
  if (version.status !== 0 || !/^mv \(GNU coreutils\)/u.test(version.stdout || '')) {
    const error = new Error('Publicação exige mv do GNU coreutils com suporte a no-clobber.');
    error.code = 'ENOTSUP'; error.safe = true; throw error;
  }
}

function moverErrorCode(stderr = '') {
  const message = String(stderr).toLowerCase();
  if (message.includes('permission denied')) return 'EACCES';
  if (message.includes('operation not permitted')) return 'EPERM';
  if (message.includes('no space left')) return 'ENOSPC';
  if (message.includes('read-only file system')) return 'EROFS';
  if (message.includes('cross-device link')) return 'EXDEV';
  if (message.includes('no such file or directory')) return 'ENOENT';
  if (message.includes('invalid argument')) return 'EINVAL';
  return null;
}

function sanitizedFailure(error, stage = 'preflight') {
  const allowedCodes = new Set(['ENOENT','EACCES','EPERM','EEXIST','EXDEV','ENOSPC','EMFILE','EIO','EROFS','ENOTSUP','EOPNOTSUPP','EINVAL','EPIPE','USER_ABORTED']);
  const result = { event: 'recovery.envelopes.failed', code: error.code === 'USER_ABORTED' ? 'USER_ABORTED' : 'RECOVERY_CHECK_FAILED',
    stage: error.recoveryStage || stage };
  if (error.published === true) result.published = true;
  if (error.cleanupFailed === true) result.cleanup = 'FAILED';
  if (error.safe && typeof error.message === 'string') result.diagnostic = error.message;
  const causeCode = error.causeCode || error.code;
  if (allowedCodes.has(causeCode) && causeCode !== 'USER_ABORTED') result.causeCode = causeCode;
  else if (!error.safe && error.code !== 'USER_ABORTED') result.diagnostic = 'Verificação local falhou.';
  return result;
}

async function main(options = {}) {
  const identityDirectory = options.identityDirectory || IDENTITY;
  if (!path.isAbsolute(identityDirectory)) fail('O diretório da identidade deve ser absoluto.');
  const identity = path.resolve(identityDirectory);
  const keysDirectory = path.join(identity, 'keys');
  const masterEnvelope = path.join(keysDirectory, 'master-key-recovery.enc');
  const keystoreEnvelope = path.join(keysDirectory, 'keystore-recovery.enc');
  const masterKey = path.join(keysDirectory, 'master.key');
  const smtpRef = path.join(keysDirectory, 'smtp-password.ref');
  const keystoreDirectory = path.join(identity, 'keystore');
  const auditDirectory = path.join(identity, 'audit');
  const openssl = options.openssl || OPENSSL;
  const tarCommand = options.tarCommand || TAR;
  const readPassphrase = options.readPassphrase || readHidden;
  const decryptEnvelope = options.decryptEnvelope || ((file, passphrase) => decryptLegacy(file, passphrase, openssl));
  const encryptEnvelope = options.encryptEnvelope || ((input, output, passphrase) => encryptLegacy(input, output, passphrase, openssl));
  const audit = options.appendAudit || require('../backend/runtime/operator-audit').appendOperatorAudit;
  const customPublisher = typeof options.publish === 'function';
  const publish = options.publish || ((stagedFile, targetFile) => publishNoReplace(stagedFile, targetFile, options.mover || MV));
  const refreshStale = options.refreshStale === undefined ? REFRESH_STALE : options.refreshStale;
  let stage = 'preflight';
  let encryptedStage;
  let targetEnvelope;
  let didPublish = false;
  let operationError;
  assertPrivateDirectory(identity);
  assertPrivateDirectory(keysDirectory);
  assertPrivateDirectory(keystoreDirectory);
  assertPrivateDirectory(auditDirectory);
  const sizes = { masterEnvelopeBytes: inspectEnvelope(masterEnvelope), keystoreEnvelopeBytes: inspectEnvelope(keystoreEnvelope) };
  if (!META_ONLY && refreshStale && !customPublisher) assertAtomicPublisher(options.mover || MV);
  const expectedMasterStat = assertPrivateFile(masterKey, { minSize: 32, maxSize: 32 });
  const refStat = assertPrivateFile(smtpRef, { minSize: 1, maxSize: 256 });
  let liveMaster, liveRef;
  let liveStoreNames = [];
  const liveStore = new Map();
  try {
    liveMaster = fs.readFileSync(masterKey); liveRef = fs.readFileSync(smtpRef);
    liveStoreNames = fs.readdirSync(keystoreDirectory).filter(name => name.endsWith('.enc')).sort();
    for (const name of liveStoreNames) {
      const file = path.join(keystoreDirectory, name);
      assertPrivateFile(file, { minSize: 1 });
      liveStore.set(name, fs.readFileSync(file));
    }
  } catch (error) {
    for (const value of [liveMaster, liveRef, ...liveStore.values()]) if (Buffer.isBuffer(value)) value.fill(0);
    if (temp) {
      try { fs.rmSync(temp, { recursive: true, force: false }); }
      catch (_) { error.cleanupFailed = true; }
    }
    throw error;
  }
  if (META_ONLY) {
    try {
      process.stdout.write(JSON.stringify({ event: 'recovery.envelopes.metadata', status: 'structurally_valid', ...sizes,
        masterKeyMode: (expectedMasterStat.mode & 0o777).toString(8), smtpReferenceMode: (refStat.mode & 0o777).toString(8), keystoreEntries: liveStore.size }) + '\n');
    } finally { for (const value of [liveMaster, liveRef, ...liveStore.values()]) value.fill(0); }
    return;
  }

  let temp;
  try {
    temp = fs.mkdtempSync(path.join(identity, '.recovery-check-0238-'));
    fs.chmodSync(temp, 0o700);
  } catch (error) {
    for (const value of [liveMaster, liveRef, ...liveStore.values()]) if (Buffer.isBuffer(value)) value.fill(0);
    throw error;
  }
  let oldMasterPass, oldKeystorePass, recoveredMaster, recoveredArchive;
  try {
    stage = 'master-recovery';
    oldMasterPass = await readPassphrase('Passphrase do envelope da chave mestra');
    recoveredMaster = decryptEnvelope(masterEnvelope, oldMasterPass);
    oldMasterPass.fill(0); oldMasterPass = null;
    const recoveredPath = path.join(temp, 'master.key');
    fs.writeFileSync(recoveredPath, recoveredMaster, { mode: 0o600, flag: 'wx' });
    if (!equal(fs.readFileSync(recoveredPath), liveMaster)) fail('A chave recuperada não coincide com a chave operacional.');
    process.stdout.write('master_key_recovery=PASS\n');

    stage = 'keystore-recovery';
    oldKeystorePass = await readPassphrase('Passphrase do envelope do keystore');
    recoveredArchive = decryptEnvelope(keystoreEnvelope, oldKeystorePass);
    oldKeystorePass.fill(0); oldKeystorePass = null;
    const archivePath = path.join(temp, 'keystore.tar');
    fs.writeFileSync(archivePath, recoveredArchive, { mode: 0o600, flag: 'wx' });
    stage = 'archive-validate';
    const members = tarMembers(recoveredArchive).filter(member => member.type === '0');
    const seen = new Set();
    for (const member of members) {
      if (seen.has(member.name)) fail('O TAR contém nomes duplicados.');
      seen.add(member.name);
    }
    const refMember = members.find(member => member.name === 'keys/smtp-password.ref' || member.name === 'smtp-password.ref');
    let referenceCurrent = false;
    if (refMember) {
      const fromArchive = extractMember(archivePath, refMember, tarCommand);
      referenceCurrent = equal(fromArchive, liveRef);
      fromArchive.fill(0);
    }
    const archivedStore = members.filter(member => member.name.startsWith('keystore/'))
      .map(member => [member.name.slice('keystore/'.length), member]).filter(([name]) => name && !name.includes('/'));
    let storeCurrent = archivedStore.length === liveStore.size;
    for (const [name, member] of archivedStore) {
      const current = liveStore.get(name);
      if (!current) { storeCurrent = false; continue; }
      const value = extractMember(archivePath, member, tarCommand);
      if (!equal(value, current)) storeCurrent = false;
      value.fill(0);
    }
    const masterMember = members.find(member => member.name === 'keys/master.key' || member.name === 'master.key');
    let archivedMasterCurrent = null;
    if (masterMember) {
      const value = extractMember(archivePath, masterMember, tarCommand);
      archivedMasterCurrent = equal(value, liveMaster);
      value.fill(0);
    }
    const smtpIncluded = Boolean(refMember);
    const current = smtpIncluded && referenceCurrent && storeCurrent && archivedMasterCurrent !== false;
    process.stdout.write(JSON.stringify({ event: 'recovery.keystore.checked', status: current ? 'current' : 'stale',
      smtpReferenceIncluded: smtpIncluded, smtpReferenceMatches: referenceCurrent, keystoreEntriesMatch: storeCurrent,
      masterKeyIncluded: Boolean(masterMember), ...(archivedMasterCurrent === null ? {} : { masterKeyMatches: archivedMasterCurrent }) }) + '\n');
    if (!current && refreshStale) {
      stage = 'archive-create';
      const packed = spawnSync(tarCommand, ['-cf', '-', '-C', identity, 'keys/master.key', 'keys/smtp-password.ref', 'keystore'],
        { encoding: null, maxBuffer: MAX_ENVELOPE_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
      if (packed.error || packed.status !== 0 || !Buffer.isBuffer(packed.stdout)) fail('Empacotamento privado do keystore falhou.');
      const packedMembers = tarMembers(packed.stdout).filter(member => member.type === '0');
      const packedNames = new Set(packedMembers.map(member => member.name));
      if (!packedNames.has('keys/master.key') || !packedNames.has('keys/smtp-password.ref') ||
          liveStoreNames.some(name => !packedNames.has(`keystore/${name}`))) fail('O TAR temporário não contém o conjunto operacional esperado.');
      const currentTar = path.join(temp, 'keystore-current.tar');
      fs.writeFileSync(currentTar, packed.stdout, { mode: 0o600, flag: 'wx' });
      stage = 'passphrase-confirmation';
      const passphrase = await promptNewPassphrase(readPassphrase);
      stage = 'envelope-stage';
      encryptedStage = createEncryptedStage(keysDirectory);
      try {
        stage = 'envelope-encrypt';
        encryptEnvelope(currentTar, encryptedStage, passphrase);
        assertPrivateFile(encryptedStage, { minSize: 32 });
        inspectEnvelope(encryptedStage);
        const stageFd = fs.openSync(encryptedStage, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try { fs.fsyncSync(stageFd); } finally { fs.closeSync(stageFd); }
        stage = 'envelope-verify';
        const verification = decryptEnvelope(encryptedStage, passphrase);
        try { if (!equal(verification, packed.stdout)) fail('Verificação do envelope recém-criado falhou.'); }
        finally { verification.fill(0); }
        targetEnvelope = path.join(keysDirectory, 'keystore-recovery-0238.enc');
        stage = 'audit-start';
        await audit('identity.recovery_envelope.refresh_started', { kind: 'keystore' },
          { file: path.join(auditDirectory, 'operator-audit.jsonl'), actorRef: 'operator:termux-local' });
        stage = 'publish';
        publish(encryptedStage, targetEnvelope);
        didPublish = true;
        encryptedStage = null;
        stage = 'audit-complete';
        await audit('identity.recovery_envelope.refreshed', { kind: 'keystore' },
          { file: path.join(auditDirectory, 'operator-audit.jsonl'), actorRef: 'operator:termux-local' });
        process.stdout.write('keystore_recovery_refresh=PASS\nprevious_envelope_preserved=YES\nformat=openssl-aes-256-cbc-pbkdf2-600000\n');
      } finally {
        passphrase.fill(0); packed.stdout.fill(0);
      }
    } else if (!current) process.exitCode = 3;
  } catch (error) {
    if (!error.recoveryStage) error.recoveryStage = stage;
    if (didPublish || stage === 'publish' && targetEnvelope && encryptedStage && !fs.existsSync(encryptedStage) && fs.existsSync(targetEnvelope)) {
      error.published = true;
    }
    operationError = error;
  } finally {
    for (const value of [oldMasterPass, oldKeystorePass, recoveredMaster, recoveredArchive, liveMaster, liveRef, ...liveStore.values()])
      if (Buffer.isBuffer(value)) value.fill(0);
    const cleanupErrors = [];
    try { if (encryptedStage && fs.existsSync(encryptedStage)) fs.unlinkSync(encryptedStage); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { fs.rmSync(temp, { recursive: true, force: false }); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (fs.existsSync(temp)) cleanupErrors.push(Object.assign(new Error('Temporary plaintext directory remains.'), { code: 'EIO' }));
    if (cleanupErrors.length) {
      if (!operationError) {
        operationError = Object.assign(new Error('Temporários privados não puderam ser removidos.'),
          { code: cleanupErrors[0].code, recoveryStage: 'cleanup', safe: true });
      } else operationError.cleanupFailed = true;
    } else {
      process.stdout.write('temporary_plaintext_removed=YES (apagamento físico em flash não é garantido)\n');
    }
  }
  if (operationError) throw operationError;
}

if (require.main === module && process.argv.includes('--test-recovery-tty')) {
  readHidden('Synthetic recovery TTY test').then(value => {
    const accepted = value.length > 0;
    value.fill(0);
    if (!accepted) throw new Error('Synthetic input was empty.');
    process.stdout.write('recovery_tty_input=PASS\n');
  }).catch(error => {
    process.stderr.write(`recovery_tty_input=FAIL code=${error.code === 'USER_ABORTED' ? 'USER_ABORTED' : 'TTY_TEST_FAILED'}\n`);
    process.exitCode = 1;
  });
} else if (require.main === module) {
  main().catch(error => {
    const diagnostic = sanitizedFailure(error);
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    const code = diagnostic.code;
    process.exitCode = code === 'USER_ABORTED' ? 130 : 1;
  });
}

module.exports = { main, readHidden, promptNewPassphrase, decryptLegacy, encryptLegacy, tarMembers, publishNoReplace, sanitizedFailure };
