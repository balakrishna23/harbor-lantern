// Re-run register matching for existing comparison jobs after name-matching rules
// improve. Profiles that already have school evidence are left exactly as they are.
// Holds each job's verifier.lock, so it can never overlap a school check on that job.
// Usage: node scripts/rematch-location-jobs.mjs [job-id ...] [--apply]
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { matchLocationProfiles } from '../src/location-sheet-match.mjs';
import { writeLocationReport } from '../src/location-match-report.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2), apply = args.includes('--apply');
const resultsDir = path.join(root, 'data/location-agent-results'), jobsDir = path.join(root, 'data/location-agents');
const ids = args.filter(a => !a.startsWith('--'));
const jobs = (ids.length ? ids : fs.readdirSync(resultsDir)).map(id => ({ id, dir: path.join(resultsDir, id),
  meta: JSON.parse(fs.readFileSync(path.join(jobsDir, `${id}.json`), 'utf8')) }));
const idle = jobs.filter(j => {
  const ok = ['ready', 'stopped'].includes(j.meta.status) && fs.existsSync(path.join(j.dir, 'report.json'));
  if (!ok) console.log(`Skipping ${j.meta.name}: status ${j.meta.status}`);
  return ok;
});
const locks = [];
try {
  for (const j of idle) {
    if (apply) locks.push({ fd: fs.openSync(path.join(j.dir, 'verifier.lock'), 'wx'), file: path.join(j.dir, 'verifier.lock') });
    j.report = JSON.parse(fs.readFileSync(path.join(j.dir, 'report.json'), 'utf8'));
    if (apply) fs.writeSync(locks.at(-1).fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), purpose: 'rematch' }));
  }
  const importIds = new Set(idle.map(j => j.report.register.id));
  if (importIds.size > 1) throw new Error('Jobs use different register imports; rematch them separately');
  const db = new DatabaseSync(path.join(root, 'data/hcrhub.sqlite'), { readOnly: true });
  const pending = idle.flatMap(j => j.report.profiles.filter(p => !p.verification).map(p => ({ job: j, original: p, copy: structuredClone(p) })));
  console.log(`Re-matching ${pending.length} profiles without school evidence across ${idle.length} jobs...`);
  const match = matchLocationProfiles(db, pending.map(x => x.copy), [...importIds][0]);
  db.close();
  if (match.registerRows !== idle[0].report.register.total_rows) throw new Error(`Register import incomplete: ${match.registerRows} rows`);
  for (const j of idle) {
    const mine = pending.filter(x => x.job === j);
    const before = { ...j.report.summary.matchCounts }, moved = {};
    for (const { original, copy } of mine) {
      if (original.matchStatus !== copy.matchStatus) moved[`${original.matchStatus} -> ${copy.matchStatus}`] = (moved[`${original.matchStatus} -> ${copy.matchStatus}`] || 0) + 1;
      Object.assign(original, { candidates: copy.candidates, matchStatus: copy.matchStatus, verificationStatus: copy.verificationStatus });
    }
    j.report.summary.matchCounts = Object.fromEntries([...new Set(j.report.profiles.map(p => p.matchStatus))]
      .map(s => [s, j.report.profiles.filter(p => p.matchStatus === s).length]));
    console.log(`\n${j.meta.name}\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(j.report.summary.matchCounts)}\n  moves  ${JSON.stringify(moved)}`);
    if (apply) {
      j.report.rematchedAt = new Date().toISOString();
      await writeLocationReport(j.report, j.dir);
    }
  }
  console.log(apply ? '\nApplied.' : '\nDry run only; pass --apply to save.');
} finally {
  for (const l of locks) { fs.closeSync(l.fd); fs.rmSync(l.file, { force: true }); }
}
