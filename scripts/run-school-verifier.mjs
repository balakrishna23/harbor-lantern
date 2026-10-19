import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { applyMigrations } from '../src/migrations.mjs';
import { persistSchoolVerification } from '../src/school-verification-store.mjs';
import { verifySchoolEvidence } from '../src/school-verification.mjs';
import { readLinkedinSchool } from '../src/linkedin-school-reader.mjs';
import { writeLocationReport } from '../src/location-match-report.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: node scripts/run-school-verifier.mjs <report.json> [--limit=10] [--database=path --job-id=id] [--cdp=http://127.0.0.1:9222] [--delay-ms=20000] [--retry-unavailable]');
  process.exit(args.length ? 0 : 1);
}
for (const a of args.slice(1)) if (!/^--(limit|cdp|delay-ms|database|job-id|stop-file)=/.test(a) && a !== '--retry-unavailable') throw new Error(`Unknown option: ${a}`);
const option = key => args.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const limit = Number(option('limit') || 10), delay = Number(option('delay-ms') || 20000);
if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(delay) || delay < 5000) throw new Error('Use a positive integer --limit and --delay-ms of at least 5000');
const reportPath = path.resolve(args[0]);
const directory = path.dirname(reportPath);
const lockPath = path.join(directory, 'verifier.lock');
const lock = await fs.open(lockPath, 'wx').catch(error => { throw new Error(`Cannot acquire verifier lock (${error.code}). Check whether a verifier is running before removing ${lockPath}`); });
let browser, page, candidateDb, stopping = false;
const stopFile = option('stop-file') && path.resolve(option('stop-file'));
const stopRequested = () => stopping || Boolean(stopFile && existsSync(stopFile));
const stop = () => { stopping = true; };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// If the dashboard disappears, finish the current check rather than continuing
// an unmonitored LinkedIn run in an orphan worker.
if (process.send) process.on('disconnect', stop);
process.on('message', message => { if (message?.type === 'stop') stop(); });
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  if (report.version !== 1) throw new Error('Unsupported comparison report version');
  if (report.dataKind !== 'real_search_export') throw new Error('School verification is disabled for format examples and dummy data');
  if (option('database')) {
    if (!option('job-id')) throw new Error('--job-id is required for database updates');
    candidateDb = new DatabaseSync(path.resolve(option('database')));
    candidateDb.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    applyMigrations(candidateDb);
  }
  const applyDecision = (profile, evidence) => {
    if (candidateDb) {
      const result = persistSchoolVerification(candidateDb, { runId: option('job-id'), registerImportId: report.register.id, profile, evidence });
      profile.verification = result.verification; profile.databaseWrite = result.databaseWrite;
    } else profile.verification = verifySchoolEvidence(profile, evidence);
  };
  const journalPath = path.join(directory, 'school-evidence.jsonl');
  // Replay persisted decisions if interrupted between evidence append and report save.
  const journal = await fs.readFile(journalPath, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  const committed = journal.slice(0, journal.lastIndexOf('\n') + 1);
  if (committed.length < journal.length) await fs.truncate(journalPath, Buffer.byteLength(committed));
  const byId = new Map(report.profiles.map(p => [p.id, p]));
  for (const line of committed.split('\n').filter(Boolean)) {
    const event = JSON.parse(line), p = byId.get(event.profileId);
    if (p && p.url === event.sourceUrl && JSON.stringify(p.verification?.evidence)!==JSON.stringify(event.evidence)) applyDecision(p, event.evidence);
  }
  // Re-score saved evidence when matching rules improve; no profile is revisited.
  // Confirmed results are never re-decided here.
  let rescored = 0;
  for (const p of report.profiles) {
    if (!p.verification?.evidence || p.verification.status === 'confirmed') continue;
    if (verifySchoolEvidence(p, p.verification.evidence).status === p.verification.status) continue;
    applyDecision(p, p.verification.evidence); rescored++;
  }
  if (rescored) { await writeLocationReport(report, directory); console.log(`Re-scored ${rescored} saved results with current matching rules.`); }
  const retryable = new Set(['education_unavailable', 'read_error', 'login_required', 'access_blocked', 'rate_limited']);
  const queue = report.profiles.filter(p => p.verificationStatus === 'pending_school_check'
    && (!p.verification || args.includes('--retry-unavailable') && retryable.has(p.verification.status)))
    .sort((a,b)=>a.candidates.filter(c=>c.eligible).length-b.candidates.filter(c=>c.eligible).length).slice(0, limit);
  if (!queue.length) { console.log('No pending school checks.'); await writeLocationReport(report, directory); }
  else {
    try { browser = await chromium.connectOverCDP(option('cdp') || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222', { timeout: 10000 }); }
    catch { throw new Error('No browser is reachable over CDP. Open Brave with remote debugging and sign in to LinkedIn, then rerun. No profiles were checked.'); }
    const context = browser.contexts()[0];
    if (!context) throw new Error('No browser session found');
    page = await context.newPage();
    let consecutiveUnavailable = 0;
    for (const [index, profile] of queue.entries()) {
      if (stopRequested()) break;
      if (index) await new Promise(resolve => {
        let poll;
        const finish = () => { clearTimeout(timer); clearInterval(poll); resolve(); };
        const timer = setTimeout(finish, delay + Math.floor(Math.random() * 5000));
        poll = setInterval(() => { if (stopRequested()) finish(); }, 250);
      });
      if (stopRequested()) break;
      const evidence = await readLinkedinSchool(page, profile.url);
      const event = { profileId: profile.id, sourceUrl: profile.url, evidence };
      const handle = await fs.open(journalPath, 'a');
      try { await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync(); } finally { await handle.close(); }
      applyDecision(profile, evidence);
      await writeLocationReport(report, directory);
      console.log(`${index + 1}/${queue.length}: ${profile.verification.status} (${profile.id})`);
      consecutiveUnavailable = evidence.status === 'education_unavailable' || evidence.status === 'read_error' ? consecutiveUnavailable + 1 : 0;
      if (consecutiveUnavailable >= 3) {
        console.log('Stopped after three consecutive unreadable education sections; check extraction before continuing.');
        process.exitCode = 2; break;
      }
      if (['rate_limited', 'login_required', 'access_blocked'].includes(evidence.status)) {
        console.log('Stopped on a LinkedIn access restriction. No automatic retries.');
        process.exitCode = 2; break;
      }
    }
    console.log(JSON.stringify(report.summary.verificationCounts));
  }
} finally {
  if (candidateDb) candidateDb.close();
  if (page) await page.close().catch(() => {});
  // Detach the CDP connection without closing the user's browser.
  // Process exit detaches CDP. Never send a close command to the user's Brave.
  await lock.close(); await fs.unlink(lockPath);
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  process.removeListener('disconnect', stop);
  if (process.connected) process.disconnect();
}
process.exit(process.exitCode || 0);
