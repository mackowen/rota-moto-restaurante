'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const update=source.slice(source.indexOf('async function updateSetting('),source.indexOf('\nfunction persistPrintSettings('));
assert.match(update,/if\(\['theme','accent','language'\]\.includes\(path\)\)\{applyTheme\(\);render\(\);try\{await saveSettings\('Aparência salva neste aparelho\.'\)\}catch\(_\)\{\}return\}/u,
  'appearance applies/renders before autosave and has no late render that can erase explicit-save feedback');
assert.match(source,/data-setting="theme"[\s\S]*?data-setting="accent"[\s\S]*?data-setting="language"[\s\S]*?data-save-appearance/u,
  'theme, accent, language and the existing explicit confirmation remain available');
assert.match(source,/data-save-appearance[\s\S]*?saveSettings\('Aparência salva neste aparelho\.',\{feedback:false\}\)[\s\S]*?Aparência gravada neste aparelho/u,
  'appearance confirmation is only shown after the serialized IndexedDB save resolves');
assert.match(source,/function applyTheme\(\)\{[\s\S]*?root\.dataset\.theme=mode[\s\S]*?root\.dataset\.resolvedTheme=dark\?'dark':'light'/u,
  'the selected theme and resolved theme are applied consistently');

process.stdout.write('Appearance persistence and save feedback contract: PASS\n');
