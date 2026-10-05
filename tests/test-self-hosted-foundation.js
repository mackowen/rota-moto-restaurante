'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createFilesystemObjectStore } = require('../backend/domain/filesystem-object-store');
const { createMediaStorage } = require('../backend/domain/media-storage');
const { createFileSecretProvider, initializeFileSecretStore } = require('../backend/runtime/file-secret-provider');
const { generateSecret, codeAt, verifyCode, generateRecoveryCodes, recoveryDigest } = require('../backend/identity/totp');
const { createFilesystemBackupProvider } = require('../backend/runtime/backup-provider');
const { rotateFileKeystore } = require('../backend/runtime/keystore-rotation');
const { runProofMediaGc } = require('../backend/domain/proof-media-gc');
const { createEncryptedBackup, verifyArtifact, restoreEncryptedBackup } = require('../backend/runtime/backup-runner');
const { appendOperatorAudit } = require('../backend/runtime/operator-audit');

(async () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'rotamoto-local-'));
  try {
    const keys = path.join(root, 'keys'), keyFile = path.join(root, 'master.key'), media = path.join(root, 'media'), backups = path.join(root, 'backups');
    await initializeFileSecretStore({ directory: keys, masterKeyFile: keyFile });
    const secrets = await createFileSecretProvider({ directory: keys, masterKeyFile: keyFile });
    const saved = await secrets.put({ name: 'smtp/password', scope: 'installation', value: 'secret-value' });
    const mfa = await secrets.put({ name: 'identity/mfa/00000000-0000-4000-8000-000000000000', scope: 'installation', value: 'totp-secret' });
    assert.equal(await secrets.get(saved.secretRef, { name: 'smtp/password', scope: 'installation' }), 'secret-value');
    await assert.rejects(secrets.get(saved.secretRef, { name: 'smtp/password', scope: 'tenant', tenantId: '00000000-0000-4000-8000-000000000000' }));
    const objectStore = await createFilesystemObjectStore({ directory: await fs.mkdir(media, { mode: 0o700 }).then(() => media) });
    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0]);
    const stored = await objectStore.putProof({ companyId: '00000000-0000-4000-8000-000000000000', deliveryId: '00000000-0000-4000-8000-000000000001', contentType: 'image/png', source: Readable.from(png) });
    assert.equal((await objectStore.get(stored.reference, stored)).sha256, stored.sha256);
    const mediaAdapter=createMediaStorage({objectStore});
    assert.equal((await mediaAdapter.validateReference(stored.reference,{companyId:'00000000-0000-4000-8000-000000000000',deliveryId:'00000000-0000-4000-8000-000000000001',mimeType:stored.contentType,sizeBytes:stored.sizeBytes,sha256:stored.sha256})).valid,true);
    assert.equal((await mediaAdapter.validateReference(stored.reference,{companyId:'00000000-0000-4000-8000-000000000000',deliveryId:'00000000-0000-4000-8000-000000000099',mimeType:stored.contentType,sizeBytes:stored.sizeBytes,sha256:stored.sha256})).valid,false);
    await assert.rejects(objectStore.get({ provider: 'filesystem-v1', objectKey: '../../etc/passwd' }, stored));
    await assert.rejects(objectStore.putProof({ companyId: '00000000-0000-4000-8000-000000000000', deliveryId: '00000000-0000-4000-8000-000000000001', contentType: 'image/png', source: Readable.from(Buffer.from('not image')) }));
    const listed=await objectStore.listProofObjects({olderThan:new Date(Date.now()+1000)});assert.equal(listed.length,1);
    const dbPool={async connect(){return{async query(sql){if(sql.includes('proof_media_upload_intents'))return{rowCount:0};if(sql.includes('domain_records'))return{rowCount:0};return{rowCount:0}},release(){}}}};
    const dry=await runProofMediaGc({pool:dbPool,objectStore,now:()=>new Date(Date.now()+60_000),graceMs:60_000,dryRun:true});assert.equal(dry.orphaned,1);assert.equal(dry.removed,0);
    const keptPool={async connect(){return{async query(sql){return{rowCount:sql.includes('domain_records')?1:0}},release(){}}}};
    assert.equal((await runProofMediaGc({pool:keptPool,objectStore,now:()=>new Date(Date.now()+60_000),graceMs:60_000,dryRun:false})).skipped,1);
    assert.equal((await runProofMediaGc({pool:dbPool,objectStore,now:()=>new Date(Date.now()+60_000),graceMs:60_000,dryRun:false})).removed,1);
    await assert.rejects(fs.stat(path.join(media,...stored.reference.objectKey.split('/'))),{code:'ENOENT'});
    const manifestFile=path.join(root,'rotation-manifest.json');await fs.writeFile(manifestFile,JSON.stringify([
      {ref:saved.secretRef,name:'smtp/password',scope:'installation'},
      {ref:mfa.secretRef,name:'identity/mfa/00000000-0000-4000-8000-000000000000',scope:'installation'}]),{mode:0o600});
    await fs.writeFile(manifestFile,JSON.stringify([{ref:saved.secretRef,name:'smtp/password',scope:'installation'}]));
    await assert.rejects(rotateFileKeystore({directory:keys,masterKeyFile:keyFile,manifestFile}));
    await fs.writeFile(manifestFile,JSON.stringify([
      {ref:saved.secretRef,name:'smtp/password',scope:'installation'},
      {ref:mfa.secretRef,name:'identity/mfa/00000000-0000-4000-8000-000000000000',scope:'installation'}]));
    await assert.rejects(rotateFileKeystore({directory:keys,masterKeyFile:keyFile,manifestFile,failpoint:'after-directory-swap'}));
    const restoredProvider=await createFileSecretProvider({directory:keys,masterKeyFile:keyFile});assert.equal(await restoredProvider.get(saved.secretRef,{name:'smtp/password',scope:'installation'}),'secret-value');
    await assert.rejects(rotateFileKeystore({directory:keys,masterKeyFile:keyFile,manifestFile,failpoint:'after-key-swap'}));
    const restoredAfterKeySwap=await createFileSecretProvider({directory:keys,masterKeyFile:keyFile});assert.equal(await restoredAfterKeySwap.get(mfa.secretRef,{name:'identity/mfa/00000000-0000-4000-8000-000000000000',scope:'installation'}),'totp-secret');
    const rotated=await rotateFileKeystore({directory:keys,masterKeyFile:keyFile,manifestFile});assert.equal(rotated.secrets,2);
    const rotatedProvider=await createFileSecretProvider({directory:keys,masterKeyFile:keyFile});assert.equal(await rotatedProvider.get(mfa.secretRef,{name:'identity/mfa/00000000-0000-4000-8000-000000000000',scope:'installation'}),'totp-secret');
    const secret = generateSecret(), now = 1_800_000_000_000, code = codeAt(secret, Math.floor(now / 30000));
    const counter = verifyCode(secret, code, { now }); assert.equal(counter, Math.floor(now / 30000));
    assert.equal(verifyCode(secret, code, { now, lastCounter: counter }), null);
    const recovery = generateRecoveryCodes(); assert.equal(recovery.length, 10); assert.equal(recoveryDigest(recovery[0]).length, 32);
    const backup = await createFilesystemBackupProvider({ directory: backups });
    const backupResult = await backup.write(Readable.from(Buffer.from('test-backup')));
    assert.equal(backupResult.sizeBytes, 11); assert.equal((await fs.stat(path.join(backups, `${backupResult.id}.dump`))).mode & 0o077, 0);
    const backupKey=path.join(root,'backup.key');await fs.writeFile(backupKey,crypto.randomBytes(32),{mode:0o600});
    const fakePgDump=path.join(root,'pg_dump_fake'),fakePgRestore=path.join(root,'pg_restore_fake');
    await fs.writeFile(fakePgDump,`#!${process.execPath}\nprocess.stdout.write(Buffer.from("PGDMP-self-hosted-rehearsal"));\n`,{mode:0o700});
    await fs.writeFile(fakePgRestore,`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);if(a[0]==="--list"){process.exit(fs.readFileSync(a[1]).toString().startsWith("PGDMP")?0:2)}if(!a.some(x=>x==="--dbname=postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto_disposable_rehearsal"))process.exit(3);\n`,{mode:0o700});
    const artifact=await createEncryptedBackup({databaseUrl:'postgresql://rotamoto_backup@127.0.0.1:5432/rotamoto_e2e',keyFile:backupKey,directory:backups,pgDump:fakePgDump,pgRestore:fakePgRestore,now:new Date('2026-10-05T00:00:00.000Z')});
    const verified=await verifyArtifact({directory:backups,id:artifact.id,keyFile:backupKey});assert.equal(verified.manifest.sha256,artifact.sha256);
    assert.deepEqual(await restoreEncryptedBackup({directory:backups,id:artifact.id,targetUrl:'postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto_disposable_rehearsal',keyFile:backupKey,pgRestore:fakePgRestore,tempDirectory:root}),{restored:true,database:'rotamoto_disposable_rehearsal',backupId:artifact.id});
    await assert.rejects(restoreEncryptedBackup({directory:backups,id:artifact.id,targetUrl:'postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto',keyFile:backupKey,pgRestore:fakePgRestore,tempDirectory:root}));
    await assert.rejects(restoreEncryptedBackup({directory:backups,id:artifact.id,targetUrl:'postgresql://rotamoto_restore@127.0.0.1:5432/rotamoto_e2e',keyFile:backupKey,pgRestore:fakePgRestore,tempDirectory:root}));
    const auditPath=path.join(root,'operator-audit.jsonl');const previousAudit=process.env.ROTAMOTO_OPERATOR_AUDIT_LOG,previousActor=process.env.ROTAMOTO_OPERATOR_ACTOR_REF;
    process.env.ROTAMOTO_OPERATOR_AUDIT_LOG=auditPath;process.env.ROTAMOTO_OPERATOR_ACTOR_REF='operator:test';
    await appendOperatorAudit('secret.put.completed',{name:'smtp/password',secretRef:saved.secretRef,secret:'must-not-be-logged'});
    const auditText=await fs.readFile(auditPath,'utf8');assert(!auditText.includes('must-not-be-logged'));assert(!auditText.includes(saved.secretRef));assert.equal((await fs.stat(auditPath)).mode&0o077,0);
    if(previousAudit===undefined)delete process.env.ROTAMOTO_OPERATOR_AUDIT_LOG;else process.env.ROTAMOTO_OPERATOR_AUDIT_LOG=previousAudit;
    if(previousActor===undefined)delete process.env.ROTAMOTO_OPERATOR_ACTOR_REF;else process.env.ROTAMOTO_OPERATOR_ACTOR_REF=previousActor;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  process.stdout.write('Self-hosted foundation tests passed.\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
