'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHttpBackupRemote, validateRemoteUrl } = require('../backend/runtime/backup-remote-provider');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rotamoto-remote-set-'));
  const id = '09a9b439-7047-4b58-9682-8753da4a809f', dir = path.join(root, `${id}.set`);
  await fs.mkdir(path.join(dir, 'media'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, 'dump.enc'), Buffer.from('encrypted-synthetic-dump'), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'media', '00000000.blob'), Buffer.from('encrypted-synthetic-media'), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'set.json'), Buffer.from('{"synthetic":true}'), { mode: 0o600 });
  const objects = new Map(); let published = false;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer 0228-local-simulator-token-0123456789') { res.writeHead(401).end(); return; }
    const match = /^\/sets\/([0-9a-f-]{36})\/(.+)$/u.exec(req.url);
    if (match && req.method === 'PUT') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const data = Buffer.concat(chunks);
      const digest = crypto.createHash('sha256').update(data).digest('hex');
      if (digest !== req.headers['x-content-sha256']) { res.writeHead(400).end(); return; }
      objects.set(match[2], data); res.writeHead(201).end(); return;
    }
    if (match && req.method === 'HEAD') {
      const data = objects.get(match[2]); if (!data) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-length': data.length, 'x-content-sha256': crypto.createHash('sha256').update(data).digest('hex') }).end(); return;
    }
    if (req.url === `/sets/${id}/publish` && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const value = JSON.parse(body), manifest = objects.get('set.json');
      if (!manifest || value.manifestSha256 !== crypto.createHash('sha256').update(manifest).digest('hex')) { res.writeHead(409).end(); return; }
      published = true; res.writeHead(200).end(); return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;
    assert.throws(() => validateRemoteUrl('http://example.com/', { test: true }), /BACKUP_REMOTE_CONFIGURATION_INVALID/u);
    const remote = createHttpBackupRemote({ baseUrl, test: true, token: '0228-local-simulator-token-0123456789' });
    const result = await remote.publishSet({ directory: root, id });
    assert.deepEqual(result, { published: true, fileCount: 3 }); assert.equal(published, true);
    assert.equal(objects.size, 3);
    process.stdout.write('Backup remote adapter: real loopback HTTP PUT/HEAD checksum verification and manifest-last publication PASS\n');
  } finally {
    await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
