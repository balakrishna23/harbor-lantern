import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readLocationFiles, matchLocationProfiles } from '../src/location-sheet-match.mjs';
import { writeLocationReport } from '../src/location-match-report.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('Usage: node scripts/compare-location-sheets.mjs <one.xlsx> [two.xlsx ...] --real-data [--database=path] [--register-import=2] [--out=directory]');
  process.exit(args.length ? 0 : 1);
}
const option = key => args.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3);
for (const arg of args.filter(a => a.startsWith('--'))) if (!/^--(database|register-import|out)=/.test(arg) && arg !== '--real-data') throw new Error(`Unknown option: ${arg}`);
if (!args.includes('--real-data')) throw new Error('Matching is disabled for format examples. Supply --real-data only for genuine search exports.');
const files = args.filter(a => !a.startsWith('--'));
if (!files.length) throw new Error('Supply at least one location spreadsheet');
const database = path.resolve(option('database') || 'data/hcrhub.sqlite');
const out = path.resolve(option('out') || `exports/location-matches/${new Date().toISOString().replace(/[:.]/g, '-')}`);
// Each comparison is immutable input for a verifier. Do not overwrite earlier work.
if (fs.existsSync(path.join(out, 'report.json'))) throw new Error('Output already contains a report. Choose a new --out directory.');
const input = await readLocationFiles(files);
const db = new DatabaseSync(database, { readOnly: true });
try {
  const register = option('register-import') ? db.prepare('SELECT id, filename, file_hash, total_rows FROM imports WHERE id=?').get(Number(option('register-import')))
    : db.prepare("SELECT id, filename, file_hash, total_rows FROM imports WHERE filename LIKE '%Public Register Extract%' ORDER BY id DESC LIMIT 1").get();
  if (!register) throw new Error('No national register import found. Specify --register-import explicitly.');
  console.log(`Comparing ${input.profiles.length} unique profiles against ${register.filename} (import ${register.id})...`);
  const match = matchLocationProfiles(db, input.profiles, register.id);
  if (match.registerRows !== register.total_rows) throw new Error(`Register import is incomplete: ${match.registerRows} preserved rows versus ${register.total_rows} imported rows`);
  const report = { version: 1, dataKind: 'real_search_export', createdAt: new Date().toISOString(), register, eligibility: 'Registered status + Nurse profession + Division 1 General registration in the selected extract; not a live registration check',
    sources: input.sources, summary: { inputRows: input.inputRows, uniqueProfiles: input.profiles.length, duplicateRows: input.duplicateRows, registerRows: match.registerRows, matchCounts: match.counts }, profiles: input.profiles };
  console.log(JSON.stringify(await writeLocationReport(report, out), null, 2));
  console.log(`Results: ${out}`);
} finally { db.close(); }
