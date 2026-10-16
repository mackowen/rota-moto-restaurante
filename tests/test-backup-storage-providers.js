'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createS3BackupProvider, createSftpBackupProvider, validatePublicEndpoint, validateObjectPath } = require('../backend/runtime/backup-storage-providers');
const { createBackupDestinationStore } = require('../backend/runtime/backup-destination-store');
const { verifyPinnedHostKey } = require('../backend/runtime/backup-destination-store');

async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function localSftpTransfer({ root, recoveryId }) {
  const directory = path.join(root, 'sftp-test'), clientKey = path.join(directory, 'client'), hostKey = path.join(directory, 'host'), authorized = path.join(directory, 'authorized_keys'), knownHosts = path.join(directory, 'known_hosts'), config = path.join(directory, 'sshd_config'), remote = path.join(directory, 'remote');
  await fs.mkdir(remote, { recursive: true, mode: 0o700 });
  for (const [file, args] of [[clientKey, ['-q', '-t', 'ed25519', '-N', '', '-f', clientKey]], [hostKey, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]]]) { const generated = spawnSync('ssh-keygen', args, { encoding: 'utf8' }); if (generated.status !== 0) return false; }
  const publicClient = (await fs.readFile(`${clientKey}.pub`, 'utf8')).trim(); await fs.writeFile(authorized, `${publicClient}\n`, { mode: 0o600 });
  const publicHost = (await fs.readFile(`${hostKey}.pub`, 'utf8')).trim().split(/\s+/u), fingerprintResult = spawnSync('ssh-keygen', ['-lf', `${hostKey}.pub`], { encoding: 'utf8' });
  if (fingerprintResult.status !== 0) return false;
  const fingerprint = fingerprintResult.stdout.trim().split(/\s+/u)[1], port = await freePort();
  await fs.writeFile(knownHosts, `[127.0.0.1]:${port} ${publicHost[0]} ${publicHost[1]}\n`, { mode: 0o600 });
  await fs.writeFile(config, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${path.join(directory, 'sshd.pid')}\nAuthorizedKeysFile ${authorized}\nStrictModes no\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin yes\nUsePAM no\nSubsystem sftp internal-sftp\nAllowUsers ${os.userInfo().username}\n`);
  const daemon = spawn('sshd', ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'pipe'] }); let diagnostic = '';
  daemon.stderr.on('data', chunk => { diagnostic += chunk.toString().slice(0, 500); });
  try {
    let listening = false;
    for (let attempt = 0; attempt < 50 && !listening && daemon.exitCode === null; attempt++) { await new Promise(resolve => setTimeout(resolve, 100)); const socket = net.connect(port, '127.0.0.1'); listening = await new Promise(resolve => { socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); }); }
    if (!listening) { process.stdout.write(`SFTP local daemon unavailable in this runtime (${diagnostic.replace(/[\r\n]/gu, ' ').slice(0,120)}); network integration PARTIAL.\n`); return false; }
    const provider = createSftpBackupProvider({ host: '127.0.0.1', port, username: os.userInfo().username, identityFile: clientKey, knownHostsFile: knownHosts, hostKey: fingerprint, remoteDirectory: remote });
    await provider.test(); await provider.publishSet({ directory: root, id: recoveryId }); await provider.publishSet({ directory: root, id: recoveryId });
    const published = await fs.readFile(path.join(remote, recoveryId, 'set.json'), 'utf8'); assert.equal(JSON.parse(published).encrypted, true);
    return true;
  } finally { daemon.kill('SIGTERM'); await new Promise(resolve => daemon.once('close', resolve)); }
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-ext-backup-'));
  const keyFile = path.join(root, 'key'); await fs.writeFile(keyFile, Buffer.alloc(32, 19), { mode: 0o600 });
  const set = path.join(root, 'synthetic.set'); await fs.mkdir(path.join(set, 'database'), { recursive: true });
  const payload = Buffer.from('synthetic encrypted backup payload'); await fs.writeFile(path.join(set, 'database', '0001.blob'), payload);
  await fs.writeFile(path.join(set, 'set.json'), JSON.stringify({ format: 'synthetic', encrypted: true }));
  const objects = new Map(), order = [], headers = new Map();
  const service = http.createServer((req, res) => { const key = new URL(req.url, 'http://127.0.0.1').pathname; order.push(`${req.method}:${key}`);
    if (!/^AWS4-HMAC-SHA256 Credential=SYNTHETIC1\//u.test(req.headers.authorization || '')) { res.writeHead(403).end(); return; }
    if (req.method === 'PUT') { const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => { const bytes = Buffer.concat(chunks); objects.set(key, bytes); headers.set(key, { hash: req.headers['x-amz-meta-sha256'], size: bytes.length }); res.writeHead(200).end(); }); return; }
    if (req.method === 'HEAD') { const row = headers.get(key); if (!row) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-length': String(row.size), 'x-amz-meta-sha256': row.hash }).end(); return; }
    if (req.method === 'DELETE') { objects.delete(key); headers.delete(key); res.writeHead(204).end(); return; }
    res.writeHead(405).end();
  });
  await new Promise((resolve, reject) => { service.once('error', reject); service.listen(0, '127.0.0.1', resolve); });
  const s3 = createS3BackupProvider({ endpoint: `http://127.0.0.1:${service.address().port}/`, bucket: 'synthetic-backups', region: 'us-east-1', accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-secret-key-value-123', test: true });
  const published = await s3.publishSet({ directory: root, id: 'invalid-id' }).catch(error => error);
  // Use a recovery-set-shaped synthetic ID for the transfer contract.
  const id = '00000000-0000-4000-8000-000000000001'; const validSet = path.join(root, `${id}.set`); await fs.rename(set, validSet);
  const result = await s3.publishSet({ directory: root, id });
  assert.equal(result.published, true); assert.equal(published.code, 'RECOVERY_SET_ID_INVALID');
  assert.deepEqual(await s3.test(), { reachable: true, readWriteVerified: true });
  assert.ok(order.findIndex(item => item.endsWith('/set.json')) > order.findIndex(item => item.includes('/database/0001.blob')));
  const objectKey = `/synthetic-backups/rotamoto-backups/${id}/database/0001.blob`;
  assert.deepEqual(objects.get(objectKey), payload);
  assert.match(order[0], /PUT/u);
  assert.throws(() => validateObjectPath('../escape'), { code: 'BACKUP_REMOTE_PATH_INVALID' });
  await assert.rejects(validatePublicEndpoint('http://127.0.0.1:9000/', { test: false }), { code: 'BACKUP_REMOTE_ENDPOINT_INVALID' });
  await assert.rejects(validatePublicEndpoint('https://127.0.0.1:9000/', { test: false }), { code: 'BACKUP_REMOTE_ENDPOINT_INVALID' });

  const destinations = createBackupDestinationStore({ directory: root, keyFile, test: true });
  const saved = await destinations.save({ name: 'Synthetic S3', provider: 's3', endpoint: 'http://127.0.0.1:9000/', bucket: 'synthetic-backups', region: 'us-east-1', accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-secret-key-value-123', active: true, retentionDays: 14 });
  assert.equal(saved.credentialConfigured, true); assert.equal(JSON.stringify(saved).includes('synthetic-secret-key-value-123'), false);
  assert.equal((await destinations.credentials(saved.id)).credentials.secretAccessKey, 'synthetic-secret-key-value-123');
  await destinations.save({ id: saved.id, name: 'Synthetic S3 edited', provider: 's3', endpoint: 'http://127.0.0.1:9000/', bucket: 'synthetic-backups', region: 'us-east-1', active: true, retentionDays: 10, minimumCopies: 1, priority: 100 });
  assert.equal((await destinations.credentials(saved.id)).credentials.secretAccessKey, 'synthetic-secret-key-value-123', 'editing retains credentials without returning them');
  const stored = await fs.readFile(path.join(root, 'destinations.enc'), 'utf8'); assert.equal(stored.includes('synthetic-secret-key-value-123'), false);
  assert.equal((await destinations.disable(saved.id)).active, false);

  const keyMaterial = Buffer.from('synthetic SSH host key');
  const syntheticFingerprint = `SHA256:${crypto.createHash('sha256').update(keyMaterial).digest('base64').replace(/=+$/u, '')}`;
  const knownHostsFile = path.join(root, 'known_hosts'); await fs.writeFile(knownHostsFile, `backup.example.net ssh-ed25519 ${keyMaterial.toString('base64')}\n`, { mode: 0o600 });
  await verifyPinnedHostKey({ host: 'backup.example.net', port: 22, knownHostsFile, expectedFingerprint: syntheticFingerprint });
  await assert.rejects(verifyPinnedHostKey({ host: 'unknown.example.net', port: 22, knownHostsFile, expectedFingerprint: syntheticFingerprint }), { code: 'BACKUP_SFTP_HOST_KEY_MISMATCH' });
  const sftp = createSftpBackupProvider({ host: 'backup.example.net', username: 'backup', identityFile: '/synthetic/key', knownHostsFile, hostKey: syntheticFingerprint, remoteDirectory: '/srv/backups' });
  assert.equal(typeof sftp.publishSet, 'function');
  assert.throws(() => createSftpBackupProvider({ host: 'backup.example.net;touch /tmp/pwned', username: 'backup', identityFile: '/synthetic/key', knownHostsFile: '/synthetic/known_hosts', hostKey: syntheticFingerprint, remoteDirectory: '/srv/backups' }), { code: 'BACKUP_SFTP_CONFIGURATION_INVALID' });
  const sftpNetwork = await localSftpTransfer({ root, recoveryId: id });
  await new Promise(resolve => service.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
  process.stdout.write(`Backup storage providers: synthetic S3 signed upload, manifest-last verification, encrypted credential vault, SSRF/path guards, pinned SSH host key and SFTP command validation PASS; SFTP local server ${sftpNetwork ? 'transfer PASS' : 'PARTIAL'}.\n`);
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
