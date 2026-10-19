import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {SchoolBot,schoolQueueSnapshot} from '../src/school-bot.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'school-bot-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const storage=path.join(root,'jobs'),directory=path.join(root,'bot');fs.mkdirSync(storage);fs.mkdirSync(directory);
  const id='11111111-1111-4111-8111-111111111111';const reportDir=path.join(root,id);fs.mkdirSync(reportDir);
  const job={id,name:'Real matched run',status:'ready',phase:'matching',createdAt:'2026-10-19T00:00:00Z'};
  const summary={verificationCounts:{pending_school_check:2,confirmed:1,not_queued:4},databaseCounts:{candidate_updated:1}};
  fs.writeFileSync(path.join(storage,id+'.json'),JSON.stringify(job));
  fs.writeFileSync(path.join(reportDir,'summary.json'),JSON.stringify(summary));
  const agents={storage,directory:()=>reportDir,get:()=>({...job}),children:new Map(),report:()=>({dataKind:'real_search_export',profiles:[{verificationStatus:'pending_school_check'}]})};
  return {root,storage,directory,id,job,summary,reportDir,agents};
}

test('school queue counts evidence separately from unchecked or ineligible profiles',t=>{
  const f=fixture(t);const result=schoolQueueSnapshot(f.agents);
  assert.equal(result.next.id,f.id);assert.deepEqual(result.counts,{pending:2,checked:1,confirmed:1,databaseUpdated:1});
});

test('school supervisor checkpoints completed work before honoring a pause',async t=>{
  const f=fixture(t);let launches=0;
  f.agents.startVerification=(id,{limit,delayMs})=>{
    assert.equal(limit,10);assert.equal(delayMs,8000);launches++;f.job.status='verifying';f.job.phase='verifying';
    const child=new EventEmitter();f.agents.children.set(id,child);
    queueMicrotask(()=>{
      f.job.status='ready';f.summary.verificationCounts={pending_school_check:0,confirmed:3,not_queued:4};
      fs.writeFileSync(path.join(f.reportDir,'summary.json'),JSON.stringify(f.summary));
      fs.writeFileSync(path.join(f.directory,'pause'),'pause');child.emit('close',0);
    });
  };
  await new SchoolBot({agents:f.agents,directory:f.directory}).run();
  const state=JSON.parse(fs.readFileSync(path.join(f.directory,'state.json')));
  assert.equal(launches,1);assert.equal(state.status,'paused');assert.equal(state.counts.confirmed,3);assert.equal(state.activeJobId,null);
});

test('school supervisor pauses on an access restriction without launching another chunk',async t=>{
  const f=fixture(t);let launches=0;
  f.agents.startVerification=id=>{
    launches++;const child=new EventEmitter();f.agents.children.set(id,child);
    queueMicrotask(()=>{f.job.status='access_paused';f.job.error='LinkedIn sign-in required';child.emit('close',2);});
  };
  await assert.rejects(new SchoolBot({agents:f.agents,directory:f.directory}).run(),/sign-in required/);
  const state=JSON.parse(fs.readFileSync(path.join(f.directory,'state.json')));
  assert.equal(launches,1);assert.equal(state.status,'paused_for_review');
});

test('an already running school reader is left alone',async t=>{
  const f=fixture(t);f.job.status='verifying';f.job.phase='verifying';let launches=0;
  f.agents.startVerification=()=>{launches++;};
  await new SchoolBot({agents:f.agents,directory:f.directory,sleep:async()=>{fs.writeFileSync(path.join(f.directory,'pause'),'pause');}}).run();
  assert.equal(launches,0);
});

test('a dashboard stop pauses continuous verification instead of restarting another chunk',async t=>{
  const f=fixture(t);let launches=0;
  f.agents.startVerification=id=>{
    launches++;const child=new EventEmitter();f.agents.children.set(id,child);
    queueMicrotask(()=>{f.job.status='stopped';child.emit('close',0);});
  };
  await new SchoolBot({agents:f.agents,directory:f.directory}).run();
  assert.equal(launches,1);assert.equal(JSON.parse(fs.readFileSync(path.join(f.directory,'state.json'))).status,'paused');
});
