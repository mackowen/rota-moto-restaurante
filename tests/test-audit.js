'use strict';
const fs=require('node:fs');
const path=require('node:path');
const cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
function assert(ok,msg){if(!ok)throw new Error(msg)}
function checkFile(p){assert(fs.existsSync(p),`Arquivo ausente: ${p}`)}
for(const f of ['app.js','contract.js','index.html','styles.css','server.js','99food-integration.js','keeta-integration.js','99food-service.js','keeta-service.js'])checkFile(path.join(root,f));
for(const f of ['app.js','contract.js','server.js','99food-integration.js','keeta-integration.js','99food-service.js','keeta-service.js'])cp.execFileSync(process.execPath,['--check',path.join(root,f)]);
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert(html.includes('contract.js')&&html.includes('app.js'),'Scripts principais não referenciados no HTML do Restaurante');
console.log('static audit integrity: OK');
