import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExtractionStore, locationKey, atomicCheckpoint } from '../src/extraction-bot-state.mjs';
import { ExtractionEngine } from '../src/extraction-bot-engine.mjs';

function fixture(t,{phase,locations=['A','B','C'],pages=99,total=2475}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hcr-extract-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const store=new ExtractionStore(dir); const state={version:1,status:'idle',maxPages:99,title:'Registered Nurse',folder:'hcrhub',automaticMatching:true,
    control:{pauseAfterBatch:false},locations:locations.map(name=>({id:name,name,state:'Example',query:name,status:'pending'})),batches:[],events:[],activeBatchId:null};
  if(phase) {state.batches=[{id:'existing',phase,listName:'Existing list',locationIds:['A'],pages,expectedTotal:total,searchUrl:'https://example.test/known',lastProgressAt:1}];state.activeBatchId='existing';state.locations[0].status='batched';}
  store.save(state);const calls=[];let proposed=[];
  const browser={
    restoreSearch:async b=>{calls.push(['restore',b.id]);proposed=[...b.locationIds];},
    addLocation:async l=>{proposed.push(l.id);return true;},
    removeLocation:async l=>{proposed=proposed.filter(id=>id!==l.id);},
    searchSize:async()=>({pages:proposed.length===1?70:proposed.length===2?99:100,total:proposed.length===2?2475:null}),
    searchUrl:async()=> 'https://example.test/search',
    ensureList:async name=>{calls.push(['list',name]);return 'https://example.test/list';},
    selectList:async name=>{calls.push(['select',name]);},
    startExtraction:async()=>{calls.push(['start']);},
    adopt:async()=>{},progress:async()=>({active:false,page:99,extracting:2475,saved:2475,atLastPage:true}),
    finalCounts:async()=>({saved:2475,emails:1000}),exportList:async()=>'/example/export.csv'
  };
  return {store,state,browser,calls,dir};
}

test('atomic checkpoint retries transient Windows locks without removing the old file',t=>{
  const f=fixture(t);const file=path.join(f.dir,'checkpoint.json');fs.writeFileSync(file,'old');let attempts=0;
  atomicCheckpoint(file,'new',{wait:()=>{},rename:(from,to)=>{
    assert.equal(fs.readFileSync(to,'utf8'),'old');
    if(++attempts<3)throw Object.assign(new Error('Locked'),{code:'EPERM'});
    fs.renameSync(from,to);
  }});
  assert.equal(attempts,3);assert.equal(fs.readFileSync(file,'utf8'),'new');
});

test('a persistent checkpoint lock preserves the previous checkpoint and bounds retries',t=>{
  const f=fixture(t);const file=path.join(f.dir,'checkpoint.json');fs.writeFileSync(file,'old');let attempts=0;
  assert.throws(()=>atomicCheckpoint(file,'new',{wait:()=>{},rename:()=>{attempts++;throw Object.assign(new Error('Locked'),{code:'EACCES'});}}),/Locked/);
  assert.equal(attempts,9);assert.equal(fs.readFileSync(file,'utf8'),'old');
  assert.equal(fs.readdirSync(f.dir).some(name=>name.endsWith('.tmp')),false);
});

