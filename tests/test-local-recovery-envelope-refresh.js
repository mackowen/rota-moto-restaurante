'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { main, readHidden, decryptLegacy, encryptLegacy, tarMembers, sanitizedFailure, publishNoReplace } = require('../scripts/verify-local-recovery-envelopes');
const { appendOperatorAudit } = require('../backend/runtime/operator-audit');

const MASTER_PASS = Buffer.from('synthetic-master-passphrase-0238');
const OLD_STORE_PASS = Buffer.from('synthetic-old-keystore-passphrase-0238');
const NEW_PASS = Buffer.from('synthetic-new-keystore-passphrase-0238');
const WRONG_PASS = Buffer.from('synthetic-different-passphrase-0238');

function privateWrite(file, value) { fs.writeFileSync(file, value, { mode: 0o600, flag: 'wx' }); }
function tar(archiveFile, cwd, items) {
  const result = spawnSync('tar', ['-cf', archiveFile, '-C', cwd, ...items], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'synthetic TAR fixture should be created');
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rotamoto-recovery-0238-'));
  fs.chmodSync(root, 0o700);
  const identityDirectory = path.join(root, 'identity');
  const keys = path.join(identityDirectory, 'keys');
  const store = path.join(identityDirectory, 'keystore');
  const audit = path.join(identityDirectory, 'audit');
  for (const dir of [identityDirectory, keys, store, audit]) fs.mkdirSync(dir, { mode: 0o700 });
  const master = crypto.randomBytes(32);
  const smtpRef = Buffer.from('local-v1:11111111-1111-4111-8111-111111111111\n');
  const currentA = Buffer.from('synthetic-current-credential-a');
  const currentB = Buffer.from('synthetic-current-credential-b');
  privateWrite(path.join(keys, 'master.key'), master);
  privateWrite(path.join(keys, 'smtp-password.ref'), smtpRef);
  privateWrite(path.join(store, 'smtp.enc'), currentA);
  privateWrite(path.join(store, 'marketplace.enc'), currentB);

  const oldRef = Buffer.from('local-v1:22222222-2222-4222-8222-222222222222\n');
  privateWrite(path.join(root, 'old-master.key'), master);
  const masterEnvelope = path.join(keys, 'master-key-recovery.enc');
  encryptLegacy(path.join(root, 'old-master.key'), masterEnvelope, MASTER_PASS);
  privateWrite(path.join(keys, 'old-smtp-password.ref'), oldRef);
  privateWrite(path.join(store, 'old-smtp.enc'), currentA);
  privateWrite(path.join(store, 'old-marketplace.enc'), currentB);
  const oldTar = path.join(root, 'legacy-keystore.tar');
  tar(oldTar, identityDirectory, ['keys/master.key', 'keys/old-smtp-password.ref', 'keystore/old-smtp.enc', 'keystore/old-marketplace.enc']);
  const keystoreEnvelope = path.join(keys, 'keystore-recovery.enc');
  encryptLegacy(oldTar, keystoreEnvelope, OLD_STORE_PASS);
  fs.unlinkSync(path.join(keys, 'old-smtp-password.ref'));
  fs.unlinkSync(path.join(store, 'old-smtp.enc'));
  fs.unlinkSync(path.join(store, 'old-marketplace.enc'));

  return { root, identityDirectory, keys, audit, master, smtpRef, currentA, currentB,
    masterEnvelope, keystoreEnvelope, masterEnvelopeBefore: fs.readFileSync(masterEnvelope),
    masterEnvelopeMode: fs.statSync(masterEnvelope).mode & 0o777,
    keystoreEnvelopeBefore: fs.readFileSync(keystoreEnvelope), target: path.join(keys, 'keystore-recovery-0238.enc') };
}

async function invoke(fixture, passphrases, options = {}) {
  let index = 0;
  const readPassphrase = async () => {
    const value = passphrases[index++];
    if (!value) throw new Error('Synthetic test passphrase sequence exhausted.');
    return Buffer.from(value);
  };
  await main({ identityDirectory: fixture.identityDirectory, refreshStale: true, readPassphrase,
    appendAudit: options.appendAudit || appendOperatorAudit, ...(options.publish ? { publish: options.publish } : {}),
    ...(options.decryptEnvelope ? { decryptEnvelope: options.decryptEnvelope } : {}) });
  return index;
}

