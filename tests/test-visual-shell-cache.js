'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const assetManifest=require('./helpers/asset-manifest').readAssetManifest();
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const worker=fs.readFileSync(require.resolve('../sw.js'),'utf8');
const identityAsset=html.match(/identity-ui\.js\?v=[^"']+/u)?.[0];
const manifest=JSON.parse(fs.readFileSync(require.resolve('../manifest.json'),'utf8'));
const designSystem=fs.readFileSync(require.resolve('../design-system.css'),'utf8');
const styles=fs.readFileSync(require.resolve('../styles.css'),'utf8');
for(const path of ['identity-ui.css','design-system.css','styles.css','pilot-views.css','dashboard-v2.css','orders-v2.css','routes-v2.css','app.js']){
  assert(assetManifest.assets.some(asset=>asset.includes(`/${path}?v=`)),`${path} is present in the content-versioned offline shell`);
}
assert.match(worker,/self\.RotaMotoAssetManifest\.cacheName/u,'updated visual assets derive a new atomic shell cache from content');
assert.match(html,/rel="icon" type="image\/svg\+xml" href="favicon\.svg\?v=[a-f0-9]{16}"/u);
assert.match(html,/rel="manifest" href="\/manifest\.json\?v=[a-f0-9]{16}"/u);
assert.match(html,/sizes="192x192" href="\/icons\/icon-192\.png\?v=[a-f0-9]{16}"/u);
assert.match(html,/sizes="512x512" href="\/icons\/icon-512\.png\?v=[a-f0-9]{16}"/u);
assert(assetManifest.assets.some(asset=>asset.includes('/manifest.json?v=')));
assert(assetManifest.assets.some(asset=>asset.includes('/icons/icon-192.png?v=')));
assert(assetManifest.assets.some(asset=>asset.includes('/icons/icon-512.png?v=')));
assert.equal(manifest.display,'standalone');
assert.equal(manifest.start_url,'/');
assert.deepEqual(manifest.icons.map(icon=>icon.sizes),['192x192','512x512']);
for(const icon of manifest.icons){
  const image=fs.readFileSync(require.resolve(`../${icon.src.slice(1)}`));
  assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16),Number.parseInt(icon.sizes,10));
  assert.equal(image.readUInt32BE(20),Number.parseInt(icon.sizes,10));
}
assert(assetManifest.assets.some(asset=>asset.includes('/favicon.svg?v=')));
assert(assetManifest.assets.some(asset=>asset.includes('/identity-ui.css?v=')));
assert.doesNotMatch(html,/rotamoto-map-runtime/u,'map runtime is lazy-loaded rather than eagerly downloaded on the login page');
assert.doesNotMatch(worker.split('const OPTIONAL_ASSETS')[0],/rotamoto-map-runtime|maplibre-gl-worker/u,'the offline shell does not precache heavy map JavaScript');
assert(identityAsset&&assetManifest.assets.includes(`./${identityAsset}`),'generated offline manifest includes the identity bundle referenced by index.html');
for(const path of ['server-update-coordinator.js','styles.css','design-system.css','orders-v2.css','pilot-views.css','app.js','dashboard-v2.js','dashboard-v2.css','routes-v2.css'])
  assert(assetManifest.assets.some(asset=>asset.includes(`/${path}?v=`)),`offline manifest contains the current ${path}`);
const stylesheetAsset=html.match(/styles\.css\?v=[^"']+/u)?.[0];assert(stylesheetAsset,'index declares a versioned stylesheet');
assert(assetManifest.assets.includes(`./${stylesheetAsset}`),'generated service worker manifest caches the exact stylesheet declared by index.html');
for(const path of ['order-money.js','logistics-ui.js','analytics-view.js','indexeddb-schema.js','analytics.js'])
  assert(assetManifest.assets.some(asset=>asset.includes(`/${path}?v=`)),`${path} has a generated shell revision`);
const appBundle=html.match(/app\.js\?v=[^"']+/u)?.[0];assert(appBundle,'index declares a versioned application bundle');assert(assetManifest.assets.includes(`./${appBundle}`),'offline shell includes the current application bundle');
assert(assetManifest.assets.some(asset=>asset.includes('/company-settings-persistence.js?v=')));
assert(assetManifest.assets.some(asset=>asset.includes('/pilot-views.css?v=')));
assert.match(worker,/self\.RotaMotoAssetManifest\.cachePrefix/u);
assert.match(designSystem,/@media\(max-width:1100px\)\{\.main\{padding-bottom:calc\(86px \+ env\(safe-area-inset-bottom\)\)\}\}/u,'tablet layouts reserve space for the fixed bottom navigation');
assert.match(worker,/optionalURLs\.has/u);
assert.match(worker,/shellURLs\.has\(url\.href\)/u);
assert.match(worker,/catch \(error\)[\s\S]*await caches\.delete\(CACHE_NAME\)/u);assert.doesNotMatch(worker,/skipWaiting/u);
assert.match(fs.readFileSync(require.resolve('../app.js'),'utf8'),/rotamoto-map-runtime\.js\?v=[a-f0-9]{16}/u,'map runtime remains available for lazy loading with a content revision');
assert.match(designSystem,/max-width:560px[\s\S]*position:sticky/u);
assert.doesNotMatch(designSystem,/max-width:560px[^}]*position:static/u);
assert.match(styles,/@media\(max-width:800px\)[\s\S]*?\.topbar\{position:sticky;top:0;z-index:1500/u);
assert.doesNotMatch(styles,/\.topbar\{position:static/u,'no later mobile breakpoint resets the shared sticky header');
assert.match(styles,/--card:var\(--surface\);--card2:var\(--surface-soft\);--hero:var\(--accent\)/u,'legacy surface tokens resolve through the active semantic theme');
console.log('Restaurant mobile header and atomic shell contracts: PASS');
