import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPersonName, personNamesMatch, firstNamesEquivalent } from '../src/name-variants.mjs';
import { schoolKeys, schoolMatch, verifySchoolEvidence } from '../src/school-verification.mjs';

test('display-name credentials, pronouns and civic titles are removed, surnames that look like degrees are kept', () => {
  assert.equal(cleanPersonName('Oluwaseun Ogunleye rn acipm mba msc'), 'oluwaseun ogunleye');
  assert.equal(cleanPersonName('Obinna AKINOLA, MSc (Critical Care)'), 'obinna akinola');
  assert.equal(cleanPersonName('Cr allison Wintour'), 'allison wintour');
  assert.equal(cleanPersonName('Jane Smith (she/her)'), 'jane smith');
  assert.equal(cleanPersonName('Kim Ma'), 'kim ma');
  assert.equal(cleanPersonName('Mr Nabil Usman'), 'nabil usman');
});
test('a surname inside an unclosed export bracket still matches either way round', () => {
  assert.ok(personNamesMatch('Miss Elvira Marie Castillo Reyes', 'Elvira (elle Reyes'));
  assert.ok(personNamesMatch('Miss Grace Kamau', 'Grace Dawson (kamau'));
  assert.ok(personNamesMatch('Mrs Grace Dawson', 'Grace Dawson (kamau'));
  assert.ok(personNamesMatch('Mr Obinna Akinola', 'Obinna AKINOLA, MSc (Critical Care)'));
});
test('nicknames match their formal name but two different formal names never match', () => {
  assert.ok(personNamesMatch('Miss Jessica Anne Norwood', 'Jess Norwood'));
  assert.ok(personNamesMatch('Mr Anthony Bramwell', 'Tony Bramwell'));
  assert.ok(firstNamesEquivalent('kate', 'katie'));
  assert.equal(personNamesMatch('Ms Katherine Smith', 'Kathleen Smith'), false);
  assert.equal(personNamesMatch('Ms Jessica Smith', 'Jess Jones'), false);
  assert.equal(personNamesMatch('Ms Alison Mercer', 'Alison M'), false);
  assert.equal(personNamesMatch('Mrs Arshdeep Kaur Tarnowski', 'Arshdeep Kaur'), false);
});
test('school variants absorb brackets, campuses, dates, The, St and trailing country', () => {
  const same = (a, b) => schoolMatch(schoolKeys(a), schoolKeys(b));
  assert.equal(same('University of New England (AU)', 'University of New England'), 'variant');
  assert.equal(same('Australian Catholic University', 'Australian Catholic University-St Patricks-Fitzroy'), 'variant');
  assert.equal(same('Australian Catholic University – Canberra Feb 2018 – Dec 2020', 'Australian Catholic University'), 'variant');
  assert.equal(same('The University of Notre Dame Australia', 'University of Notre Dame'), 'variant');
  assert.equal(same('St George Hospital - Sydney', 'SAINT GEORGE HOSPITAL'), 'variant');
  assert.equal(same('Bradford School of Nursing', 'BRADFORD SCHOOL OF NURSING (ENGLAND)'), 'variant');
  assert.equal(same('Australian Centre of further Eduaction', 'Australian Centre of Further Education'), 'typo');
});
test('school variants never collapse distinct institutions', () => {
  const same = (a, b) => schoolMatch(schoolKeys(a), schoolKeys(b));
  assert.equal(same('University of Example International', 'University of Example'), null);
  assert.equal(same('University of New South Wales', 'University of South Wales'), null);
  assert.equal(same('Western Sydney University', 'Eastern Sydney University'), null);
  assert.equal(same('College of Nursing Australia', 'College of Nursing India'), null);
  assert.equal(same('University of South Australia', 'University of South Africa'), null);
  assert.equal(same('University of the East Ramon Magsaysay Memorial Medical Center', 'University of the East'), null);
});
test('a nickname and a school variant together confirm one registered nurse', () => {
  const url = 'https://www.linkedin.com/in/jess-example';
  const profile = { fullName: 'Jess Example RN', url, issues: [], candidates: [{ candidateId: 7, fullName: 'Miss Jessica Example', eligible: true, qualifications: 'Bachelor of Nursing, University of New England, Australia, 2019' }] };
  const evidence = { status: 'ok', sourceUrl: url, fullName: 'Jess Example', education: [{ school: 'University of New England (AU)', endYear: 2019 }] };
  const result = verifySchoolEvidence(profile, evidence);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.checks[0].pairs[0].match, 'variant');
});
