import test from 'node:test';
import assert from 'node:assert/strict';
import { schoolKey, registerSchools, verifySchoolEvidence } from '../src/school-verification.mjs';
import { accessProblem } from '../src/linkedin-school-reader.mjs';

const url = 'https://www.linkedin.com/in/alex-example';
const candidate = (id = 1, school = 'University of Example', year = 2014) => ({ candidateId: id, fullName: 'Alex Morgan Example', eligible: true, qualifications: `Bachelor of Nursing, ${school}, Australia, ${year}` });
const profile = candidates => ({ fullName: 'Alex Example', url, issues: [], candidates: candidates || [candidate()] });
const evidence = (education = [{ school: 'University of Example', endYear: 2014 }]) => ({ status: 'ok', sourceUrl: url, fullName: 'Alex Example', checkedAt: '2026-10-18T00:00:00Z', education });

test('school identity uses explicit aliases and exact names, never generic country text', () => {
  assert.equal(schoolKey('University of Western Sydney'), schoolKey('Western Sydney University'));
  assert.equal(schoolKey('Australia'), null); assert.equal(schoolKey('Unknown'), null);
  assert.notEqual(schoolKey('University of Example'), schoolKey('University of Example International'));
  assert.equal(registerSchools('Bachelor of Nursing, Overseas College of Nursing, Nepal, 2010')[0].school, 'Overseas College of Nursing');
});
test('one matching register name and school is auto-confirmed', () => {
  const result = verifySchoolEvidence(profile(), evidence());
  assert.equal(result.status, 'confirmed'); assert.equal(result.candidateId, 1);
  assert.equal(result.checks[0].pairs[0].register.year, 2014);
});
test('a shared school does not auto-confirm two same-name nurses', () => {
  assert.equal(verifySchoolEvidence(profile([candidate(1), candidate(2)]), evidence()).status, 'ambiguous_identity');
});
test('missing education on either side and an unknown competitor remain for review', () => {
  assert.equal(verifySchoolEvidence(profile(), evidence([])).status, 'education_unavailable');
  assert.equal(verifySchoolEvidence(profile([candidate(1, 'Unknown')]), evidence()).status, 'register_school_unavailable');
  assert.equal(verifySchoolEvidence(profile([candidate(), candidate(2, 'Unknown')]), evidence()).status, 'ambiguous_identity');
});
test('different visible schools are uncorroborated, not proof of a namesake', () => {
  assert.equal(verifySchoolEvidence(profile(), evidence([{ school: 'Another College of Nursing' }])).status, 'school_not_corroborated');
});
test('school evidence can select one of several possible register matches', () => {
  assert.equal(verifySchoolEvidence(profile([candidate(), candidate(2, 'Another College')]), evidence()).candidateId, 1);
});
test('explicit year or middle-name conflicts prevent confirmation', () => {
  assert.equal(verifySchoolEvidence(profile(), evidence([{ school: 'University of Example', endYear: 2001 }])).status, 'education_conflict');
  assert.equal(verifySchoolEvidence(profile(), { ...evidence(), fullName: 'Alex Jamie Example' }).status, 'education_conflict');
});
test('any corroborated qualification can match, including overseas qualifications and later study', () => {
  const c = candidate(); c.qualifications += ' • Diploma, Overseas Nursing College, Nepal, 2007';
  assert.equal(verifySchoolEvidence(profile([c]), evidence([{ school: 'Overseas Nursing College', endYear: 2007 }])).status, 'confirmed');
  assert.equal(verifySchoolEvidence(profile(), evidence([{ school: 'University of Example', endYear: 2000 }, { school: 'University of Example', endYear: 2014 }])).status, 'confirmed');
});
test('a different opened name, wrong URL, or input conflict never confirms', () => {
  assert.equal(verifySchoolEvidence(profile(), { ...evidence(), fullName: 'Other Person' }).status, 'identity_conflict');
  assert.equal(verifySchoolEvidence(profile(), { ...evidence(), sourceUrl: 'https://www.linkedin.com/in/other' }).status, 'identity_conflict');
  assert.equal(verifySchoolEvidence({ ...profile(), issues: ['Conflicting names'] }, evidence()).status, 'manual_review');
});
test('LinkedIn restriction signals stop checking instead of becoming missing-school decisions', () => {
  assert.equal(accessProblem(url, 'too many requests', 429), 'rate_limited');
  assert.equal(accessProblem('https://www.linkedin.com/authwall', '', 200), 'login_required');
  assert.equal(accessProblem('https://www.linkedin.com/checkpoint/challenge', '', 200), 'access_blocked');
  assert.equal(accessProblem(url, 'Profile', 200), null);
});
