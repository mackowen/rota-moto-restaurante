'use strict';
(function exposePlatformAdminRequest(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.RotaMotoPlatformAdminRequest=api;
})(typeof globalThis==='object'?globalThis:this,function createPlatformAdminRequestApi(){
  function create(request,{timeoutMs=20000}={}){
    if(typeof request!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new TypeError('A valid request function and timeout are required.');
    return function platformAdminRequest(path,requestState,options={}){
      const controller=new AbortController(),parentSignal=options.signal||requestState?.signal;
      let timedOut=false;
      const abortFromParent=()=>controller.abort();
      if(parentSignal?.aborted)controller.abort();
      else parentSignal?.addEventListener('abort',abortFromParent,{once:true});
      const timeout=setTimeout(()=>{timedOut=true;controller.abort()},timeoutMs);
      return Promise.resolve().then(()=>request(path,{...options,signal:controller.signal})).catch(error=>{
        if(timedOut)throw Object.assign(new Error('The administrative request exceeded its operational time limit.'),{code:'NETWORK_TIMEOUT'});
        throw error;
      }).finally(()=>{
        clearTimeout(timeout);
        parentSignal?.removeEventListener('abort',abortFromParent);
      });
    };
  }
  return Object.freeze({create});
});
