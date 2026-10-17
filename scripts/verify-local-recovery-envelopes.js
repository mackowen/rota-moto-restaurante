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
const META_ONLY = process.argv.includes('--metadata-only');
const SALTED = Buffer.from('Salted__');
const BLOCK_SIZE = 16;
const MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
const REFRESH_STALE = process.argv.includes('--refresh-stale');

function fail(message) { const error = new Error(message); error.safe = true; throw error; }

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

function decryptLegacy(file, passphrase) {
  const input = Buffer.concat([passphrase, Buffer.from('\n')]);
  try {
    const result = spawnSync(OPENSSL, ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-in', file, '-pass', 'stdin'],
      { input, encoding: null, maxBuffer: MAX_ENVELOPE_BYTES, stdio: ['pipe', 'pipe', 'ignore'] });
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) fail('Abertura do envelope falhou; passphrase ou envelope inválido.');
    return result.stdout;
  } finally { input.fill(0); }
}

function encryptLegacy(inputFile, outputFile, passphrase) {
  const input = Buffer.concat([passphrase, Buffer.from('\n')]);
  try {
    const result = spawnSync(OPENSSL, ['enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '600000', '-in', inputFile,
      '-out', outputFile, '-pass', 'stdin'], { input, encoding: null, maxBuffer: 4096, stdio: ['pipe', 'ignore', 'ignore'] });
    if (result.error || result.status !== 0) fail('Criação do envelope atualizado falhou.');
    fs.chmodSync(outputFile, 0o600);
  } finally { input.fill(0); }
}

