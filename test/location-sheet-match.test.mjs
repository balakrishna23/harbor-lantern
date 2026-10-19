import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { linkedinProfileUrl, normalizeLocationProfile, readLocationFiles, matchLocationProfiles, isRegisteredRn } from '../src/location-sheet-match.mjs';
import { toCsv } from '../src/csv.mjs';

const source = { file: 'synthetic.csv', fileHash: 'fixture', sheet: 'CSV', row: 2 };
const profile = (first = 'Alex', last = 'Example') => normalizeLocationProfile({ first_name: first, last_name: last, url: `https://www.linkedin.com/in/${first || 'blank'}-${last || 'blank'}` }, source);

test('LinkedIn URL normalisation accepts opaque IDs and rejects unrelated or malformed URLs', () => {
  assert.equal(linkedinProfileUrl('https://au.linkedin.com/in/ACwABC123/?trk=abc'), 'https://www.linkedin.com/in/ACwABC123');
  for (const url of ['https://linkedin.com.evil.test/in/alex', 'http://linkedin.com/in/alex', 'https://evil.test', 'https://www.linkedin.com/sales/lead/123', 'https://www.linkedin.com/in/a%2Fb', 'https://user:pass@linkedin.com/in/alex']) assert.equal(linkedinProfileUrl(url), null);
});
test('numeric and incomplete names are held for input review', () => {
  assert.match(profile(442).issues.join(), /Invalid/);
  assert.match(profile('', '').issues.join(), /incomplete/);
});
test('RN eligibility uses the actual RN registration row, not generic Registered status', () => {
  const row = { registrationStatus: 'Registered', profession: 'Nurse', registrationType: 'Registered nurse (Division 1), General' };
  assert.equal(isRegisteredRn(row), true);
  for (const patch of [{ registrationType: 'Enrolled nurse (Division 2), General' }, { registrationType: 'Registered nurse (Division 1), Non Practising' }, { registrationType: 'Registered nurse (Division 1), Provisional' }, { registrationStatus: 'Unregistered' }]) assert.equal(isRegisteredRn({ ...row, ...patch }), false);
});
test('multiple files deduplicate canonical URLs, preserve rows, and expose conflicting names', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hcrhub-location-input-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = path.join(dir, 'ACT.csv'), second = path.join(dir, 'NSW.csv');
  const cols = ['first_name', 'last_name', 'url'];
  await fs.writeFile(first, toCsv([{ first_name: 'Alex', last_name: 'Example', url: 'https://au.linkedin.com/in/alex-example?trk=a' }], cols));
  await fs.writeFile(second, toCsv([{ first_name: 'Other', last_name: 'Example', url: 'https://www.linkedin.com/in/alex-example/' }], cols));
  const result = await readLocationFiles([first, second]);
  assert.equal(result.inputRows, 2); assert.equal(result.duplicateRows, 1);
  assert.equal(result.profiles[0].sources.length, 2);
  assert.match(result.profiles[0].issues.join(), /Conflicting names/);
  assert.equal(result.profiles[0].sources[1].row, 2);
});
test('matching preserves all same-name candidates and RN/EN rows from the chosen register snapshot', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE registrations (candidate_id INTEGER, source_row INTEGER, registration_number TEXT, source_record TEXT, import_id INTEGER)');
    const insert = db.prepare('INSERT INTO registrations VALUES (?, ?, ?, ?, ?)');
    function add(id, name, type, importId = 2, alternative = '') {
      insert.run(id, id + 1, `NMW${id}`, JSON.stringify({ 'Health practitioner': name, 'First name': name.split(' ')[0], 'Last name': name.split(' ').at(-1), 'Registration number': `NMW${id}`, 'Registration status': 'Registered', 'Registration Type ': type, Profession: 'Nurse', Qualifications: 'Bachelor of Nursing, University of Example, Australia, 2014', 'Alternative name': alternative }), importId);
    }
    add(1, 'Alex Morgan Example', 'Registered nurse (Division 1), General');
    add(1, 'Alex Morgan Example', 'Enrolled nurse (Division 2), General');
    add(2, 'Alex Jamie Example', 'Registered nurse (Division 1), General');
    add(3, 'Alex Old Example', 'Registered nurse (Division 1), General', 1);
    add(4, 'Alex Other Example', 'Enrolled nurse (Division 2), General');
    add(5, 'Mergu Bala Krishna', 'Registered nurse (Division 1), General');
    add(6, 'Mary Newname', 'Registered nurse (Division 1), General', 2, 'Mary Oldname');
    const profiles = [profile(), profile('Bala', 'Krishna'), profile('Mary', 'Oldname')];
    const result = matchLocationProfiles(db, profiles, 2);
    assert.equal(result.registerRows, 6);
    assert.equal(profiles[0].matchStatus, 'multiple_register_matches');
    assert.equal(profiles[0].candidates.length, 3);
    assert.equal(profiles[0].candidates[0].registrations.length, 2);
    assert.equal(profiles[0].candidates.some(c => c.candidateId === 3), false);
    assert.equal(profiles[0].candidates.find(c => c.candidateId === 4).eligible, false);
    assert.equal(profiles[1].candidates[0].fullName, 'Mergu Bala Krishna');
    assert.equal(profiles[2].candidates[0].candidateId, 6);
    const numbered = profile(); numbered.registrationNumber = 'NMW2';
    matchLocationProfiles(db, [numbered], 2);
    assert.deepEqual(numbered.candidates.map(c => c.candidateId), [2]);
  } finally { db.close(); }
});
