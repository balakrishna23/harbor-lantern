/** Serializable DOM reader for LinkedIn's visible Education section.
 * No profile state, requests, or internal React data are read. */
export function readModernLinkedinEducation(root = document) {
  const top = root.querySelector('[data-testid^="profile_EducationTopLevelSection_"]');
  const section = top || root.querySelector('[data-testid^="profile_EducationDetailsSection_"]');
  if (!section) return null;
  const items = top ? [...section.children] : [...section.querySelectorAll('[componentkey^="entity-collection-item-"]')];
  const education = items.map(item => {
    const paragraphs = [...item.querySelectorAll('p')].map(p => p.innerText.trim());
    const date = paragraphs.find(value => /^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+)?(?:19|20)\d{2}(?:\s*[–-]\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+)?(?:(?:19|20)\d{2}|Present))?$/.test(value));
    const years = date?.match(/\b(?:19|20)\d{2}\b/g) || [];
    return { school: paragraphs[0] || '', endYear: date && !/Present/.test(date) && years.length ? Number(years.at(-1)) : null, snippet: item.innerText.trim() };
  }).filter(e => e.school);
  return [...new Map(education.map(e => [`${e.school}|${e.endYear}`, e])).values()];
}
