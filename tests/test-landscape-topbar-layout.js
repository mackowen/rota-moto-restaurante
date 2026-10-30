'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'design-system.css'), 'utf8');
const baseCss = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const shortLandscapeRule = css.match(/@media\s*\(orientation:\s*landscape\)\s*and\s*\(min-width:\s*600px\)\s*and\s*\(max-width:\s*1023px\)\s*and\s*\(max-height:\s*520px\)\s*\{([^}]*)\}/);

assert.ok(shortLandscapeRule, 'short landscape phone override must be scoped by orientation, width and height');
assert.match(css, /@media\s*\(orientation:landscape\)\s*and\s*\(min-width:600px\)\s*and\s*\(max-width:1023px\)\s*and\s*\(max-height:520px\)\s*\{\.main\{padding-top:0\}\}/, 'the short landscape override must remove only the main top spacer');
assert.match(css, /@media\s*\(min-width:\s*600px\)\s*and\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.main\{[^}]*padding:\s*22px\s+clamp\(16px,3vw,32px\)\s+36px/, 'the tablet shell layout remains intact');
assert.match(baseCss, /\.topbar\{position:sticky;top:0;/, 'the page header remains sticky at the viewport top');
assert.doesNotMatch(shortLandscapeRule[1], /position\s*:|transform\s*:|margin-top\s*:/, 'the fix must not reposition the header or add a compensating hack');

console.log('PASS: landscape topbar layout rule stays scoped and preserves the sticky header and tablet shell.');
