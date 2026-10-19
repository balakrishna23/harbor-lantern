import { linkedinProfileUrl } from './location-sheet-match.mjs';
import { readModernLinkedinEducation } from './linkedin-education-dom.mjs';

export function accessProblem(url, text, httpStatus) {
  if (httpStatus === 429 || /too many requests|weekly invitation limit|commercial use limit|search limit|unusual activity|temporarily restricted|security verification|verify your identity/i.test(text)) return 'rate_limited';
  if (/\/checkpoint\//i.test(url)) return 'access_blocked';
  if (/\/(login|authwall|uas\/login)/i.test(url) || /sign in to (view|see).*profile|join linkedin to view/i.test(text)) return 'login_required';
  if (httpStatus === 404 || /this profile is not available|page not found|this page doesn.t exist/i.test(text)) return 'profile_unavailable';
  if (httpStatus >= 400) return 'access_blocked';
  return null;
}

/** Read the opened profile's Education section only; a school mentioned in
 * posts, suggestions or employment cannot corroborate a qualification. */
export async function readLinkedinSchool(page, profileUrl) {
  const checkedAt = new Date().toISOString();
  const sourceUrl = linkedinProfileUrl(profileUrl);
  if (!sourceUrl) return { status: 'invalid_url', checkedAt, sourceUrl: profileUrl };
  try {
    await page.bringToFront();
    const response = await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.locator('main h1, main h2').first().waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
    const body = await page.locator('body').innerText({ timeout: 5000 });
    const problem = accessProblem(page.url(), body, response?.status());
    if (problem) return { status: problem, checkedAt, sourceUrl, finalUrl: page.url(), reason: `LinkedIn returned ${problem}` };
    const title = await page.title();
    const titleName = /\|\s*LinkedIn\s*$/.test(title) ? title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn\s*$/, '').trim() : '';
    const fullName = titleName || (await page.locator('main h1, main h2').first().innerText({ timeout: 5000 }).catch(() => '')).trim();
    if (!fullName) return { status: 'education_unavailable', checkedAt, sourceUrl, finalUrl: page.url(), reason: 'No identifiable profile heading; the page may not have loaded' };
    const landedUrl = linkedinProfileUrl(page.url());
    if (!landedUrl) return { status: 'access_blocked', checkedAt, sourceUrl, finalUrl: page.url(), reason: 'Navigation did not land on a LinkedIn profile' };
    // Current LinkedIn profiles use h2 names and lazy-loaded div cards rather
    // than the older section/li markup. Scroll progressively so absence is not
    // inferred from a section that has simply not rendered yet.
    const heading = page.getByRole('heading', { name: 'Education', exact: true });
    const bounds = await page.locator('main').boundingBox();
    const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (bounds) await page.mouse.move(Math.max(20, Math.min(bounds.x + bounds.width * 0.4, size.width - 40)),
      Math.max(100, Math.min(bounds.y + 450, size.height - 100)));
    for (let step = 0; step < 8 && !await heading.count(); step++) {
      await page.mouse.wheel(0, 850);
      await heading.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
    }
    const modern = page.locator('[data-testid^="profile_EducationTopLevelSection_"]').first();
    if (await heading.count()) await heading.scrollIntoViewIfNeeded().catch(() => {});
    await modern.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await modern.count()) await modern.locator('[componentkey^="entity-collection-item-"]').first().waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    let modernEducation = await page.evaluate(readModernLinkedinEducation);
    const modernDetails = page.locator('main a[href*="/details/education/"]').first();
    if (modernEducation && await modernDetails.count()) {
      const next = new URL(await modernDetails.getAttribute('href'), page.url());
      // LinkedIn can replace an opaque /in/ACw... URL with the public slug
      // after the first heading renders. Validate against the current URL,
      // rather than the earlier pre-redirect address.
      const currentProfileUrl = linkedinProfileUrl(page.url());
      if (!currentProfileUrl || !next.href.startsWith(currentProfileUrl + '/details/education/')) return { status: 'read_error', checkedAt, sourceUrl, fullName, reason: 'Education detail link did not belong to the opened profile' };
      const detailResponse = await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('[data-testid^="profile_EducationDetailsSection_"] [componentkey^="entity-collection-item-"]').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const detailProblem = accessProblem(page.url(), await page.locator('body').innerText(), detailResponse?.status());
      if (detailProblem) return { status: detailProblem, checkedAt, sourceUrl, finalUrl: page.url(), fullName };
      modernEducation = await page.evaluate(readModernLinkedinEducation);
      if (!modernEducation) return { status: 'education_unavailable', checkedAt, sourceUrl, finalUrl: page.url(), fullName, reason: 'Complete education list could not be read' };
    }
    if (modernEducation) return { status: modernEducation.length ? 'ok' : 'education_unavailable', checkedAt, sourceUrl, finalUrl: page.url(), fullName,
      education: modernEducation, educationComplete: true, reason: modernEducation.length ? '' : 'No usable school names in the education section' };
    const section = page.locator('main section').filter({ has: page.locator('#education') }).first();
    let scope = section;
    if (!await section.count()) {
      scope = page.locator('main section').filter({ has: page.getByRole('heading', { name: 'Education', exact: true }) }).first();
    }
    if (!await scope.count()) return { status: 'education_unavailable', checkedAt, sourceUrl, finalUrl: page.url(), fullName, reason: 'Education section is hidden or absent' };
    await scope.scrollIntoViewIfNeeded();
    // Open the observed education-details link when LinkedIn offers more entries.
    const details = scope.locator('a[href*="/details/education/"]').first();
    if (await details.count()) {
      const href = await details.getAttribute('href');
      const next = new URL(href, page.url());
      if (next.origin === new URL(page.url()).origin && next.pathname.startsWith(new URL(page.url()).pathname.replace(/\/$/, '') + '/details/education')) {
        const detailResponse = await page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.locator('main li.artdeco-list__item').first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        const detailProblem = accessProblem(page.url(), await page.locator('body').innerText(), detailResponse?.status());
        if (detailProblem) return { status: detailProblem, checkedAt, sourceUrl, finalUrl: page.url(), fullName };
        scope = page.locator('main');
      }
    }
    const education = await scope.locator('li.artdeco-list__item').evaluateAll(items => items.map(item => {
      const schoolNode = item.querySelector('a[href*="/school/"] .t-bold [aria-hidden="true"]')
        || item.querySelector('.t-bold [aria-hidden="true"]') || item.querySelector('.t-bold') || item.querySelector('h3');
      const school = schoolNode?.textContent?.trim().replace(/\s+/g, ' ') || '';
      const snippet = item.innerText.trim();
      const dates = [...item.querySelectorAll('.t-black--light [aria-hidden="true"], time')].map(n => n.textContent).join(' ');
      const years = dates.match(/\b(?:19|20)\d{2}\b/g) || [];
      return { school, endYear: years.length ? Number(years.at(-1)) : null, snippet };
    }).filter(e => e.school));
    const unique = [...new Map(education.map(e => [`${e.school}|${e.endYear}`, e])).values()];
    return { status: unique.length ? 'ok' : 'education_unavailable', checkedAt, sourceUrl, finalUrl: page.url(), fullName, education: unique,
      reason: unique.length ? '' : 'Education markup did not expose any usable school names' };
  } catch (error) {
    return { status: 'read_error', checkedAt, sourceUrl, reason: String(error.message).slice(0, 350) };
  }
}