async function promptNewPassphrase() {
  const first = await readHidden('Nova passphrase para o envelope atualizado (mínimo 24 caracteres)');
  let second;
  try {
    second = await readHidden('Confirme a nova passphrase');
    if (first.length < 24 || !equal(first, second)) fail('A nova passphrase é curta ou as confirmações diferem.');
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

function extractMember(archiveFile, member) {
  const result = spawnSync(TAR, ['-xOf', archiveFile, member.rawName],
    { encoding: null, maxBuffer: MAX_ENVELOPE_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) fail('Leitura de membro TAR falhou.');
  return result.stdout;
}

function equal(a, b) { return a.length === b.length && crypto.timingSafeEqual(a, b); }

async function main() {
  const sizes = { masterEnvelopeBytes: inspectEnvelope(MASTER_ENVELOPE), keystoreEnvelopeBytes: inspectEnvelope(KEYSTORE_ENVELOPE) };
  assertPrivateDirectory(IDENTITY);
  assertPrivateDirectory(path.join(IDENTITY, 'keys'));
  assertPrivateDirectory(KEYSTORE);
  const expectedMasterStat = assertPrivateFile(MASTER_KEY, { minSize: 32, maxSize: 32 });
  const refStat = assertPrivateFile(SMTP_REF, { minSize: 1, maxSize: 256 });
  const liveMaster = fs.readFileSync(MASTER_KEY), liveRef = fs.readFileSync(SMTP_REF);
  const liveStoreNames = fs.readdirSync(KEYSTORE).filter(name => name.endsWith('.enc')).sort();
  const liveStore = new Map(liveStoreNames.map(name => {
    const file = path.join(KEYSTORE, name);
    assertPrivateFile(file, { minSize: 1 });
    return [name, fs.readFileSync(file)];
  }));
  if (META_ONLY) {
    process.stdout.write(JSON.stringify({ event: 'recovery.envelopes.metadata', status: 'structurally_valid', ...sizes,
      masterKeyMode: (expectedMasterStat.mode & 0o777).toString(8), smtpReferenceMode: (refStat.mode & 0o777).toString(8), keystoreEntries: liveStore.size }) + '\n');
    for (const value of [liveMaster, liveRef, ...liveStore.values()]) value.fill(0);
    return;
  }

  const rootStat = fs.lstatSync(IDENTITY);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) fail('Diretório da identidade não é privado.');
  const temp = fs.mkdtempSync(path.join(IDENTITY, '.recovery-check-0236-'));
  fs.chmodSync(temp, 0o700);
  let oldMasterPass, oldKeystorePass, recoveredMaster, recoveredArchive;
  try {
    oldMasterPass = await readHidden('Passphrase do envelope da chave mestra');
    recoveredMaster = decryptLegacy(MASTER_ENVELOPE, oldMasterPass);
    oldMasterPass.fill(0); oldMasterPass = null;
    const recoveredPath = path.join(temp, 'master.key');
    fs.writeFileSync(recoveredPath, recoveredMaster, { mode: 0o600, flag: 'wx' });
    if (!equal(fs.readFileSync(recoveredPath), liveMaster)) fail('A chave recuperada não coincide com a chave operacional.');
    process.stdout.write('master_key_recovery=PASS\n');

    oldKeystorePass = await readHidden('Passphrase do envelope do keystore');
    recoveredArchive = decryptLegacy(KEYSTORE_ENVELOPE, oldKeystorePass);
    oldKeystorePass.fill(0); oldKeystorePass = null;
    const archivePath = path.join(temp, 'keystore.tar');
    fs.writeFileSync(archivePath, recoveredArchive, { mode: 0o600, flag: 'wx' });
    const members = tarMembers(recoveredArchive).filter(member => member.type === '0');
    const seen = new Set();
    for (const member of members) {
      if (seen.has(member.name)) fail('O TAR contém nomes duplicados.');
      seen.add(member.name);
    }
    const refMember = members.find(member => member.name === 'keys/smtp-password.ref' || member.name === 'smtp-password.ref');
    let referenceCurrent = false;
    if (refMember) {
      const fromArchive = extractMember(archivePath, refMember);
      referenceCurrent = equal(fromArchive, liveRef);
      fromArchive.fill(0);
    }
    const archivedStore = members.filter(member => member.name.startsWith('keystore/'))
      .map(member => [member.name.slice('keystore/'.length), member]).filter(([name]) => name && !name.includes('/'));
    let storeCurrent = archivedStore.length === liveStore.size;
    for (const [name, member] of archivedStore) {
      const current = liveStore.get(name);
      if (!current) { storeCurrent = false; continue; }
      const value = extractMember(archivePath, member);
      if (!equal(value, current)) storeCurrent = false;
      value.fill(0);
    }
    const masterMember = members.find(member => member.name === 'keys/master.key' || member.name === 'master.key');
    let archivedMasterCurrent = null;
    if (masterMember) {
      const value = extractMember(archivePath, masterMember);
      archivedMasterCurrent = equal(value, liveMaster);
      value.fill(0);
    }
    const smtpIncluded = Boolean(refMember);
    const current = smtpIncluded && referenceCurrent && storeCurrent && archivedMasterCurrent !== false;
    process.stdout.write(JSON.stringify({ event: 'recovery.keystore.checked', status: current ? 'current' : 'stale',
      smtpReferenceIncluded: smtpIncluded, smtpReferenceMatches: referenceCurrent, keystoreEntriesMatch: storeCurrent,
      masterKeyIncluded: Boolean(masterMember), ...(archivedMasterCurrent === null ? {} : { masterKeyMatches: archivedMasterCurrent }) }) + '\n');
    if (!current && REFRESH_STALE) {
      const packed = spawnSync(TAR, ['-cf', '-', '-C', IDENTITY, 'keys/master.key', 'keys/smtp-password.ref', 'keystore'],
        { encoding: null, maxBuffer: MAX_ENVELOPE_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
      if (packed.error || packed.status !== 0 || !Buffer.isBuffer(packed.stdout)) fail('Empacotamento privado do keystore falhou.');
      const currentTar = path.join(temp, 'keystore-current.tar');
      fs.writeFileSync(currentTar, packed.stdout, { mode: 0o600, flag: 'wx' });
      const passphrase = await promptNewPassphrase();
      const encryptedTemp = path.join(temp, 'keystore-recovery-0236.enc');
      try {
        encryptLegacy(currentTar, encryptedTemp, passphrase);
        const verification = decryptLegacy(encryptedTemp, passphrase);
        try { if (!equal(verification, packed.stdout)) fail('Verificação do envelope recém-criado falhou.'); }
        finally { verification.fill(0); }
        const target = path.join(IDENTITY, 'keys', 'keystore-recovery-0236.enc');
        const { appendOperatorAudit } = require('../backend/runtime/operator-audit');
        await appendOperatorAudit('identity.recovery_envelope.refresh_started', { kind: 'keystore' },
          { file: path.join(IDENTITY, 'audit', 'operator-audit.jsonl'), actorRef: 'operator:termux-local' });
        fs.linkSync(encryptedTemp, target);
        fs.unlinkSync(encryptedTemp);
        await appendOperatorAudit('identity.recovery_envelope.refreshed', { kind: 'keystore' },
          { file: path.join(IDENTITY, 'audit', 'operator-audit.jsonl'), actorRef: 'operator:termux-local' });
        process.stdout.write('keystore_recovery_refresh=PASS\nprevious_envelope_preserved=YES\nformat=openssl-aes-256-cbc-pbkdf2-600000\n');
      } finally { passphrase.fill(0); packed.stdout.fill(0); }
    } else if (!current) process.exitCode = 3;
  } finally {
    for (const value of [oldMasterPass, oldKeystorePass, recoveredMaster, recoveredArchive, liveMaster, liveRef, ...liveStore.values()])
      if (Buffer.isBuffer(value)) value.fill(0);
    fs.rmSync(temp, { recursive: true, force: false });
    if (fs.existsSync(temp)) fail('Diretório temporário de plaintext continua presente.');
    process.stdout.write('temporary_plaintext_removed=YES (apagamento físico em flash não é garantido)\n');
  }
}

if (process.argv.includes('--test-recovery-tty')) {
  readHidden('Synthetic recovery TTY test').then(value => {
    const accepted = value.length > 0;
    value.fill(0);
    if (!accepted) throw new Error('Synthetic input was empty.');
    process.stdout.write('recovery_tty_input=PASS\n');
  }).catch(error => {
    process.stderr.write(`recovery_tty_input=FAIL code=${error.code === 'USER_ABORTED' ? 'USER_ABORTED' : 'TTY_TEST_FAILED'}\n`);
    process.exitCode = 1;
  });
} else {
  main().catch(error => {
    const code = error.code === 'USER_ABORTED' ? 'USER_ABORTED' : 'RECOVERY_CHECK_FAILED';
    process.stderr.write(`${JSON.stringify({ event: 'recovery.envelopes.failed', code, diagnostic: error.safe ? error.message : 'Verificação local falhou.' })}\n`);
    process.exitCode = code === 'USER_ABORTED' ? 130 : 1;
  });
}
