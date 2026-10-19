import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

test('school verifier replays committed synthetic evidence and repairs a torn journal without opening a browser', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hcrhub-school-resume-'));
  t.after(async () => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); });
  const url = 'https://www.linkedin.com/in/synthetic-example';
  const profile = { id: 'synthetic-id', fullName: 'Alex Example', url, title: 'Registered Nurse', location: 'Canberra', issues: [], sources: [{ file: 'synthetic.csv', sheet: 'CSV', row: 2 }], matchStatus: 'possible_register_match', verificationStatus: 'pending_school_check',
    candidates: [{ candidateId: 1, registrationNumber: 'NMW-SYNTHETIC', fullName: 'Alex Example', eligible: true, qualifications: 'Bachelor of Nursing, University of Example, Australia, 2014', registrations: [{ registrationType: 'Registered nurse (Division 1), General', registrationStatus: 'Registered', sourceRow: 2 }] }] };
  const report = { version: 1, dataKind: 'real_search_export', register: { filename: 'Synthetic test extract' }, summary: {}, profiles: [profile] };
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report));
  const event = { profileId: profile.id, sourceUrl: url, evidence: { status: 'ok', fullName: profile.fullName, sourceUrl: url, education: [{ school: 'University of Example', endYear: 2014 }] } };
  const committed = JSON.stringify(event) + '\n';
  await fs.writeFile(path.join(dir, 'school-evidence.jsonl'), committed + '{"partial":');
  const { stdout } = await promisify(execFile)(process.execPath, ['scripts/run-school-verifier.mjs', path.join(dir, 'report.json'), '--cdp=http://127.0.0.1:1'], { cwd: path.resolve('.'), timeout: 10000 });
  assert.match(stdout, /No pending school checks/);
  const result = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
  assert.equal(result.profiles[0].verification.status, 'confirmed');
  assert.equal(await fs.readFile(path.join(dir, 'school-evidence.jsonl'), 'utf8'), committed);
  await assert.rejects(fs.stat(path.join(dir, 'verifier.lock')), { code: 'ENOENT' });
});
