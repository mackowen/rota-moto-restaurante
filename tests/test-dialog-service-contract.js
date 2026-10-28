'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const service=fs.readFileSync(path.join(root,'dialog-service.js'),'utf8');
const css=fs.readFileSync(path.join(root,'dialog-service.css'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
assert.match(service,/createElement\('dialog'\)/u);
assert.match(service,/setAttribute\('role', 'dialog'\)/u);
assert.match(service,/setAttribute\('aria-modal', 'true'\)/u);
assert.match(service,/setAttribute\('aria-labelledby'/u);
assert.match(service,/setAttribute\('aria-describedby'/u);
assert.match(service,/restoreFocus\.focus\(\)/u);
assert.match(service,/confirm\.disabled = true[\s\S]*?await config\.onConfirm/u);
assert.match(service,/config\.allowEscape !== false/u);
assert.match(service,/config\.closeOnBackdrop === true/u);
assert.match(service,/config\.validate\(value\)/u);
assert.match(css,/env\(safe-area-inset-bottom\)/u);
assert.match(css,/@media\(max-width:420px\)/u);
assert.match(html,/dialog-service\.css/u);
assert.match(html,/dialog-service\.js/u);
for(const name of ['app.js','identity-ui.js','logistics-ui.js']){
 const filename=path.join(root,name);if(!fs.existsSync(filename))continue;
 const source=fs.readFileSync(filename,'utf8');
 assert.doesNotMatch(source,/window\.(?:alert|confirm|prompt)\s*\(/u,`${name} must use the shared dialogs for app-controlled interactions`);
}
console.log('Shared dialog semantics, asset registration, focus handling, safety states and app call sites: PASS');
