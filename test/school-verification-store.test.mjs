import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../src/migrations.mjs';
import { insertCandidateRows } from '../src/importer.mjs';
import { persistSchoolVerification } from '../src/school-verification-store.mjs';

function setup(t, type = 'Registered nurse (Division 1), General') {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON'); applyMigrations(db);
  const importId = Number(db.prepare("INSERT INTO imports(filename,file_hash) VALUES ('synthetic.csv','synthetic')").run().lastInsertRowid);
  insertCandidateRows(db, importId, [{ 'Health practitioner': 'Alex Example', 'First name': 'Alex', 'Last name': 'Example', 'Registration number': 'NMW-SYNTHETIC', Profession: 'Nurse', 'Registration status': 'Registered', 'Registration type': type, Qualifications: 'Bachelor of Nursing, Example University, Australia, 2014' }]);
  const row = db.prepare('SELECT * FROM candidates').get();
  const profile = { id: 'profile-1', fullName: 'Alex Example', url: 'https://www.linkedin.com/in/ACwSynthetic', issues: [], candidates: [{ candidateId: row.id, registrationNumber: row.ahpra_number, fullName: row.full_name, eligible: true, qualifications: row.qualifications }] };
  const evidence = { status: 'ok', sourceUrl: profile.url, finalUrl: 'https://www.linkedin.com/in/alex-example/details/education/', fullName: 'Alex Example', checkedAt: '2026-10-18T00:00:00Z', education: [{ school: 'Example University', endYear: 2014 }] };
  const args = { runId: 'synthetic-run', registerImportId: importId, profile, evidence };
  return { db, args, id: row.id };
}
test('clear school matches update candidates and evidence atomically, without duplicate history on resume', t => {
  const { db, args, id } = setup(t);
  assert.equal(persistSchoolVerification(db, args).databaseWrite.status, 'candidate_updated');
  const c = db.prepare('SELECT * FROM candidates WHERE id=?').get(id);
  assert.equal(c.identity_status, 'confirmed'); assert.equal(c.linkedin_url, 'https://www.linkedin.com/in/alex-example');
  assert.equal(c.contact_basis_approved, 0); assert.equal(c.campaign_status, 'not_ready');
  assert.equal(persistSchoolVerification(db, args).databaseWrite.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_history').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM school_verification_checks').get().n, 1);
});
test('unmatched school evidence is stored without changing identity fields', t => {
  const { db, args } = setup(t); args.evidence.education = [{ school: 'Another University' }];
  assert.equal(persistSchoolVerification(db, args).databaseWrite.status, 'evidence_saved');
  assert.notEqual(db.prepare('SELECT identity_status FROM candidates').get().identity_status, 'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM school_verification_checks').get().n, 1);
});
test('existing rejection, hard conflicts and different profile assignments require review', t => {
  const { db, args, id } = setup(t);
  db.prepare("UPDATE candidates SET linkedin_url='https://www.linkedin.com/in/someone-else' WHERE id=?").run(id);
  assert.equal(persistSchoolVerification(db, args).databaseWrite.status, 'review_required');
  db.prepare("UPDATE candidates SET linkedin_url=NULL, identity_status='rejected' WHERE id=?").run(id);
  args.evidence.checkedAt = '2026-10-18T01:00:00Z';
  assert.equal(persistSchoolVerification(db, args).databaseWrite.status, 'review_required');
  db.prepare("UPDATE candidates SET identity_status='manual_review', conflicting_evidence=? WHERE id=?").run('["outside australia"]', id);
  args.evidence.checkedAt = '2026-10-18T02:00:00Z';
  assert.equal(persistSchoolVerification(db, args).databaseWrite.status, 'review_required');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_history').get().n, 0);
});
test('registration eligibility is rechecked from source rows before candidate updates', t => {
  const { db, args } = setup(t, 'Enrolled nurse (Division 2), General');
  assert.equal(persistSchoolVerification(db, args).databaseWrite.status, 'review_required');
  assert.notEqual(db.prepare('SELECT identity_status FROM candidates').get().identity_status, 'confirmed');
});
test('database failures roll back the candidate and its audit history together', t => {
  const { db, args } = setup(t);
  db.exec("CREATE TRIGGER synthetic_write_failure BEFORE INSERT ON school_verification_checks BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END");
  assert.throws(() => persistSchoolVerification(db, args), /synthetic failure/);
  assert.notEqual(db.prepare('SELECT identity_status FROM candidates').get().identity_status, 'confirmed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_history').get().n, 0);
});