function assertOriginalsPreserved(fixture) {
  assert.deepEqual(fs.readFileSync(fixture.masterEnvelope), fixture.masterEnvelopeBefore);
  assert.deepEqual(fs.readFileSync(fixture.keystoreEnvelope), fixture.keystoreEnvelopeBefore);
  assert.equal(fs.statSync(fixture.masterEnvelope).mode & 0o777, fixture.masterEnvelopeMode);
  assert.equal(fs.statSync(fixture.keystoreEnvelope).mode & 0o777, 0o600);
}
function assertNoTemps(fixture) {
  assert.equal(fs.readdirSync(fixture.identityDirectory).some(name => name.startsWith('.recovery-check-0238-')), false);
  assert.equal(fs.readdirSync(fixture.keys).some(name => name.endsWith('.tmp')), false);
}

async function mainTest() {
  const fixtures = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function discardSyntheticProgress() { return true; };
  try {
    await assert.rejects(() => main({ identityDirectory: 'relative/synthetic-identity', refreshStale: true }), /absoluto/u);
    const success = createFixture(); fixtures.push(success);
    const symlinkPath = path.join(success.root, 'identity-link');
    fs.symlinkSync(success.identityDirectory, symlinkPath, 'dir');
    await assert.rejects(() => main({ identityDirectory: symlinkPath, refreshStale: true }), /symlinks/u);
    await invoke(success, [MASTER_PASS, OLD_STORE_PASS, NEW_PASS, NEW_PASS]);
    assertOriginalsPreserved(success);
    const targetStat = fs.lstatSync(success.target);
    assert.equal(targetStat.mode & 0o777, 0o600);
    assert.equal(targetStat.nlink, 1);
    const archive = decryptLegacy(success.target, NEW_PASS);
    const members = tarMembers(archive).filter(member => member.type === '0');
    assert.ok(members.some(member => member.name === 'keys/smtp-password.ref'));
    assert.ok(members.some(member => member.name === 'keystore/smtp.enc'));
    assert.ok(members.some(member => member.name === 'keystore/marketplace.enc'));
    assert.deepEqual(members.filter(member => member.name.startsWith('keystore/')).map(member => member.name).sort(),
      ['keystore/marketplace.enc', 'keystore/smtp.enc']);
    assert.deepEqual(members.find(member => member.name === 'keys/smtp-password.ref').data, success.smtpRef);
    assert.ok(archive.includes(success.master));
    archive.fill(0);
    const auditRows = fs.readFileSync(path.join(success.audit, 'operator-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(auditRows.map(row => row.action), ['identity.recovery_envelope.refresh_started', 'identity.recovery_envelope.refreshed']);
    assert.equal(fs.readdirSync(success.identityDirectory).some(name => name.startsWith('.recovery-check-0238-')), false);
    assert.equal(fs.readdirSync(success.keys).some(name => name.endsWith('.tmp')), false);
    originalWrite.call(process.stdout, 'synthetic stale-envelope refresh: PASS\n');

    const mismatch = createFixture(); fixtures.push(mismatch);
    await assert.rejects(invoke(mismatch, [MASTER_PASS, OLD_STORE_PASS, NEW_PASS, WRONG_PASS]), error => {
      const info = sanitizedFailure(error);
      assert.equal(info.stage, 'passphrase-confirmation');
      assert.equal(info.code, 'RECOVERY_CHECK_FAILED');
      return true;
    });
    assertOriginalsPreserved(mismatch);
    assert.equal(fs.existsSync(mismatch.target), false);
    assertNoTemps(mismatch);

    const publishFailure = createFixture(); fixtures.push(publishFailure);
    await assert.rejects(invoke(publishFailure, [MASTER_PASS, OLD_STORE_PASS, NEW_PASS, NEW_PASS], {
      publish() { const error = new Error('synthetic publish failure with private path'); error.code = 'EOPNOTSUPP'; throw error; }
    }), error => {
      assert.deepEqual(sanitizedFailure(error), { event: 'recovery.envelopes.failed', code: 'RECOVERY_CHECK_FAILED', stage: 'publish', causeCode: 'EOPNOTSUPP' });
      return true;
    });
    assertOriginalsPreserved(publishFailure);
    assert.equal(fs.existsSync(publishFailure.target), false);
    assertNoTemps(publishFailure);

    const verifyFailure = createFixture(); fixtures.push(verifyFailure);
    let decryptCount = 0;
    await assert.rejects(invoke(verifyFailure, [MASTER_PASS, OLD_STORE_PASS, NEW_PASS, NEW_PASS], {
      decryptEnvelope(file, passphrase) {
        decryptCount++;
        if (decryptCount === 3) return Buffer.from('synthetic tampered archive');
        return decryptLegacy(file, passphrase);
      }
    }), error => {
      assert.equal(sanitizedFailure(error).stage, 'envelope-verify');
      return true;
    });
    assertOriginalsPreserved(verifyFailure);
    assert.equal(fs.existsSync(verifyFailure.target), false);
    assertNoTemps(verifyFailure);

    const auditFailure = createFixture(); fixtures.push(auditFailure);
    await assert.rejects(invoke(auditFailure, [MASTER_PASS, OLD_STORE_PASS, NEW_PASS, NEW_PASS], {
      appendAudit() { const error = new Error('synthetic audit path hidden'); error.code = 'EACCES'; throw error; }
    }), error => {
      const info = sanitizedFailure(error);
      assert.equal(info.stage, 'audit-start');
      assert.equal(info.causeCode, 'EACCES');
      assert.equal(JSON.stringify(info).includes('synthetic audit path'), false);
      return true;
    });
    assertOriginalsPreserved(auditFailure);
    assert.equal(fs.existsSync(auditFailure.target), false);
    assertNoTemps(auditFailure);

    const auditCompleteFailure = createFixture(); fixtures.push(auditCompleteFailure);
    let auditWrites = 0;
    await assert.rejects(invoke(auditCompleteFailure, [MASTER_PASS, OLD_STORE_PASS, NEW_PASS, NEW_PASS], {
      appendAudit: async (...args) => {
        auditWrites++;
        if (auditWrites === 2) { const error = new Error('synthetic completion audit failure'); error.code = 'EIO'; throw error; }
        return appendOperatorAudit(...args);
      }
    }), error => {
      const info = sanitizedFailure(error);
      assert.equal(info.stage, 'audit-complete');
      assert.equal(info.published, true);
      assert.equal(info.causeCode, 'EIO');
      return true;
    });
    assertOriginalsPreserved(auditCompleteFailure);
    assert.equal(fs.existsSync(auditCompleteFailure.target), true);
    assertNoTemps(auditCompleteFailure);
    const completedArchive = decryptLegacy(auditCompleteFailure.target, NEW_PASS);
    assert.ok(tarMembers(completedArchive).some(member => member.name === 'keys/smtp-password.ref'));
    completedArchive.fill(0);

    assert.throws(() => readHidden('synthetic no-tty check'), /terminal interativo/u);

    const noReplace = createFixture(); fixtures.push(noReplace);
    const stage = path.join(noReplace.keys, 'stage.tmp');
    privateWrite(stage, Buffer.from('synthetic-stage'));
    privateWrite(noReplace.target, Buffer.from('existing-envelope-sentinel'));
    assert.throws(() => publishNoReplace(stage, noReplace.target), error => error.code === 'EEXIST');
    assert.equal(fs.readFileSync(noReplace.target, 'utf8'), 'existing-envelope-sentinel');
    fs.unlinkSync(stage);

    const concurrent = createFixture(); fixtures.push(concurrent);
    const sourceA = path.join(concurrent.keys, 'race-a.tmp'), sourceB = path.join(concurrent.keys, 'race-b.tmp');
    privateWrite(sourceA, Buffer.from('synthetic-race-a'));
    privateWrite(sourceB, Buffer.from('synthetic-race-b'));
    const runMove = source => new Promise((resolve, reject) => {
      const child = spawn('mv', ['--no-clobber', '--no-target-directory', '--', source, concurrent.target], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    const [raceA, raceB] = await Promise.all([runMove(sourceA), runMove(sourceB)]);
    assert.equal(raceA, 0); assert.equal(raceB, 0);
    assert.equal(fs.existsSync(concurrent.target), true);
    assert.equal(Number(fs.existsSync(sourceA)) + Number(fs.existsSync(sourceB)), 1);
    assert.ok(['synthetic-race-a', 'synthetic-race-b'].includes(fs.readFileSync(concurrent.target, 'utf8')));
    originalWrite.call(process.stdout, 'local recovery envelope refresh regression tests: PASS\n');
  } finally {
    process.stdout.write = originalWrite;
    for (const fixture of fixtures) {
      for (const value of [fixture.master, fixture.smtpRef, fixture.currentA, fixture.currentB,
        fixture.masterEnvelopeBefore, fixture.keystoreEnvelopeBefore]) if (Buffer.isBuffer(value)) value.fill(0);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

mainTest().catch(error => { process.stderr.write(`local recovery envelope tests: FAIL ${error.stack || error.code || error.name}\n`); process.exitCode = 1; });
