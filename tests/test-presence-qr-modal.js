'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'presence-qr.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const flow = app.slice(app.indexOf('async function issueRestaurantPresenceQr'), app.indexOf('\nfunction bindRestaurantQueueControl'));
const modal = app.slice(app.indexOf('function modal(html)'), app.indexOf('\nfunction closeModal()'));
const sharedDialogKeys = app.slice(app.indexOf("document.addEventListener('keydown',e=>{const dialog="), app.indexOf('let activeToastTimer'));

assert.match(flow, /restaurantQueueRequest\('\/qr',\{\}\)/u, 'modal keeps the authenticated QR issue endpoint');
assert.match(flow, /qrDraw\(canvas,result\.token,qrSize\)/u, 'the signed server token is rendered by the existing QR encoder');
assert.match(flow, /new Date\(result\?\.expiresAt\)/u, 'expiration timestamp comes from the server response');
assert.match(flow, /Number\(result\?\.expiresInSeconds\)/u, 'displayed validity comes from the server TTL');
assert.match(flow, /window\.innerWidth<=640\?244:window\.innerWidth<=1024\?280:300,window\.innerWidth-100/u, 'QR target size adapts to phone, tablet and desktop dialog width');
assert.match(flow, /Date\.now\(\)>=expiresAtMs/u, 'expiration is evaluated against the actual timestamp');
assert.match(flow, /role="status" aria-live="polite" hidden>Este QR expirou/u, 'expiration is announced once with contextual guidance');
assert.match(flow, /Uso único · Sem dados pessoais/u, 'only protocol-supported privacy and single-use claims are displayed');
assert.match(sharedDialogKeys, /e\.key==='Escape'[\s\S]*closeModal\(\)/u, 'Escape closes the QR dialog through the shared modal lifecycle');
assert.match(sharedDialogKeys, /e\.key!=='Tab'[\s\S]*last\.focus\(\)/u, 'the shared focus trap keeps keyboard focus inside the QR dialog');
assert.doesNotMatch(flow, /onDialogKeydown|presenceQrDialogCleanup/u, 'the QR modal relies on one shared keyboard/focus handler rather than nested traps');
assert.match(flow, /data-presence-qr-refresh[\s\S]*data-close/u, 'renewal is the primary action followed by close');
assert.match(modal, /aria-modal="true"/u, 'shared dialog is modal');
assert.match(modal, /modalReturnFocus=document\.activeElement/u, 'shared dialog preserves the return-focus target');
assert.match(modal, /presenceQr\?'modal-presence-qr'/u, 'shared modal receives a scoped QR modifier');
assert.match(css, /\.presence-qr-code canvas\{[^}]*aspect-ratio:1[^}]*background:#fff/u, 'QR remains square on a white surface');
assert.match(css, /\.presence-qr-expiry\{[^}]*justify-content:space-between/u, 'expiration label and server time share one aligned row');
assert.match(css, /@media\(min-width:520px\)[\s\S]*\.presence-qr-actions\{grid-template-columns:1fr 1fr/u, 'wide modal actions can be placed side by side');
assert.match(css, /@media\(max-width:430px\)[\s\S]*\.modal-presence-qr/u, 'phone modal uses compact responsive spacing');
assert.match(css, /\.modal-presence-qr\{[^}]*overflow:auto/u, 'modal permits vertical scrolling when viewport height is insufficient');
assert.match(css, /@media\(max-height:520px\)[\s\S]*max-height:calc\(100dvh - 12px\)/u, 'short landscape view uses a viewport-aware dialog height');
assert.match(html, /presence-qr\.css\?v=0304\.1/u, 'presence modal styles are loaded');
assert.match(worker, /presence-qr\.css\?v=0304\.1/u, 'presence modal styles are available in the atomic offline shell');
assert.match(worker, /CACHE_PREFIX\}v138/u, 'shell cache was advanced for the new stylesheet and script');

console.log('Presence QR modal server contract, responsive structure, expiry and accessibility hooks: PASS');
