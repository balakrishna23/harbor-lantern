import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { LocationAgents } from '../src/location-agents.mjs';

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcrhub-location-jobs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const children = [];
  const agent = new LocationAgents({ root: path.resolve('.'), database: path.join(directory, 'register.sqlite'), spawnProcess: (...args) => {
    const c = new EventEmitter(); c.pid = 999999; c.connected = true; c.args = args;
    c.send = message => { c.message = message; }; c.kill = () => { c.killed = true; };
    children.push(c); return c;
  } });
  const payload = { realData: true, files: [{ filename: 'ACT synthetic.csv', fileBase64: Buffer.from('first_name,last_name,url\nAlex,Example,https://www.linkedin.com/in/alex-example').toString('base64') }] };
  return { directory, agent, children, payload };
}
test('dummy uploads cannot start workers and filenames are preserved in isolated storage', t => {
  const { agent, children, payload } = setup(t);
  assert.throws(() => agent.create({ ...payload, realData: false }), /real search/);
  assert.equal(children.length, 0);
  const job = agent.create(payload);
  assert.equal(job.status, 'matching');
  assert.match(agent.get(job.id).inputFiles[0], /ACT synthetic\.csv$/);
  assert.ok(children[0].args[1].includes('--real-data'));
  assert.throws(() => agent.create(payload), /Another agent/);
  children[0].emit('close', 0);
  assert.equal(agent.get(job.id).status, 'ready');
});
test('stopping matching kills only its worker and never the browser', t => {
  const { agent, children, payload } = setup(t);
  const job = agent.create(payload);
  assert.equal(agent.stop(job.id).status, 'stopping'); assert.equal(children[0].killed, true);
  children[0].emit('close', null);
  assert.equal(agent.get(job.id).status, 'stopped');
});
test('verification is a separate explicit action and stop is delivered over IPC', t => {
  const { agent, children, payload } = setup(t);
  const job = agent.create(payload); children[0].emit('close', 0);
  const directory = agent.directory(job.id); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ version: 1, dataKind: 'real_search_export', sources: [], profiles: [] }));
  fs.writeFileSync(path.join(directory, 'summary.json'), '{}');
  assert.throws(() => agent.startVerification(job.id, { limit: 0 }), /between 1 and 100/);
  assert.throws(() => agent.startVerification(job.id, { delayMs: 0 }), /delay between/);
  agent.startVerification(job.id, { limit: 3, delayMs: 8000 });
  assert.match(children[1].args[1][0], /run-school-verifier\.mjs$/);
  assert.ok(children[1].args[1].includes('--limit=3'));
  assert.ok(children[1].args[1].includes('--delay-ms=8000'));
  agent.stop(job.id); assert.deepEqual(children[1].message, { type: 'stop' });
  assert.equal(children[1].killed, undefined); children[1].emit('close', 0);
});
test('job IDs and allowed downloads prevent filesystem traversal', t => {
  const { agent, payload, children } = setup(t);
  assert.throws(() => agent.detail('../secret'), /Invalid job ID/);
  const job = agent.create(payload); children[0].emit('close', 0);
  assert.throws(() => agent.download(job.id, '../../.env'), /Unknown export/);
  assert.throws(() => agent.startVerification(job.id), /Complete matching/);
});
test('dashboard restart marks interrupted work and never resumes agents automatically', t => {
  const { agent, payload, directory } = setup(t);
  const job = agent.create(payload);
  let calls = 0;
  const restarted = new LocationAgents({ root: path.resolve('.'), database: path.join(directory, 'register.sqlite'), spawnProcess: () => { calls++; } });
  assert.equal(restarted.get(job.id).status, 'interrupted'); assert.equal(calls, 0);
});

test('continuous mode allows local comparison beside school verification but never two school readers',t=>{
  const {agent,children,payload}=setup(t);agent.allowConcurrentMatching=true;
  const first=agent.create(payload);children[0].emit('close',0);
  fs.mkdirSync(agent.directory(first.id),{recursive:true});
  fs.writeFileSync(path.join(agent.directory(first.id),'report.json'),JSON.stringify({version:1,dataKind:'real_search_export',sources:[],profiles:[]}));
  agent.startVerification(first.id,{limit:1});
  const second=agent.create(payload);
  assert.equal(agent.get(first.id).status,'verifying');assert.equal(second.status,'matching');
  assert.throws(()=>agent.startVerification(first.id,{limit:1}),/Another agent/);
  children[1].emit('close',0);children[2].emit('close',0);
});
