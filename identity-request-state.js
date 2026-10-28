'use strict';
(function exposeIdentityRequestState(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.RotaMotoIdentityRequestState=api;
})(typeof globalThis==='object'?globalThis:this,function createIdentityRequestStateApi(){
  function createLatestRequestState(){
    let generation=0,active=null;
    return Object.freeze({
      begin(){
        active?.controller.abort();
        const controller=new AbortController(),id=++generation;
        active={controller,id};
        return Object.freeze({id,signal:controller.signal,isCurrent:()=>active?.id===id&&!controller.signal.aborted});
      },
      cancel(){generation++;active?.controller.abort();active=null;},
    });
  }
  return Object.freeze({createLatestRequestState});
});
