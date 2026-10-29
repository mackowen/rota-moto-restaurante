'use strict';
(function exposePlatformAdminDisclosure(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.RotaMotoPlatformAdminDisclosure=api;
})(typeof globalThis==='object'?globalThis:this,function createPlatformAdminDisclosure(){
  let nextId=0;
  function create(button,panel,{beforeCollapse=async()=>true,onExpand=async()=>true,onError=()=>{},expandedLabel='',collapsedLabel=''}={}){
    if(!button||button.tagName!=='BUTTON'||!panel)throw new TypeError('A real button and its controlled panel are required.');
    if(!panel.id)panel.id=`rm-platform-disclosure-${++nextId}`;
    button.setAttribute('aria-controls',panel.id);
    button.setAttribute('aria-expanded','false');
    panel.hidden=true;
    const isExpanded=()=>button.getAttribute('aria-expanded')==='true';
    let transition=null;
    function setExpanded(value){
      panel.hidden=!value;
      button.setAttribute('aria-expanded',String(value));
      button.classList.toggle('is-expanded',value);
      if(expandedLabel&&collapsedLabel)button.textContent=value?expandedLabel:collapsedLabel;
    }
    async function runTransition(operation){
      if(transition)return transition;
      transition=operation().catch(error=>{onError(error);return false}).finally(()=>{transition=null});
      return transition;
    }
    function open(){
      return runTransition(async()=>{
        if(isExpanded())return true;
        if(await onExpand()===false)return false;
        setExpanded(true);return true;
      });
    }
    function close(){
      return runTransition(async()=>{
        if(!isExpanded())return true;
        if(await beforeCollapse()===false)return false;
        setExpanded(false);return true;
      });
    }
    button.addEventListener('click',()=>{(isExpanded()?close():open()).catch(()=>{});});
    return Object.freeze({open,close,isExpanded});
  }
  return Object.freeze({create});
});
