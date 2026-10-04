(() => {
  'use strict';
  const FORMAT='rotamoto-local-backup',VERSION=1;
  const SECRET_KEY=/(?:password|passwd|passphrase|token|secret|credential|authorization|csrf|cookie|session|private[_-]?key|api[_-]?key|client[_-]?secret|access[_-]?key|refresh[_-]?token)/iu;
  function scrub(value){
    if(Array.isArray(value))return value.map(scrub);
    if(typeof value==='string'&&value.startsWith('data:')){
      const match=/^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value),encoded=match?.[1]||'';
      const padding=encoded.endsWith('==')?2:encoded.endsWith('=')?1:0,decodedBytes=Math.floor(encoded.length*3/4)-padding;
      if(!match||decodedBytes>8388608)throw new Error('BACKUP_MEDIA_UNSUPPORTED_OR_TOO_LARGE');
      return value;
    }
    if(!value||typeof value!=='object')return value;
    const clean={};
    for(const [key,child]of Object.entries(value))if(!SECRET_KEY.test(key))clean[key]=scrub(child);
    return clean;
  }
  function create({app,stores,schemaVersion,exportedAt=new Date().toISOString()}){
    if(typeof app!=='string'||!app||!stores||typeof stores!=='object'||Array.isArray(stores))throw new Error('BACKUP_INVALID_SOURCE');
    const snapshot={};
    for(const [name,rows]of Object.entries(stores)){
      if(!Array.isArray(rows))throw new Error('BACKUP_INVALID_STORE');
      snapshot[name]=scrub(rows);
    }
    return{format:FORMAT,version:VERSION,app,exportedAt,databaseSchemaVersion:schemaVersion,contentProtection:'plaintext-sensitive',stores:snapshot};
  }
  function normalize(input,app,knownStores){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('BACKUP_INVALID');
    let stores;
    if(input.format===FORMAT){
      if(input.version!==VERSION||input.app!==app||!input.stores||typeof input.stores!=='object'||Array.isArray(input.stores))throw new Error('BACKUP_INCOMPATIBLE');
      stores=input.stores;
    }else if((input.schema==='rota-moto-restaurante-local'||input.app==='Rota Moto')&&Number.isInteger(input.version)){
      stores=app==='restaurante'?legacyRestaurant(input):legacyMoto(input);
    }else throw new Error('BACKUP_INCOMPATIBLE');
    for(const name of Object.keys(stores))if(!knownStores.includes(name))throw new Error('BACKUP_UNKNOWN_STORE');
    const clean={};
    for(const name of knownStores){
      const rows=stores[name]??[];
      if(!Array.isArray(rows))throw new Error('BACKUP_INVALID_STORE');
      clean[name]=scrub(rows);
      for(const row of clean[name])if(!row||typeof row!=='object'||Array.isArray(row)||!['string','number'].includes(typeof keyOf(name,row)))throw new Error('BACKUP_INVALID_RECORD');
    }
    return{format:FORMAT,version:VERSION,app,exportedAt:input.exportedAt||null,databaseSchemaVersion:input.databaseSchemaVersion||null,stores:clean};
  }
  function legacyRestaurant(x){const rows={};for(const name of ['companies','profiles','users','orders','bikes','routes','events','logs'])rows[name]=Array.isArray(x[name])?x[name]:[];rows.meta=x.settings?[{key:'settings',value:x.settings},...(x.user?.id?[{key:'currentUserId',value:x.user.id}]:[])]:[];return rows}
  function legacyMoto(x){return{races:x.races,meta:[{key:'settings',value:x.settings}]}}
  function keyOf(store,row){return store==='meta'?row.key:row.id}
  function mergePlan(current,backup,storeNames){
    const plan={},summary={added:0,kept:0,invalid:0};
    for(const name of storeNames){
      const existing=new Map((current[name]||[]).map(row=>[keyOf(name,row),row])),add=[];
      for(const row of backup.stores[name]||[]){
        const key=keyOf(name,row);
        if(key===undefined||key===null){summary.invalid++;continue}
        if(existing.has(key)){summary.kept++;continue}
        existing.set(key,row);add.push(row);summary.added++;
      }
      plan[name]=add;
    }
    return{plan,summary};
  }
  globalThis.RotaMotoBackupFormat=Object.freeze({FORMAT,VERSION,scrub,create,normalize,mergePlan});
})();
