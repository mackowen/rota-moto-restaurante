'use strict';
const assert=require('node:assert/strict');
const {appendOperatorAudit}=require('../backend/runtime/operator-audit');
(async()=>{
  const previous={log:process.env.ROTAMOTO_OPERATOR_AUDIT_LOG,actor:process.env.ROTAMOTO_OPERATOR_ACTOR_REF};
  delete process.env.ROTAMOTO_OPERATOR_AUDIT_LOG;delete process.env.ROTAMOTO_OPERATOR_ACTOR_REF;
  try{await assert.rejects(()=>appendOperatorAudit('backup.create',{token:'do-not-print'}),error=>error.code==='OPERATOR_AUDIT_CONFIGURATION_REQUIRED'&&error.safeDiagnostic==='Configure identificador do operador e arquivo privado absoluto de auditoria'&&!error.message.includes('do-not-print'));}
  finally{if(previous.log===undefined)delete process.env.ROTAMOTO_OPERATOR_AUDIT_LOG;else process.env.ROTAMOTO_OPERATOR_AUDIT_LOG=previous.log;if(previous.actor===undefined)delete process.env.ROTAMOTO_OPERATOR_AUDIT_ACTOR_REF;else process.env.ROTAMOTO_OPERATOR_AUDIT_ACTOR_REF=previous.actor}
  process.stdout.write('PASS operator audit configuration fails closed with sanitized diagnostic\n');
})().catch(error=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1});
