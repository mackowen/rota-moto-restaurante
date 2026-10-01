'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const definitions = source.split('\n').filter(line =>
  line.startsWith('const esc=') || line.startsWith('const statusLabel=') ||
  line.startsWith('const statusClass=') || line.startsWith('function status(')
).join('\n');
const context = {};
vm.runInNewContext(`${definitions}\nglobalThis.renderStatus=status;`, context);

assert.equal(context.renderStatus('EM_ROTA'), '<span class="status route">Em rota</span>');
assert.equal(
  context.renderStatus('<img src=x onerror=alert(1)>'),
  '<span class="status ">Status desconhecido</span>',
  'untrusted status values from backups or providers must never become HTML'
);
console.log('status rendering security tests: OK');
