'use strict';
const assert = require('node:assert/strict');
const T = require('../backend/analytics/territorial');

const now = Date.parse('2026-10-06T12:00:00.000Z');
const filters = T.normalizeFilters({ period:'30', metric:'volume' }, new Date(now));
const rows = Array.from({length:12},(_,i)=>({
  order:{id:`order-${i}`,createdAt:now-3600000,status:'FINALIZADA',sourceId:i%2?'manual':'ifood',type:'DELIVERY',deliveryFee:8,deliveryFeeCurrency:'BRL'},
  delivery:{id:`delivery-${i}`,status:'DELIVERED',driverId:i%2?'driver-a':null,assignedAt:now-7200000,completedAt:now-3600000,actualDistanceM:3200,estimatedDistanceM:4000},
  latitude:-23.5505+(i%4)*0.0002,longitude:-46.6333+(i%3)*0.0002,mode:i%2?'internal':'external',providerId:'provider-a',providerCode:'partner-a'
}));
const report=T.aggregate(rows,filters,now);
assert.equal(report.totalEligible,12); assert.equal(report.withLocation,12); assert.equal(report.coverage,1);
assert.equal(report.cells.length,1); assert.equal(report.cells[0].countBand,'10–24');
assert.ok(Math.abs(report.cells[0].averageActualDistanceKm-3.2)<1e-9); assert.equal(report.cells[0].averageEstimatedDistanceKm,4); assert.equal(report.cells[0].averageDurationMinutes,60);
assert.equal(report.cells[0].averageDeliveryFeeBRL,8); assert.equal(report.cells[0].internalFleet,6); assert.equal(report.cells[0].external,6);
assert.deepEqual(report.cells[0].providers,[{code:'partner-a',countBand:'10–24'}]);
assert.equal(JSON.stringify(report).includes('order-0'),false); assert.equal(JSON.stringify(report).includes('latitude'),true);
assert.equal(JSON.stringify(report).includes('address'),false); assert.equal(JSON.stringify(report).includes('customer'),false);

const belowThreshold=T.aggregate(rows.slice(0,4),filters,now);
assert.equal(belowThreshold.totalEligible,4); assert.equal(belowThreshold.withLocation,4); assert.equal(belowThreshold.cells.length,0);
assert.equal(belowThreshold.suppressedCells,1);
const sparseMetrics=T.aggregate(rows.map((row,i)=>({...row,delivery:{...row.delivery,actualDistanceM:i<4?3200:null,estimatedDistanceM:null},order:{...row.order,money:{}}})),filters,now);
assert.equal(sparseMetrics.cells[0].averageActualDistanceKm,null); assert.equal(sparseMetrics.cells[0].averageDeliveryFeeBRL,null);
const missing=T.aggregate([...rows.slice(0,6),{...rows[6],latitude:null,longitude:null}],filters,now);
assert.equal(missing.withoutLocation,1); assert.equal(missing.totalEligible,7);
assert.equal(T.aggregate(rows,{...filters,status:'CANCELLED'},now).totalEligible,0);
assert.equal(T.aggregate(rows,{...filters,mode:'internal'},now).totalEligible,6);
assert.equal(T.aggregate(rows,{...filters,providerId:'other'},now).totalEligible,0);
assert.equal(T.geohash(-23.5505,-46.6333),T.geohash(-23.5506,-46.6334));
const center=T.cellCenter(T.geohash(-23.55,-46.63));
assert.equal(T.geohash(center.latitude,center.longitude),T.geohash(-23.55,-46.63));
const dst=T.normalizeFilters({period:'7'},new Date('2026-03-10T12:00:00.000Z'),'America/New_York');
assert.equal(dst.start.toISOString(),'2026-03-04T05:00:00.000Z','territorial reporting starts at Company local midnight across DST');
const lowAccuracy=T.aggregate(rows.map(row=>({...row,accuracyM:2000})),filters,now);
assert.equal(lowAccuracy.withLocation,0); assert.equal(lowAccuracy.lowPrecision,12);
for(const coords of [[-91,0],[0,181],[Infinity,0]]) assert.throws(()=>T.geohash(...coords),{code:'INVALID_INPUT'});
for(const query of [{period:'366'},{status:'REDACTED'},{mode:'fleet'},{metric:'revenue'},{driverId:'x'},{source:'x\n'}]) assert.throws(()=>T.normalizeFilters(query,new Date(now)),{code:'INVALID_INPUT'});
assert.throws(()=>T.aggregate(Array(10001).fill(rows[0]),filters,now),{code:'INVALID_INPUT'});
console.log('Territorial analytics aggregation/privacy checks: OK');
