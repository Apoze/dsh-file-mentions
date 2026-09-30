import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../lib/client.js', import.meta.url),'utf8');
test('DSH 0.2 list slot checks the paths from turn data and skips empty turns',async()=>{
  const requests=[];
  let plugin,render;
  const react={useState:()=>[null,()=>{}],useEffect:fn=>fn()};
  vm.runInNewContext(source,{
    window:{__ModuleLoader__:{load:({factory})=>{plugin=factory(()=>react)}}},
    fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{json:async()=>({valid:[]})}},
  });
  const slots={inject:(name,fn)=>{if(name==='conversation.chat.turnTail')fn()},register:(entry,component)=>{render=component}};
  plugin.apply({get:name=>name==='slots'?slots:undefined,effect:()=>{}});
  render({sessionId:'test-session',turn:{data:new Map()},openFile:()=>{}});
  render({sessionId:'test-session',turn:{data:new Map([['mentionedPaths',{paths:[]}]])},openFile:()=>{}});
  assert.equal(requests.length,0);
  render({sessionId:'test-session',turn:{data:new Map([['mentionedPaths',{paths:['validation-020/dummy.pdf']} ]])},openFile:()=>{}});
  assert.equal(requests.length,1);
  assert.deepEqual(requests[0].body,{sessionId:'test-session',paths:['validation-020/dummy.pdf']});
});
