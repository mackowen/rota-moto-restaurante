'use strict';
(function exposePlatformPermissionCatalog(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.RotaMotoPlatformPermissionCatalog=api;
})(typeof globalThis==='object'?globalThis:this,function createPlatformPermissionCatalog(){
  const catalog=Object.freeze({
    'company.manage':{category:'Empresa',label:'Gerenciar empresa',description:'Alterar os dados e o estado operacional da empresa.'},
    'members.invite':{category:'Equipe',label:'Convidar pessoas',description:'Enviar convites para integrar pessoas à empresa.'},
    'members.read':{category:'Equipe',label:'Consultar equipe',description:'Consultar as pessoas e os perfis da empresa.'},
    'orders.read':{category:'Pedidos',label:'Consultar pedidos',description:'Consultar pedidos da empresa.'},
    'orders.manage':{category:'Pedidos',label:'Gerenciar pedidos',description:'Executar ações permitidas sobre pedidos da empresa.'},
    'integrations.manage':{category:'Integrações',label:'Gerenciar integrações',description:'Configurar as integrações da empresa.'},
    'sync.pull':{category:'Sincronização',label:'Consultar alterações sincronizadas',description:'Receber alterações empresariais autorizadas pelo serviço de sincronização.'},
    'sync.push':{category:'Sincronização',label:'Enviar alterações para sincronização',description:'Enviar alterações empresariais autorizadas ao serviço de sincronização.'},
    'finance.read':{category:'Financeiro',label:'Consultar registros financeiros',description:'Consultar registros financeiros canônicos da empresa.'},
    'finance.manage':{category:'Financeiro',label:'Gerenciar registros financeiros',description:'Registrar e reconciliar eventos financeiros da empresa.'}
  });
  function present(key){
    if(typeof key!=='string'||!key.trim())return{category:'Outras permissões',label:'Permissão administrativa',description:'Permissão informada pelo servidor; sua descrição em português ainda não está disponível.',known:false,key:''};
    const technicalKey=key.trim(),entry=catalog[technicalKey];
    return entry?{...entry,known:true,key:technicalKey}:{category:'Outras permissões',label:'Permissão adicional',description:'Esta permissão foi informada pelo servidor e não possui descrição em português no catálogo local.',known:false,key:technicalKey};
  }
  return Object.freeze({catalog,present});
});
