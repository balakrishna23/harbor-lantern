import test from 'node:test';
import assert from 'node:assert/strict';
import { readModernLinkedinEducation } from '../src/linkedin-education-dom.mjs';

function rootFor(entries) {
  return { querySelector(selector) {
    assert.equal(selector, '[data-testid^="profile_EducationTopLevelSection_"]');
    return { children: entries.map(paragraphs => ({ innerText: paragraphs.join('\n\n'), querySelectorAll: tag => { assert.equal(tag, 'p'); return paragraphs.map(innerText => ({ innerText })); } })) };
  } };
}
test('modern education cards read school names and completion years, not years in course descriptions', () => {
  const result = readModernLinkedinEducation(rootFor([
    ['Example University', 'Bachelor, Registered Nursing', 'Feb 2024 – Dec 2025'],
    ['Another College', 'Course about 1990 healthcare', '2023 – Present']
  ]));
  assert.equal(result[0].school, 'Example University'); assert.equal(result[0].endYear, 2025);
  assert.equal(result[1].endYear, null);
});
test('absent education cards stay unavailable and undated postgraduate study has no invented year', () => {
  assert.equal(readModernLinkedinEducation({ querySelector: () => null }), null);
  assert.equal(readModernLinkedinEducation(rootFor([['Example University', 'Masters of Nursing']]))[0].endYear, null);
});
test('the education detail view reads older qualifications beyond the two preview cards', () => {
  const items = rootFor([['Example University', 'Bachelor of Nursing', '2014 – 2016']]).querySelector('[data-testid^="profile_EducationTopLevelSection_"]').children;
  const root = { querySelector: selector => selector.includes('TopLevel') ? null : { querySelectorAll: () => items } };
  const result = readModernLinkedinEducation(root);
  assert.equal(result.length, 1); assert.equal(result[0].endYear, 2016);
});