test('packs locations up to 99 pages and removes overflow without consuming it',async t=>{
  const f=fixture(t);const e=new ExtractionEngine({...f});e.state=f.store.load();
  const b={id:'new',phase:'building',locationIds:[]};e.state.batches.push(b);
  await e.build(b);
  assert.deepEqual(b.locationIds,['A','B']);assert.equal(b.pages,99);assert.equal(e.state.locations[2].status,'pending');
});
test('oversized singleton is deferred, unavailable tag is recorded, and usable tags continue',async t=>{
  const f=fixture(t);let last;
  f.browser.addLocation=async l=>{last=l.id;return l.id!=='B';};
  f.browser.searchSize=async()=>({pages:last==='A'?100:80,total:null});
  const e=new ExtractionEngine({...f});e.state=f.store.load();const b={id:'new',phase:'building',locationIds:[]};
  await e.build(b);assert.deepEqual(b.locationIds,['C']);
  assert.deepEqual(e.state.locations.map(l=>l.status),['needs_split','tag_unavailable','batched']);
});
test('crash during geography probe rolls it back before restoring saved locations',async t=>{
  const f=fixture(t);const s=f.store.load();s.locations[0].status='probing';f.store.save(s);
  const e=new ExtractionEngine({...f});e.state=s;const b={id:'new',phase:'building',locationIds:[],probeId:'A'};
  await e.build(b);assert.deepEqual(b.locationIds,['A','B']);assert.equal(b.probeId,null);
});
test('resumes a started batch without creating another list or clicking extraction again',async t=>{
  const f=fixture(t,{phase:'starting',locations:['A']});
  const e=new ExtractionEngine({...f,sleep:async()=>{},matchExport:async()=> 'comparison-id'});
  await e.run();const s=f.store.load();assert.equal(s.batches[0].phase,'done');assert.equal(s.batches[0].matchJobId,'comparison-id');
  assert.equal(s.batches[0].coverage,'count_reconciled');assert.equal(f.calls.length,0);
});
test('search growth beyond 99 pages is checked again before clicking extract',async t=>{
  const f=fixture(t,{phase:'list_ready',locations:['A']});f.browser.searchSize=async()=>({pages:100,capped:true,total:null});
  const e=new ExtractionEngine({...f});await assert.rejects(e.run(),/page count changed/);
  assert.equal(f.calls.some(c=>c[0]==='start'),false);assert.equal(f.store.load().batches[0].phase,'list_ready');
});
test('short saved count is preserved as incomplete rather than full coverage',async t=>{
  const f=fixture(t,{phase:'extracting',locations:['A']});f.browser.finalCounts=async()=>({saved:2400,emails:100});
  const e=new ExtractionEngine({...f,sleep:async()=>{}});await e.run();
  const s=f.store.load();assert.equal(s.batches[0].coverage,'short_export');assert.equal(s.locations[0].status,'searched_short_export');
});
test('inactive extraction before last page pauses without exporting or restarting',async t=>{
  const f=fixture(t,{phase:'extracting',locations:['A']});let exported=false;
  f.browser.progress=async()=>({active:false,page:20,saved:475,extracting:500,atLastPage:false});
  f.browser.exportList=async()=>{exported=true;};
  const e=new ExtractionEngine({...f,sleep:async()=>{}});await assert.rejects(e.run(),/before the last page/);
  assert.equal(exported,false);assert.equal(f.store.load().status,'paused_for_review');assert.equal(f.calls.length,0);
});
test('stalled active extraction pauses and leaves browser job intact',async t=>{
  const f=fixture(t,{phase:'extracting',locations:['A']});let time=100;
  f.browser.progress=async()=>({active:true,page:2,saved:25,extracting:50});
  const e=new ExtractionEngine({...f,now:()=>time,sleep:async()=>{time+=1000;},stallMs:2000});
  await assert.rejects(e.run(),/stalled/);assert.equal(f.store.load().batches[0].phase,'extracting');assert.equal(f.calls.length,0);
});
test('a cycling final page is stopped after stable counts, exported and marked short',async t=>{
  const f=fixture(t,{phase:'extracting',locations:['A']});let time=100,active=true,stopped=0;
  f.browser.progress=async()=>({active,page:99,saved:2450,extracting:2450,atLastPage:true});
  f.browser.stopExtraction=async()=>{stopped++;active=false;};f.browser.finalCounts=async()=>({saved:2450,emails:1000});
  const e=new ExtractionEngine({...f,now:()=>time,sleep:async()=>{time+=1000;},lastPageStallMs:2000,stallMs:20000});await e.run();
  assert.equal(stopped,1);assert.equal(f.store.load().batches[0].coverage,'short_export');assert.equal(f.store.load().batches[0].phase,'done');
});
test('pause request waits until active batch is exported and matched',async t=>{
  const f=fixture(t,{phase:'extracting',locations:['A','B']});f.store.command('pause');
  const e=new ExtractionEngine({...f,sleep:async()=>{},matchExport:async()=> 'matched'});await e.run();
  const s=f.store.load();assert.equal(s.status,'paused');assert.equal(s.batches[0].phase,'done');assert.equal(s.locations[1].status,'pending');
});
test('worker lock rejects simultaneous owners and recovers dead PID',t=>{
  const f=fixture(t);const release=f.store.lock();assert.throws(()=>f.store.lock(),/already running/);release();
  fs.writeFileSync(path.join(f.store.directory,'worker.lock'),JSON.stringify({pid:2147483647}));
  f.store.lock()();assert.equal(fs.existsSync(path.join(f.store.directory,'worker.lock')),false);
});

