(() => {
  'use strict';
  const VERSION=5;
  const stores=[['meta','key'],['companies','id'],['orders','id'],['deliveries','id'],['bikes','id'],['routes','id'],['events','id'],['deliveryEvents','id'],['locations','id'],['proofs','id'],['earnings','id'],['outbox','id'],['inbox','id'],['tombstones','id'],['syncState','id'],['logs','id'],['profiles','id'],['users','id']];
  const migrations={
    1:({db})=>{for(const[name,keyPath]of stores)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath})},
    2:()=>{}, // Versão histórica: sem transformação de dados.
    3:()=>{}, // Versão histórica: sem alteração estrutural documentada.
    4:()=>{}, // Versão histórica: stores de sync introduzidas sem reescrever registros.
    5:({transaction})=>{
      const specs={
        companies:[['byUpdatedAt','updatedAt']],orders:[['byCompanyId','companyId'],['byUpdatedAt','updatedAt'],['bySyncState','sync.state'],['byCanonicalId','sync.canonicalId']],
        deliveries:[['byCompanyId','companyId'],['byUpdatedAt','updatedAt'],['bySyncState','sync.state'],['byCanonicalId','sync.canonicalId']],
        bikes:[['byCompanyId','companyId'],['byUpdatedAt','updatedAt']],routes:[['byCompanyId','companyId'],['byUpdatedAt','updatedAt']],
        events:[['byCompanyId','companyId'],['byCreatedAt','createdAt']],deliveryEvents:[['byDeliveryId','deliveryId'],['byEventId','eventId'],['byCreatedAt','createdAt']],
        locations:[['byDeliveryId','deliveryId'],['byCreatedAt','createdAt']],proofs:[['byDeliveryId','deliveryId'],['byCreatedAt','createdAt']],
        earnings:[['byDeliveryId','deliveryId'],['byCreatedAt','createdAt']],outbox:[['bySyncState','status'],['byCreatedAt','createdAt']],
        inbox:[['byCreatedAt','receivedAt']],tombstones:[['byStore','store'],['byUpdatedAt','updatedAt']],syncState:[['byUpdatedAt','updatedAt']],
        logs:[['byCreatedAt','createdAt']],profiles:[['byCompanyId','companyId']],users:[['byCompanyId','companyId']]
      };
      for(const[name,indexes]of Object.entries(specs)){
        if(!transaction.objectStoreNames.contains(name))throw new Error(`Store IndexedDB ausente durante migration: ${name}`);
        const store=transaction.objectStore(name);
        for(const[indexName,keyPath]of indexes)if(!store.indexNames.contains(indexName))store.createIndex(indexName,keyPath,{unique:false});
      }
    }
  };
  function upgrade(db,transaction,oldVersion,newVersion){
    if(!Number.isInteger(oldVersion)||!Number.isInteger(newVersion)||oldVersion<0||newVersion!==VERSION||oldVersion>=newVersion)throw new Error('Versão de migration IndexedDB inválida.');
    // Repair only missing stores; keep unknown stores and all existing records.
    for(const[name,keyPath]of stores)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath});
    for(let version=oldVersion+1;version<=newVersion;version++){const migrate=migrations[version];if(typeof migrate!=='function')throw new Error(`Migration IndexedDB ${version} não encontrada.`);migrate({db,transaction})}
    transaction.objectStore('meta').put({key:'storageSchemaVersion',value:newVersion});
  }
  window.RotaMotoStorageSchema=Object.freeze({version:VERSION,stores:Object.freeze(stores.map(([name])=>name)),upgrade});
})();
