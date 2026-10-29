'use strict';
const assert=require('node:assert/strict');
const {catalog,present}=require('../platform-permission-catalog');
const expected={
  'sync.pull':'Consultar alterações sincronizadas',
  'sync.push':'Enviar alterações para sincronização',
  'finance.read':'Consultar registros financeiros',
  'finance.manage':'Gerenciar registros financeiros'
};
for(const [key,label] of Object.entries(expected)){
  assert.equal(present(key).label,label,`${key} uses a clear Portuguese label`);
  assert.equal(present(key).known,true);
  assert(!/[A-Z]{2,}|\b(Read|Write|Manage|Submit|Tenant)\b/u.test(present(key).description),`${key} description is localized`);
}
assert.equal(Object.keys(catalog).length,10,'the current backend permission catalog is represented');
assert.deepEqual(present('permission.unknown'),{category:'Outras permissões',label:'Permissão adicional',description:'Esta permissão foi informada pelo servidor e não possui descrição em português no catálogo local.',known:false,key:'permission.unknown'});
assert.equal(present(null).label,'Permissão administrativa');
console.log('Super ADM permission presentation catalog: PASS');
