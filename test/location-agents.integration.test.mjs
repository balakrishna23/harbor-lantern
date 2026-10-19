import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { toCsv } from '../src/csv.mjs';

test('dashboard upload and background matching work with isolated synthetic fixtures and no browser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcrhub-location-e2e-'));
  const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: path.resolve('.'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATABASE_PATH: path.join(dir, 'test.sqlite') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const call = async (route, body) => {
    const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json(); return { response, payload };
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode != null) throw new Error(stderr);
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 40));
    }
    assert.ok(ready, 'Temporary dashboard started');
    const raw = { 'Health practitioner': 'Alex Morgan Example', 'First name': 'Alex', 'Last name': 'Example', Profession: 'Nurse', 'Registration number': 'NMW-SYNTHETIC-1', 'Registration status': 'Registered', 'Registration type': 'Registered nurse (Division 1), General', Qualifications: 'Bachelor of Nursing, University of Example, Australia, 2014' };
    const imported = await call('/api/import', { filename: 'Public Register Extract - Synthetic.csv', csvText: toCsv([raw], Object.keys(raw)) });
    assert.equal(imported.response.status, 201);
    const csv = 'first_name,last_name,url,city\nAlex,Example,https://www.linkedin.com/in/synthetic-example,Canberra Australia';
    const files = [{ filename: 'Synthetic ACT.csv', fileBase64: Buffer.from(csv).toString('base64') }];
    const rejected = await call('/api/location-agents', { files, realData: false });
    assert.equal(rejected.response.status, 400);
    const created = await call('/api/location-agents', { files, realData: true, name: 'Automated synthetic fixture only' });
    assert.equal(created.response.status, 202);
    const id = created.payload.id;
    let detail;
    for (let i = 0; i < 100; i++) {
      detail = (await call(`/api/location-agents/${id}`)).payload;
      if (!['matching', 'stopping'].includes(detail.job.status)) break;
      await new Promise(r => setTimeout(r, 60));
    }
    assert.equal(detail.job.status, 'ready', detail.job.error);
    assert.equal(detail.job.summary.uniqueProfiles, 1);
    assert.equal(detail.profiles[0].verificationStatus, 'pending_school_check');
    assert.equal(detail.profiles[0].candidates[0].eligible, true);
    assert.equal(detail.profiles[0].sources[0].filename, 'Synthetic ACT.csv');
    assert.equal((await call(`/api/location-agents/${id}/verify`, { limit: 101 })).response.status, 400);
    const download = await fetch(`${base}/api/location-agents/${id}/export?file=results.csv`);
    assert.equal(download.status, 200); assert.match(await download.text(), /pending_school_check/);
    assert.equal((await call(`/api/location-agents/${id}/export?file=..%2F.env`)).response.status, 400);
    const crossOrigin = await fetch(base + '/api/location-agents', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.example' }, body: JSON.stringify({ files, realData: true }) });
    assert.equal(crossOrigin.status, 400);
    const page = await (await fetch(base)).text(); assert.match(page, /Location matching agents/); assert.match(page, /location-agents.js/);
    const list = (await call('/api/location-agents')).payload.jobs;
    assert.equal(list.length, 1); assert.equal(list[0].phase, 'matching');
    const bot = await call('/api/extraction-bot');
    assert.equal(bot.response.status,200); assert.equal(bot.payload.maxPages,99); assert.equal(bot.payload.workerAlive,false);
    assert.equal((await fetch(base+'/extraction-bot.html')).status,200);
    const botOrigin = await fetch(base+'/api/extraction-bot/start',{method:'POST',headers:{'content-type':'application/json',origin:'https://unrelated.example'},body:'{}'});
    assert.equal(botOrigin.status,400);
    assert.equal((await call('/api/extraction-bot/pause',{})).payload.status,'paused');
  } finally {
    if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    const absolute = path.resolve(dir);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
