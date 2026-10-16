'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createS3BackupProvider, createSftpBackupProvider, validatePublicEndpoint, validateObjectPath } = require('../backend/runtime/backup-storage-providers');
const { createBackupDestinationStore, validateDestination } = require('../backend/runtime/backup-destination-store');
const { verifyPinnedHostKey } = require('../backend/runtime/backup-destination-store');

async function freePort() { const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function validSigV4(req, body) {
  const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/u.exec(req.headers.authorization || '');
  if (!auth || auth[1] !== 'SYNTHETIC1') return false;
  const [, accessKey, date, region, signedHeaders, supplied] = auth;
  const names = signedHeaders.split(';'), canonicalHeaders = names.map(name => `${name}:${String(req.headers[name] || '').trim().replace(/\s+/gu, ' ')}\n`).join('');
  const raw = req.url.split('?'), query = raw[1] || '', payloadHash = crypto.createHash('sha256').update(body).digest('hex');
  if (req.headers['x-amz-content-sha256'] !== payloadHash) return false;
  const canonical = [req.method, raw[0], query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const amzDate = req.headers['x-amz-date'], scope = `${date}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${crypto.createHash('sha256').update(canonical).digest('hex')}`;
  const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
  const signingKey = hmac(hmac(hmac(hmac(Buffer.from('AWS4synthetic-secret-key-value-123'), date), region), 's3'), 'aws4_request');
  const expected = hmac(signingKey, toSign).toString('hex');
  return accessKey === 'SYNTHETIC1' && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
function asn1(tag, value) { const body = Buffer.from(value); if (body.length < 128) return Buffer.concat([Buffer.from([tag, body.length]), body]); const octets=[];let length=body.length;while(length){octets.unshift(length&255);length>>=8}return Buffer.concat([Buffer.from([tag,0x80|octets.length,...octets]),body]); }
function asn1Sequence(...values) { return asn1(0x30, Buffer.concat(values)); }
function asn1Oid(dotted) { const ids=dotted.split('.').map(Number), bytes=[40*ids[0]+ids[1]]; for(const id of ids.slice(2)){const parts=[id&0x7f];let value=id>>>7;while(value){parts.unshift((value&0x7f)|0x80);value>>>=7}bytes.push(...parts)}return asn1(0x06,bytes); }
function localInvalidTlsCertificate() {
  const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048}), exported=pair.publicKey.export({type:'spki',format:'der'}), now=new Date(), time=value=>asn1(0x17,`${String(value.getUTCFullYear()%100).padStart(2,'0')}${String(value.getUTCMonth()+1).padStart(2,'0')}${String(value.getUTCDate()).padStart(2,'0')}${String(value.getUTCHours()).padStart(2,'0')}${String(value.getUTCMinutes()).padStart(2,'0')}${String(value.getUTCSeconds()).padStart(2,'0')}Z`), cn=asn1Sequence(asn1Oid('2.5.4.3'),asn1(0x0c,'localhost')), name=asn1Sequence(asn1(0x31,cn));
  const serial=crypto.randomBytes(16);serial[0]&=0x7f;const algorithm=asn1Sequence(asn1Oid('1.2.840.113549.1.1.11'),asn1(0x05,[])), san=asn1Sequence(asn1(0x82,'localhost')), extension=asn1Sequence(asn1Oid('2.5.29.17'),asn1(0x04,san)), extensions=asn1(0xa3,asn1Sequence(extension));
  const tbs=asn1Sequence(asn1(0xa0,asn1(0x02,[2])),asn1(0x02,serial),algorithm,name,asn1Sequence(time(now),time(new Date(now.getTime()+86_400_000))),name,exported,extensions), signature=crypto.sign('sha256',tbs,pair.privateKey), certificate=asn1Sequence(tbs,algorithm,asn1(0x03,Buffer.concat([Buffer.from([0]),signature])));
  const pem=buffer=>`-----BEGIN CERTIFICATE-----\n${buffer.toString('base64').match(/.{1,64}/gu).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: pair.privateKey.export({type:'pkcs8',format:'pem'}), cert: pem(certificate) };
}
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
    const wrongHostKey = createSftpBackupProvider({ host: '127.0.0.1', port, username: os.userInfo().username, identityFile: clientKey, knownHostsFile: knownHosts, hostKey: `SHA256:${crypto.randomBytes(32).toString('base64').replace(/=+$/u, '')}`, remoteDirectory: remote });
    await assert.rejects(wrongHostKey.test(), { code: 'BACKUP_SFTP_HOST_KEY_MISMATCH' });
    await provider.test(); await provider.publishSet({ directory: root, id: recoveryId }); await provider.publishSet({ directory: root, id: recoveryId });
    const published = await fs.readFile(path.join(remote, recoveryId, 'set.json'), 'utf8'); assert.equal(JSON.parse(published).encrypted, true);
    const remoteSets = await provider.listRecoverySets(); assert(remoteSets.some(item => item.id === recoveryId));
    const unsafeLink = path.join(remote, 'unsafe-link'); await fs.symlink('/etc/passwd', unsafeLink);
    await assert.rejects(provider.listObjects(), { code: 'BACKUP_REMOTE_SYMLINK_REJECTED' }); await fs.unlink(unsafeLink);
    const restored = path.join(directory, 'downloads'); await fs.mkdir(restored, { mode: 0o700 });
    const downloaded = await provider.downloadSet({ directory: restored, id: recoveryId });
    assert.equal(downloaded.downloaded, true); assert.deepEqual(await fs.readFile(path.join(downloaded.directory, 'database', '0001.blob')), Buffer.from('synthetic encrypted backup payload'));
    await assert.rejects(provider.deleteSet({ id: recoveryId, retainIds: [recoveryId] }), { code: 'BACKUP_REMOTE_RETENTION_BLOCKED' });
    assert.equal((await provider.deleteSet({ id: recoveryId })).deleted, true);
    assert.equal((await provider.listRecoverySets()).some(item => item.id === recoveryId), false);
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
  const service = http.createServer((req, res) => { const parsed = new URL(req.url, 'http://127.0.0.1'), key = parsed.pathname; order.push(`${req.method}:${key}`); const chunks=[];
    req.on('data',chunk=>chunks.push(chunk)); req.on('end',()=>{const body=Buffer.concat(chunks);if(!validSigV4(req,body)){res.writeHead(403).end();return;}
    if (req.method === 'PUT') { const bytes = body; objects.set(key, bytes); headers.set(key, { hash: req.headers['x-amz-meta-sha256'], size: bytes.length }); res.writeHead(200).end(); return; }
    if (req.method === 'HEAD') { const row = headers.get(key); if (!row) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-length': String(row.size), 'x-amz-meta-sha256': row.hash }).end(); return; }
    if (req.method === 'GET' && parsed.searchParams.has('list-type')) { const prefix = parsed.searchParams.get('prefix') || '', all = [...objects.entries()].filter(([objectPath]) => objectPath.slice('/synthetic-backups/'.length).startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)), start = Number(parsed.searchParams.get('continuation-token') || 0), page = all.slice(start,start+1), next = start+page.length;
      const escape = value => value.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/>/gu,'&gt;');
      res.writeHead(200, { 'content-type':'application/xml' }).end(`<ListBucketResult><IsTruncated>${next<all.length}</IsTruncated>${page.map(([objectPath,bytes])=>`<Contents><Key>${escape(objectPath.slice('/synthetic-backups/'.length))}</Key><Size>${bytes.length}</Size><ETag>\"synthetic\"</ETag></Contents>`).join('')}${next<all.length?`<NextContinuationToken>${next}</NextContinuationToken>`:''}</ListBucketResult>`); return; }
    if (req.method === 'GET') { const bytes = objects.get(key); if (!bytes) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-length': String(bytes.length) }).end(bytes); return; }
    if (req.method === 'DELETE') { objects.delete(key); headers.delete(key); res.writeHead(204).end(); return; }
    res.writeHead(405).end();
    });
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
  const listed = await s3.listRecoverySets(); assert(listed.some(item => item.id === id));
  assert.equal((await s3.listObjects(`rotamoto-backups/${id}/`)).length, 2, 'paginated inventory includes data and manifest');
  const remoteDownloads = path.join(root, 'downloads'); await fs.mkdir(remoteDownloads, { mode: 0o700 });
  const remoteDownload = await s3.downloadSet({ directory: remoteDownloads, id }); assert.equal(remoteDownload.fileCount, 2);
  assert.deepEqual(await fs.readFile(path.join(remoteDownload.directory, 'database', '0001.blob')), payload);
  const dataKey = `/synthetic-backups/rotamoto-backups/${id}/database/0001.blob`, pristine = objects.get(dataKey);
  objects.set(dataKey, Buffer.from('corrupted encrypted object'));
  await assert.rejects(s3.verify(`rotamoto-backups/${id}/database/0001.blob`, { sizeBytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') }), { code: 'BACKUP_REMOTE_VERIFY_FAILED' });
  objects.set(dataKey, pristine);
  await assert.rejects(s3.deleteSet({ id, retainIds: [id] }), { code: 'BACKUP_REMOTE_RETENTION_BLOCKED' });
  assert.equal((await s3.deleteSet({ id })).deleted, true);
  assert.equal((await s3.listRecoverySets()).some(item => item.id === id), false);
  const rejectedAuth = createS3BackupProvider({ endpoint: `http://127.0.0.1:${service.address().port}/`, bucket: 'synthetic-backups', region: 'us-east-1', accessKeyId: 'WRONGKEY1', secretAccessKey: 'synthetic-secret-key-value-123', test: true });
  await assert.rejects(rejectedAuth.listObjects('rotamoto-backups/'), { code: 'BACKUP_REMOTE_AUTH_REJECTED' });
  let retryAttempts = 0;
  const unavailable = createS3BackupProvider({ endpoint: 'https://storage.example.net/', bucket: 'synthetic-backups', region: 'us-east-1', accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-secret-key-value-123', test: true, fetchImpl: async () => { retryAttempts++; throw new Error('synthetic timeout'); } });
  await assert.rejects(unavailable.listObjects('rotamoto-backups/'), { code: 'BACKUP_REMOTE_RETRYABLE' }); assert.equal(retryAttempts, 3, 'network retries are bounded');
  const tlsService = https.createServer(localInvalidTlsCertificate(), (_req, res) => res.writeHead(200).end('<ListBucketResult/>'));
  await new Promise((resolve, reject) => { tlsService.once('error', reject); tlsService.listen(0, '127.0.0.1', resolve); });
  const invalidTls = createS3BackupProvider({ endpoint: `https://localhost:${tlsService.address().port}/`, bucket: 'synthetic-backups', region: 'us-east-1', accessKeyId: 'SYNTHETIC1', secretAccessKey: 'synthetic-secret-key-value-123', test: true });
  await assert.rejects(invalidTls.listObjects('rotamoto-backups/'), { code: 'BACKUP_REMOTE_RETRYABLE' });
  await new Promise(resolve => tlsService.close(resolve));
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
  await destinations.recordTest(saved.id, { ok: false, errorCode: 'BACKUP_REMOTE_AUTH_REJECTED', diagnostic: 'must not persist' });
  assert.equal((await destinations.list())[0].lastTest.status, 'FAILED');
  assert.equal(JSON.stringify((await destinations.list())[0]).includes('must not persist'), false, 'destination diagnostics stay allowlisted');
  const stored = await fs.readFile(path.join(root, 'destinations.enc'), 'utf8'); assert.equal(stored.includes('synthetic-secret-key-value-123'), false);
  assert.equal((await destinations.disable(saved.id)).active, false);

  const keyMaterial = Buffer.from('synthetic SSH host key');
  const syntheticFingerprint = `SHA256:${crypto.createHash('sha256').update(keyMaterial).digest('base64').replace(/=+$/u, '')}`;
  const confirmedSftp = { name: 'Synthetic SFTP', provider: 'sftp', host: 'backup.example.net', username: 'backup', identityFile: '/synthetic/key', knownHostsFile: '/synthetic/known_hosts', hostKey: syntheticFingerprint, hostKeyConfirmed: true, remoteDirectory: '/srv/backups', active: true, retentionDays: 30 };
  assert.equal(validateDestination(confirmedSftp).provider, 'sftp', 'new SFTP destinations require explicit pinned-host confirmation');
  await assert.rejects(Promise.resolve().then(() => validateDestination({ ...confirmedSftp, hostKeyConfirmed: false })), { code: 'BACKUP_SFTP_HOST_KEY_CONFIRMATION_REQUIRED' });
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
