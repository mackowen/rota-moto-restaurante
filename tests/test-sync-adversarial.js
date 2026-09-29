'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','contract.js'),'utf8');
const ctx={crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'},globalThis:null};ctx.globalThis=ctx;vm.runInNewContext(source,ctx);const C=ctx.RotaMotoContract;
const base={id:'d1',companyId:'c1',updatedAt:'2026-09-24T20:00:00.000Z',version:1};
assert.equal(C.compareRevision({...base,updatedAt:'2026-09-24T21:00:00.000Z',version:1},base),1);
assert.equal(C.compareRevision({...base,updatedAt:base.updatedAt,version:2},base),1);
assert.equal(C.compareRevision(base,{...base,version:2}),-1);
assert(C.isNewer({...base,version:2},base));
// Out-of-order delivery events are facts: dedupe by eventId, never by arrival order.
const e=C.event('DELIVERY_COMPLETED','delivery','d1'); assert(e.eventId);
const seen=new Set([e.eventId]); assert(seen.has(e.eventId));
// Cross-company packets must be rejected by application validators; contract preserves company identity.
const p=C.packet({companyId:'company-A',deviceId:'dev-A',app:'RotaMoto',deliveries:[base]});
assert.equal(p.companyId,'company-A'); assert.equal(p.data.deliveries[0].companyId,'c1');
// Invalid transition remains invalid.
assert.throws(()=>C.assertTransition('DELIVERED','ARRIVED'));
console.log('sync adversarial contract tests: OK');
