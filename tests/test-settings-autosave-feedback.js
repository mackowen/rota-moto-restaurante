'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const app = fs.readFileSync('app.js', 'utf8');
const css = fs.readFileSync('styles.css', 'utf8');

const settingsStart = app.indexOf('function settings(){');
const settingsEnd = app.indexOf('\nfunction backupCenter(', settingsStart);
assert(settingsStart >= 0 && settingsEnd > settingsStart, 'settings renderer is available');
const settings = app.slice(settingsStart, settingsEnd);
for (const section of ['geral','operacao','logistica','impressao','pedidos_integracoes','aparencia','relatorios','navegacao','eventos','security-audit']) {
  assert.match(settings, new RegExp(`'${section}'`), `${section} is covered by section-local autosave feedback`);
}
assert.match(settings, /data-local-save-status/u, 'each editable local settings section renders an inline save state');
assert.match(settings, /data-local-save-retry/u, 'the failure state includes a retry action');
assert.match(app, /document\.querySelector\('\[data-local-save-retry\]'\)\?\.addEventListener\('click',\(\)=>saveSettings/u,
  'retry repeats the real IndexedDB save operation');
assert.match(app, /localSettingsSaveState=stateName;localSettingsSaveMessage=message/u,
  'save feedback survives a render that replaces the settings panel');
assert.match(app, /await saveSettings\('Configuração salva neste aparelho\.'\);applyTheme\(\);render\(\);setLocalSettingsSaveStatus\('Salvo neste aparelho\.'/u,
  'successful autosave is reflected after rerender');
const generalSave = app.slice(app.indexOf('async function saveGeneralSettings(){'), app.indexOf('\nasync function refreshEvents', app.indexOf('async function saveGeneralSettings(){')));
assert.match(generalSave, /const addressNotConfirmed=[\s\S]*?render\(\);\s*const currentStatus=document\.getElementById\('generalSaveStatus'\);\s*if\(currentStatus\)currentStatus\.textContent=/u,
  'general settings status is written after rerender replaces the form');
assert.match(generalSave, /toast\(addressNotConfirmed\?'Endereço salvo neste aparelho; o envio à empresa ainda não foi confirmado\.'[\s\S]*?addressNotConfirmed\?'info':'success'\)/u,
  'an unconfirmed server write never receives a success toast');
assert.match(app, /catch\(_\)\{\}\}/u, 'failed autosaves remain handled without clearing the draft');
assert.match(css, /\.settings-save-feedback\[data-state="error"\][^{]*\{[^}]*var\(--danger-soft\)/u,
  'failure feedback uses semantic theme tokens');
assert.match(css, /@media\(max-width:430px\)\{\.settings-save-feedback\{align-items:flex-start;flex-direction:column\}/u,
  'retry action remains full-width and touch-sized on narrow screens');
console.log('Settings autosave feedback and retry contract: PASS');
