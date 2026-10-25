'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');

const css=fs.readFileSync('orders-v2.css','utf8');
assert.match(css,/@container orders-v2-page \(min-width:680px\)/u,
  'the two-panel workspace is selected from the available page container width');
assert.match(css,/grid-template-columns:minmax\(340px,1fr\) minmax\(280px,min\(45%,640px\)\)/u,
  'both panels retain usable minimum widths while sharing desktop space');
assert.match(css,/@container orders-v2-page \(max-width:679px\)/u,
  'the operational-center shortcut is reserved for stacked layouts');
assert.match(css,/grid-template-columns:minmax\(0,1fr\) minmax\(100px,auto\)/u,
  'the search row reserves room for the Filters control');
assert.match(css,/\.orders-advanced-filters>summary\{[^}]*min-width:100px[^}]*white-space:nowrap/u,
  'the Filters label is not compressed or wrapped');
assert.doesNotMatch(css,/@container orders-v2-page \(min-width:920px\)/u,
  'the previous desktop-only threshold is removed');
assert.doesNotMatch(css,/\.orders-v2-operations\{[^}]*max-height:[^}]*\}/u,
  'the operational panel has no viewport-bound height');
assert.doesNotMatch(css,/\.orders-v2-operations\{[^}]*overflow-y?\s*:\s*(?:auto|scroll)/u,
  'the operational panel does not create an internal scroll area');
console.log('Orders V2 responsive layout contract: PASS');
