'use strict';
const assert=require('node:assert/strict');
const {createDriverAvailabilityService}=require('../backend/logistics/driver-availability');
(async()=>{
 const service=createDriverAvailabilityService({clock:()=>new Date('2026-10-22T00:00:00.000Z')});
 const future='2026-10-22T00:02:00.000Z';let statements=[];
 const client={query:async(sql,params)=>{statements.push({sql,params});if(sql.includes('SELECT coalesce(bool_or(permission_key=ANY($3::text[])),false) AS allowed'))return{rowCount:1,rows:[{allowed:true}]};if(sql.includes('SELECT d.record_id::text AS driver_id'))return{rowCount:1,rows:[{driver_id:'driver-a',driver_status:'ACTIVE',status:'online',revision:7,lease_expires_at:future,updated_at:'2026-10-22T00:00:00.000Z'}]};throw new Error('unexpected query')}};
 const managerDriver=await service.get(client,{company_id:'company-a',role_id:'role-a',driver_id:'driver-a',user_id:'manager-driver'});
 assert.equal(managerDriver.records.length,1,'a Driver identity with explicit fleet permission receives the authorized fleet projection');
 assert.equal(managerDriver.records[0].driverId,'driver-a');assert.equal(managerDriver.records[0].effectiveStatus,'online');
 assert.match(statements.find(entry=>entry.sql.includes('SELECT d.record_id::text AS driver_id'))?.sql||'',/WHERE d\.company_id=\$1/u,'roster read remains tenant-scoped');
 statements=[];
 const selfClient={query:async(sql)=>{statements.push(sql);if(sql.includes('SELECT coalesce(bool_or(permission_key=ANY($3::text[])),false) AS allowed'))return{rowCount:1,rows:[{allowed:false}]};if(sql.includes('SELECT d.payload'))return{rowCount:1,rows:[{driver_status:'ACTIVE'}]};if(sql.includes('SELECT status,revision'))return{rowCount:1,rows:[{status:'online',revision:2,lease_expires_at:future,updated_at:'2026-10-22T00:00:00.000Z'}]};throw new Error('unexpected query')}};
 const self=await service.get(selfClient,{company_id:'company-a',role_id:'role-driver',driver_id:'driver-a',user_id:'driver-a'});
 assert.equal(self.availability.effectiveStatus,'online');assert.equal(self.records,undefined,'Driver-only identity receives only its own availability');
 await assert.rejects(()=>service.get({query:async()=>{throw new Error('must not query')}},{company_id:'company-a',permissions:[]}),error=>error.code==='FORBIDDEN');
 console.log('driver availability authorization projection tests passed');
})().catch(error=>{console.error(error);process.exitCode=1});
