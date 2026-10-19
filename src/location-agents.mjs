import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { atomicCheckpoint } from './extraction-bot-state.mjs';

const ACTIVE = new Set(['matching', 'verifying', 'stopping']);
const DOWNLOADS = new Set(['results.csv', 'register-candidates.csv', 'confirmed.csv', 'review.csv']);
const validId = id => /^[a-f0-9-]{36}$/.test(String(id));
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Durable job metadata plus isolated child processes. Never runs on startup,
 * and never imports provider or production-database mutation modules. */
export class LocationAgents {
  constructor({ root, database, storage, output, maxUploadBytes = 25000000, spawnProcess = spawn, allowConcurrentMatching = false }) {
    this.root = path.resolve(root);
    this.database = path.resolve(database);
    this.storage = path.resolve(storage || path.join(path.dirname(this.database), 'location-agents'));
    this.output = path.resolve(output || path.join(path.dirname(this.database), 'location-agent-results'));
    this.maxUploadBytes = maxUploadBytes;
    this.spawnProcess = spawnProcess;
    this.allowConcurrentMatching = allowConcurrentMatching;
    this.children = new Map();
    fs.mkdirSync(this.storage, { recursive: true });
    for (const filename of fs.readdirSync(this.storage).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))) {
      const job = JSON.parse(fs.readFileSync(path.join(this.storage, filename), 'utf8'));
      if (ACTIVE.has(job.status) && !alive(job.pid)) {
        job.status = 'interrupted'; job.error = 'The dashboard stopped during this run. Resume school checks explicitly after checking browser and worker state.';
        this.save(job);
      }
    }
  }
  metaPath(id) { if (!validId(id)) throw new Error('Invalid job ID'); return path.join(this.storage, `${id}.json`); }
  directory(id) { this.metaPath(id); return path.join(this.output, id); }
  save(job) {
    job.updatedAt = new Date().toISOString();
    const destination = this.metaPath(job.id);
    atomicCheckpoint(destination, JSON.stringify(job, null, 2));
  }
  get(id) {
    const file = this.metaPath(id);
    if (!fs.existsSync(file)) throw new Error('Location matching job not found');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  report(id) {
    const filename = path.join(this.directory(id), 'report.json');
    return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
  }
  list() {
    return fs.readdirSync(this.storage).filter(f => /^[a-f0-9-]{36}\.json$/.test(f))
      .map(f => this.get(f.slice(0, -5))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(job => this.publicJob(job));
  }
  publicJob(job) {
    let summary = null;
    try { summary = JSON.parse(fs.readFileSync(path.join(this.directory(job.id), 'summary.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { id: job.id, name: job.name, status: job.status, phase: job.phase, createdAt: job.createdAt, updatedAt: job.updatedAt,
      filenames: job.filenames, error: job.error || '', summary, register: summary ? this.report(job.id)?.register : null };
  }
  create(payload) {
    if (payload.realData !== true) throw new Error('Confirm that these are real search exports. Dummy examples must not be matched.');
    if (!Array.isArray(payload.files) || !payload.files.length || payload.files.length > 50) throw new Error('Choose between 1 and 50 Excel or CSV files');
    if ((!this.allowConcurrentMatching && this.children.size) || this.list().some(j => ACTIVE.has(j.status) && (!this.allowConcurrentMatching || j.phase !== 'verifying'))) throw new Error('Another agent is running. Wait or stop it before starting a new run.');
    let total = 0;
    const files = payload.files.map((f, i) => {
      const filename = path.basename(String(f.filename || ''));
      if (!/\.(xlsx|csv)$/i.test(filename)) throw new Error('Location exports must be .xlsx or .csv');
      if (typeof f.fileBase64 !== 'string' || !f.fileBase64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.fileBase64)) throw new Error('Invalid file content');
      const bytes = Buffer.from(f.fileBase64, 'base64'); total += bytes.length;
      if (!bytes.length || total > this.maxUploadBytes) throw new Error(`Combined uploads must be 1–${this.maxUploadBytes} bytes`);
      return { filename, bytes, storedName: path.join(String(i + 1), filename) };
    });
    const id = crypto.randomUUID(), input = path.join(this.storage, id);
    fs.mkdirSync(input, { recursive: true });
    const filenames = files.map(f => { const stored = path.join(input, f.storedName); fs.mkdirSync(path.dirname(stored), { recursive: true }); fs.writeFileSync(stored, f.bytes); return f.filename; });
    const job = { id, name: String(payload.name || filenames.join(', ')).slice(0, 200), filenames,
      // The manifest restores original source filenames in reports after upload storage.
      inputFiles: files.map(f => path.join(input, f.storedName)), phase: 'matching', status: 'matching', createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(input, 'manifest.json'), JSON.stringify(files.map(f => ({ storedName: f.storedName, filename: f.filename }))));
    this.save(job);
    this.launch(job, 'scripts/compare-location-sheets.mjs', [...job.inputFiles, '--real-data', `--database=${this.database}`, `--out=${this.directory(id)}`]);
    return this.publicJob(job);
  }
  launch(job, script, args) {
    const logFile = path.join(this.storage, `${job.id}.log`);
    job.logStartOffset = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    const log = fs.openSync(path.join(this.storage, `${job.id}.log`), 'a');
    let child;
    try { child = this.spawnProcess(process.execPath, [path.join(this.root, script), ...args], { cwd: this.root, windowsHide: true, stdio: ['ignore', log, log, 'ipc'] }); }
    catch (error) { fs.closeSync(log); job.status = 'failed'; job.error = error.message; this.save(job); throw error; }
    fs.closeSync(log);
    this.children.set(job.id, child);
    job.pid = child.pid; this.save(job);
    let finished = false;
    const finish = (code, error) => {
      if (finished) return; finished = true;
      this.children.delete(job.id);
      const current = this.get(job.id);
      const stopped = current.status === 'stopping';
      const runLog = this.tailLog(job.id, job.logStartOffset);
      current.status = stopped ? 'stopped' : code === 0 ? 'ready' : code === 2 ? /three consecutive/.test(runLog) ? 'review_paused' : 'access_paused' : 'failed';
      current.error = error?.message || (code && !stopped ? runLog : '');
      // A child exit proves that this PID no longer owns an interrupted lock.
      const lock = path.join(this.directory(job.id), 'verifier.lock');
      if (fs.existsSync(lock)) {
        try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === child.pid) fs.unlinkSync(lock); } catch { /* retain unknown locks */ }
      }
      if (job.phase === 'matching' && code === 0) this.restoreSourceNames(current);
      this.save(current);
    };
    child.once('error', error => finish(1, error)); child.once('close', code => finish(code));
  }
  restoreSourceNames(job) {
    const report = this.report(job.id);
    if (!report) return;
    const names = new Map(job.inputFiles.map((file, i) => [file, job.filenames[i]]));
    // Keep immutable stored paths, add the original upload label for display and exports.
    for (const s of report.sources) s.originalFilename = names.get(s.file);
    for (const p of report.profiles) for (const s of p.sources) s.originalFilename = names.get(s.file);
    const file = path.join(this.directory(job.id), 'report.json');
    atomicCheckpoint(file, JSON.stringify(report, null, 2));
  }
  tailLog(id, startOffset = 0) {
    const filename = path.join(this.storage, `${id}.log`);
    if (!fs.existsSync(filename)) return 'Agent process failed';
    const log = fs.readFileSync(filename).subarray(startOffset).toString('utf8');
    const stopped = log.match(/^Stopped .+$/gm)?.at(-1);
    if (stopped) return stopped;
    const errors = [...log.matchAll(/^Error: (.+)$/gm)];
    return errors.at(-1)?.[1] || log.trim().slice(-500) || 'Agent process failed';
  }
  startVerification(id, { limit = 10, retryUnavailable = false, delayMs = 20000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Check between 1 and 100 profiles per run');
    if (!Number.isInteger(delayMs) || delayMs < 5000 || delayMs > 300000) throw new Error('Use a school-check delay between 5000 and 300000 milliseconds');
    if ((!this.allowConcurrentMatching && this.children.size) || this.list().some(j => ACTIVE.has(j.status) && (!this.allowConcurrentMatching || j.phase !== 'matching'))) throw new Error('Another agent is running. Wait or stop it first.');
    const job = this.get(id), report = this.report(id);
    if (ACTIVE.has(job.status)) throw new Error('This job is still running; wait before school verification');
    if (!report || report.dataKind !== 'real_search_export') throw new Error('Complete matching on real search exports before starting school checks');
    const stopFile = path.join(this.storage, `${id}.stop`);
    if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
    job.phase = 'verifying'; job.status = 'verifying'; job.error = ''; this.save(job);
    this.launch(job, 'scripts/run-school-verifier.mjs', [path.join(this.directory(id), 'report.json'), `--limit=${limit}`,
      `--database=${this.database}`, `--job-id=${id}`, `--stop-file=${stopFile}`, `--delay-ms=${delayMs}`, ...(retryUnavailable ? ['--retry-unavailable'] : [])]);
    return this.publicJob(job);
  }
  stop(id) {
    const child = this.children.get(id);
    if (!child) {
      const job = this.get(id);
      if (ACTIVE.has(job.status) && job.phase === 'verifying' && alive(job.pid)) {
        fs.writeFileSync(path.join(this.storage, `${id}.stop`), 'stop after current check');
        job.status = 'stopping'; this.save(job); return this.publicJob(job);
      }
      throw new Error('No running agent for this job');
    }
    const job = this.get(id); job.status = 'stopping'; this.save(job);
    if (job.phase === 'verifying' && child.connected) child.send({ type: 'stop' });
    else child.kill('SIGTERM');
    return this.publicJob(job);
  }
  detail(id, { offset = 0, limit = 50 } = {}) {
    const job = this.publicJob(this.get(id)), report = this.report(id);
    offset = Math.max(0, Number.isInteger(offset) ? offset : 0); limit = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50));
    const profiles = report?.profiles || [];
    return { job, total: profiles.length, offset, limit, profiles: profiles.slice(offset, offset + limit).map(p => ({
      id: p.id, fullName: p.fullName, url: p.url, location: p.location, title: p.title, employer: p.employer, issues: p.issues,
      matchStatus: p.matchStatus, verificationStatus: p.verification?.status || p.verificationStatus,
      reason: p.verification?.reason || '', checkedAt: p.verification?.checkedAt || '', evidence: p.verification?.evidence,
      databaseWrite: p.databaseWrite,
      candidates: p.candidates, checks: p.verification?.checks || [], sources: p.sources.map(s => ({ filename: s.originalFilename || path.basename(s.file), sheet: s.sheet, row: s.row }))
    })) };
  }
  download(id, filename) {
    this.get(id);
    if (!DOWNLOADS.has(filename)) throw new Error('Unknown export');
    return fs.readFileSync(path.join(this.directory(id), filename));
  }
}
