import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {persistentBrowserDownload} from '../src/persistent-browser-download.mjs';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'durable-download-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const session=new EventEmitter(),calls=[];session.send=async(name,args)=>{calls.push({name,args});};session.detach=async()=>{};
  const page={context:()=>({newCDPSession:async()=>({send:async()=>({frameTree:{frame:{id:'list-frame'}}}),detach:async()=>{}})})};
  return {directory,output:path.join(directory,'batch.csv'),session,calls,page,browser:{newBrowserCDPSession:async()=>session}};
}

test('downloads persist independently of temporary worker paths and ignore other frames',async t=>{
  const f=await fixture(t),guid='11111111-1111-4111-8111-111111111111';
  await persistentBrowserDownload({...f,click:async()=>{
    f.session.emit('Browser.downloadWillBegin',{frameId:'other-frame',guid:'22222222-2222-4222-8222-222222222222'});
    f.session.emit('Browser.downloadProgress',{guid:'22222222-2222-4222-8222-222222222222',state:'completed'});
    await fs.writeFile(path.join(f.directory,guid),'name,url\nSynthetic,https://example.test');
    f.session.emit('Browser.downloadWillBegin',{frameId:'list-frame',guid});
    f.session.emit('Browser.downloadProgress',{guid,state:'completed'});
  }});
  assert.match(await fs.readFile(f.output,'utf8'),/Synthetic/);
  assert.equal(f.calls[0].args.downloadPath,f.directory);
  assert.equal(f.calls.at(-1).args.behavior,'default');
  assert.equal(f.session.listenerCount('Browser.downloadWillBegin'),0);
});

test('canceled downloads leave existing output untouched and restore browser defaults',async t=>{
  const f=await fixture(t),guid='11111111-1111-4111-8111-111111111111';await fs.writeFile(f.output,'previous');
  await assert.rejects(persistentBrowserDownload({...f,click:async()=>{
    f.session.emit('Browser.downloadWillBegin',{frameId:'list-frame',guid});
    f.session.emit('Browser.downloadProgress',{guid,state:'canceled'});
  }}),/canceled/);
  assert.equal(await fs.readFile(f.output,'utf8'),'previous');assert.equal(f.calls.at(-1).args.behavior,'default');
});
