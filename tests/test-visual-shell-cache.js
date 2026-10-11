'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const worker=fs.readFileSync(require.resolve('../sw.js'),'utf8');
const designSystem=fs.readFileSync(require.resolve('../design-system.css'),'utf8');
assert.match(html,/identity-ui\.css[\s\S]*design-system\.css/u,'design system loads after identity component styles');
assert.match(worker,/\/design-system\.css/u,'offline app shell precaches the design system');
assert.match(worker,/\/app\.js\?v=0139\.1/u,'offline app shell uses the same application revision as HTML');
assert.match(html,/app\.js\?v=0139\.1/u,'HTML and app shell revisions are aligned');
assert.ok(worker.includes('`${CACHE_PREFIX}v14`'),'shell cache advances when its asset manifest changes');
assert.match(html,/vendor\/rotamoto-map-runtime\.js\?v=0139\.1/u,'HTML loads the current map runtime');
assert.match(worker,/vendor\/rotamoto-map-runtime\.js\?v=0139\.1/u,'offline shell caches the current map runtime');
assert.match(worker,/maplibre-gl-worker\.mjs\?v=0139\.1/u,'offline shell caches the local map worker');
assert.match(designSystem,/@media\(max-width:560px\)\{\.main\{padding:calc\(116px \+ env\(safe-area-inset-top\)\)/u,
  'mobile content reserves space for the fixed, wrapping header and device safe area');
console.log('Restaurant visual foundation offline shell contract: PASS');
