'use strict';
const assert=require('node:assert/strict');
const {create}=require('../platform-admin-disclosure');
class FakeClassList{constructor(){this.values=new Set()}toggle(name,on){if(on)this.values.add(name);else this.values.delete(name)}}
class FakeElement{
  constructor(tagName){this.tagName=tagName;this.attrs=new Map();this.listeners={};this.classList=new FakeClassList();this.hidden=false;this.textContent=''}
  setAttribute(key,value){this.attrs.set(key,String(value))}
  getAttribute(key){return this.attrs.get(key)||null}
  addEventListener(type,fn){this.listeners[type]=fn}
  click(){this.listeners.click?.()}
}
async function main(){
  const button=new FakeElement('BUTTON'),panel=new FakeElement('DIV');let expands=0,allowClose=false,errors=[];
  const disclosure=create(button,panel,{collapsedLabel:'Ver permissões',expandedLabel:'Recolher permissões',onExpand:async()=>{expands++;await Promise.resolve();return true},beforeCollapse:async()=>allowClose,onError:error=>errors.push(error)});
  assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(panel.hidden,true);
  assert.equal(button.getAttribute('aria-controls'),panel.id);assert.ok(panel.id);
  const first=disclosure.open(),racing=disclosure.open();assert.notStrictEqual(first,undefined);assert.notStrictEqual(racing,undefined);
  assert.deepEqual(await Promise.all([first,racing]),[true,true]);assert.equal(expands,1,'parallel open actions share a single in-flight transition');assert.equal(panel.hidden,false);assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(button.textContent,'Recolher permissões');
  assert.equal(await disclosure.close(),false,'dirty state may prevent closing');assert.equal(disclosure.isExpanded(),true);
  allowClose=true;assert.equal(await disclosure.close(),true);assert.equal(panel.hidden,true);assert.equal(button.getAttribute('aria-expanded'),'false');
  button.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(disclosure.isExpanded(),true,'the real button click opens its panel');
  assert.deepEqual(errors,[]);
  console.log('Super ADM disclosure accessibility, collapse guard and duplicate-click contract: PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1});