test('next extraction starts while previous register comparison is still running',async t=>{
  const f=fixture(t,{phase:'matching',locations:['A','B']});
  const s=f.store.load();s.batches[0].exportPath='/old.csv';s.batches[0].coverage='count_reconciled';f.store.save(s);
  let release,completed=false,startedBeforeMatch=false;
  const pending=new Promise(resolve=>{release=resolve;});
  f.browser.searchSize=async()=>({pages:99,total:2475});
  f.browser.startExtraction=async()=>{startedBeforeMatch=!completed;release();};
  const e=new ExtractionEngine({...f,overlapMatching:true,sleep:async()=>{},matchExport:async(filename)=>{
    if(filename==='/old.csv') {await pending;completed=true;}
    return 'comparison';
  }});
  await e.run();
  assert.equal(startedBeforeMatch,true);
  assert.equal(f.store.load().batches.every(b=>b.phase==='done'),true);
});

test('background comparison completion preserves the newer active batch checkpoint',async t=>{
  const f=fixture(t,{phase:'extracting',locations:['A','B']});
  const s=f.store.load();s.locations[1].status='batched';
  s.batches.push({id:'old',phase:'matching',locationIds:['B'],exportPath:'/old.csv',coverage:'count_reconciled'});f.store.save(s);
  let release;const pending=new Promise(resolve=>{release=resolve;});let checks=0;
  f.browser.progress=async()=>{release();await pending;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.store.load().activeBatchId,'existing');checks++;
    return {active:false,page:99,saved:2475,extracting:2475,atLastPage:true};};
  await new ExtractionEngine({...f,overlapMatching:true,sleep:async()=>{},matchExport:async filename=>{if(filename==='/old.csv')await pending;return 'matched';}}).run();
  assert.equal(checks,2);assert.equal(f.store.load().batches.every(b=>b.phase==='done'),true);
});

test('failed background comparison is retained for recovery and pauses the worker',async t=>{
  const f=fixture(t,{phase:'matching',locations:['A']});
  const s=f.store.load();s.batches[0].exportPath='/retained.csv';f.store.save(s);
  await assert.rejects(new ExtractionEngine({...f,overlapMatching:true,matchExport:async()=>{throw new Error('comparison unavailable');}}).run(),/comparison unavailable/);
  const result=f.store.load();assert.equal(result.status,'paused_for_review');
  assert.equal(result.batches[0].phase,'matching');assert.equal(result.batches[0].exportPath,'/retained.csv');
});
test('initialization imports prior batches and adopts only known current batch once',t=>{
  const f=fixture(t);fs.unlinkSync(f.store.file);fs.mkdirSync(path.join(f.dir,'outputs/extraction-proof'),{recursive:true});
  fs.writeFileSync(path.join(f.dir,'outputs/extraction-proof/nsw-regional-02-batch.json'),JSON.stringify({locations:['Example'],destinationList:'Known list',displayedPages:80,searchUrl:'https://example.test/known'}));
  const s=f.store.initialize();assert.equal(s.batches[0].phase,'adopt');assert.equal(s.locations.find(l=>l.id===locationKey('Example, New South Wales, Australia')).status,'previously_searched');
  assert.equal(f.store.initialize().batches.length,1);
});
