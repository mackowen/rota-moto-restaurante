'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8'),match=source.match(/function toastDurationMs\(message,type\)\{[^\n]+\}/u);
assert.ok(match,'toast duration policy is centralized');const context={};vm.runInNewContext(`${match[0]}\nthis.duration=toastDurationMs;`,context);
assert.equal(context.duration('Salvo','success'),5000,'short success notices remain readable for at least five seconds');
assert.equal(context.duration('Erro','error'),7000,'errors remain visible longer than success notices');
assert.equal(context.duration('x'.repeat(500),'info'),12000,'very long notices have a bounded timeout');
assert.match(source,/toastDurationMs\(detail\.textContent,type\)/u,'the visible toast text determines its display duration');
console.log('Toast reading-time policy and bounds: PASS');
