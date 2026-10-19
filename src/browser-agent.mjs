/**
 * Sales Navigator browser agent.
 *
 * Attaches over the Chrome DevTools Protocol to a Brave window you already
 * have open and logged into LinkedIn (see scripts/launch-brave-debug.mjs) and
 * drives Sales Navigator's people search from there, instead of scraping
 * headlessly or logging in as a bot. This module is split into two halves:
 *
 *  - Browser I/O (connect/search/extract) — needs a live CDP endpoint and a
 *    real Sales Navigator session, cannot be unit tested.
 *  - Lead normalization + the auto-confirm decision (normalizeBrowserLead,
 *    recordBrowserLead, applyBrowserLeadDecision) — pure DB/scoring logic,
 *    fully unit testable against an injected db, mirroring the pattern in
 *    src/pipeline-orchestrator.mjs.
 *
 * KNOWN RISK: Sales Navigator's markup is dynamic and changes over time.
 * The selectors below are a best-effort first pass and will likely need a
 * live calibration pass (watch it run once, adjust selectors) before
 * extraction is reliable. They deliberately favor accessible roles/text
 * content over brittle generated class names, and every extraction step is
 * wrapped so a single failed selector degrades to a partial lead rather than
 * crashing the batch.
 */
import { scoreIdentityMatch, namesMatch, comparable } from "./domain.mjs";
import { primaryAustralianQualification } from "./qualification-parser.mjs";
import { recordVerifiedProfileLocation } from "./au-location.mjs";

const clean = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
const NURSING_TITLE_PATTERN = /nurs|midwife/i;

// Only people currently working in healthcare are attached to a candidate
// (user requirement, 2026-10-13: "I don't want recruiters or anything").
// Judged on the profile's current title + employer, not on education — a
// nursing degree says someone trained as a nurse, not that they still work
// in healthcare. The exclusion list wins over the inclusion list, so
// "Recruitment Consultant - Health" or "Software Engineer, Health Tech" are
// rejected even though they mention health.
const HEALTHCARE_PATTERN = /nurs|midwi|\b(rn|en|cnc|cne|cns|num|np)\b|clinic|health|hospital|aged care|age care|patient|ward\b|theatre|perioperative|intensive care|\bicu\b|emergency department|paediatric|pediatric|mental health|disability|carer|care (worker|coordinator|manager|assistant)|medical|medicine|doctor|physician|\bgp\b|surgeon|surgical|anaesthe|anesthe|pharmac|physio|paramedic|ambulance|dental|dentist|radiograph|sonograph|occupational therap|speech patholog|dietitian|psycholog|immunis|vaccin|oncology|cardiac|cardio|maternity|neonatal|palliative|rehab|infection (control|prevention)|wound|dialysis|renal|community care|residential care|healthcare/i;
const NON_HEALTHCARE_PATTERN = /recruit|talent|staffing|sales|business development|marketing|account (manager|executive)|real estate|software|developer|data (analyst|scientist|engineer)|insurance|financ|accountant|lawyer|solicitor|consultant,? (it|technology)|engineer/i;

export function isHealthcareRole(title, employer = "") {
  const text = `${title || ""} ${employer || ""}`;
  return HEALTHCARE_PATTERN.test(text) && !NON_HEALTHCARE_PATTERN.test(text);
}

// Positive Australian-location check for a Sales Navigator card/profile
// location string. Must name Australia or an Australian state/major city,
// and must not name another country (so "Victoria, British Columbia, Canada"
// and "Perth, Scotland" don't pass, and a bare "Greater Philadelphia" with no
// country doesn't pass either).
const AU_LOCATION_PATTERN = /australia|new south wales|victoria|queensland|tasmania|northern territory|sydney|melbourne|brisbane|perth|adelaide|hobart|darwin|canberra|gold coast|sunshine coast|central coast|newcastle|wollongong|geelong|townsville|cairns|toowoomba|ballarat|bendigo|launceston|albury|wagga|mackay|rockhampton|bunbury|bundaberg|mildura|shepparton|orange|dubbo|tamworth/i;
const FOREIGN_LOCATION_PATTERN = /united kingdom|england|scotland|ireland|(?<!south )wales|canada|united states|\busa\b|india|philippines|new zealand|nepal|united arab emirates|\buae\b|saudi|qatar|oman|kuwait|bahrain|singapore|malaysia|hong kong|china|south africa|zimbabwe|kenya|nigeria|pakistan|sri lanka|bangladesh|indonesia|british columbia|ontario|california|texas|florida|new york/i;

export function isAustralianLocation(location) {
  const text = clean(location);
  return Boolean(text) && AU_LOCATION_PATTERN.test(text) && !FOREIGN_LOCATION_PATTERN.test(text);
}

/** Thrown when a search page never reached a recognisable state (results or a genuine empty-state). */
export class SearchUnavailableError extends Error {}
/** Thrown on LinkedIn's rate-limit page. */
export class RateLimitedError extends Error {}

/** Exit codes scripts/run-browser-agent.mjs uses to tell the auto-runner why it stopped. */
export const BROWSER_AGENT_EXIT = { SEARCH_BROKEN: 3, RATE_LIMITED: 4 };

export function hasUniversityCorroborationInText(text, candidate) {
  if (!text || !candidate.qualifications) return false;
  const auQual = primaryAustralianQualification(candidate.qualifications);
  if (!auQual?.institution) return false;
  const hay = comparable(text);
  const target = comparable(auQual.institution);
  const shortDomain = auQual.domain ? auQual.domain.split(".")[0] : null;
  return Boolean(target && hay.includes(target)) || Boolean(shortDomain && hay.includes(shortDomain));
}

// ---------------------------------------------------------------------------
// Browser I/O
// ---------------------------------------------------------------------------

export async function connectToBrave({ cdpEndpoint = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222" } = {}) {
  const { chromium } = await import("playwright-core");
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpEndpoint);
  } catch (error) {
    throw new Error(
      `Could not attach to Brave at ${cdpEndpoint}. Run scripts/launch-brave-debug.mjs first ` +
      `(Brave must be started with --remote-debugging-port for this to work). Cause: ${error.message}`
    );
  }
  const context = browser.contexts()[0] || (await browser.newContext());
  return { browser, context };
}

export async function findOrOpenSalesNavigatorPage(context) {
  const existing = context.pages().find((page) => /linkedin\.com\/sales/i.test(page.url()));
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/sales/search/people", { waitUntil: "domcontentloaded" });
  return page;
}

const HONORIFIC_PREFIX = /^((assoc(iate)?\.?\s+|adjunct\s+)?prof(essor)?|dr|mr|mrs|ms|miss|mx|lady|dame|sir|rev(erend)?)\.?\s+/i;

function candidateSearchQuery(candidate) {
  let name = clean(candidate.full_name);
  while (HONORIFIC_PREFIX.test(name)) name = name.replace(HONORIFIC_PREFIX, "");
  return name;
}

/** "First Last" — how almost everyone actually appears on LinkedIn. */
function shortSearchName(candidate) {
  const first = clean(candidate.first_name);
  const last = clean(candidate.last_name);
  if (first && last) return `${first} ${last}`;
  const tokens = candidateSearchQuery(candidate).split(" ").filter(Boolean);
  return tokens.length > 2 ? `${tokens[0]} ${tokens.at(-1)}` : tokens.join(" ");
}

/**
 * Builds a tiered set of search strings, broadest first. Tier 0 is "First
 * Last", NOT the full register name: Sales Navigator keyword search requires
 * every word, and most people don't show their middle names on LinkedIn —
 * confirmed live 2026-10-13, the full register name found 0 of 20 middle-name
 * nurses while "First Last" surfaced same-named profiles for 10 of them
 * (ACT data: 1 confirmed out of 5,245 middle-name nurses vs 46 of 3,704
 * without). "First Last" also finds anyone who does show a middle name, so
 * it's a strict superset; the full name is kept as tier 1 only to rank a
 * profile that displays it. Then name+location and name+AU-university.
 */
export function buildSalesNavigatorQueries(candidate) {
  const full = candidateSearchQuery(candidate);
  if (!full) return [];
  const short = shortSearchName(candidate) || full;
  const queries = [short];
  if (full.toLowerCase() !== short.toLowerCase()) queries.push(full);
  const location = candidate.suburb || candidate.state;
  if (location) queries.push(`${short} ${location}`);
  const auQual = primaryAustralianQualification(candidate.qualifications);
  if (auQual?.institution) queries.push(`${short} ${auQual.institution}`);
  return queries;
}

// Confirmed against the live Sales Navigator UI: the filter panel exposes
// buttons named "Expand {Filter Name} filter", each revealing a typeahead
// input with its own placeholder. Typing a value renders <li role="option">
// suggestions whose "Include" control has aria-label `Include "<value>" in
// ... filter` — clicking it applies the filter as a pill.
const FILTER_INPUT_PLACEHOLDER = {
  Geography: "Add locations",
  "Current job title": "Add current titles"
};

async function ensureFilterPanelExpanded(page) {
  if (await page.locator('input[placeholder="Add locations"]').count()) return;
  const expandPanel = page.getByRole("button", { name: /expand filter panel/i });
  if (await expandPanel.count()) {
    await expandPanel.first().click().catch(() => {});
    await page.waitForTimeout(1000);
  }
}

export async function addFilterValue(page, filterName, value) {
  if (!value) return false;
  await ensureFilterPanelExpanded(page);
  const placeholder = FILTER_INPUT_PLACEHOLDER[filterName];
  let input = page.locator(`input[placeholder="${placeholder}"]`).first();
  if (!(await input.count())) {
    const expand = page.getByRole("button", { name: new RegExp(`^Expand ${filterName} filter$`, "i") });
    if (!(await expand.count())) return false;
    await expand.first().click().catch(() => {});
    await page.waitForTimeout(800);
    input = page.locator(`input[placeholder="${placeholder}"]`).first();
    if (!(await input.count())) return false;
  }
  await input.click();
  await input.fill("");
  await input.type(value, { delay: 60 });
  await page.waitForTimeout(1200);
  const exactOption = page.locator(`[role="button"][aria-label^="Include \\u201c${value}\\u201d"]`).first();
  const option = (await exactOption.count())
    ? exactOption
    : page.locator('li[role="option"] [role="button"][aria-label^="Include"]').first();
  if (!(await option.count())) return false;
  await option.click().catch(() => {});
  await page.waitForTimeout(500);
  return true;
}

/**
 * Applies Sales Navigator's structured filters instead of relying on plain
 * keyword search alone — this narrows the candidate population the way a
 * recruiter actually would (location + role), rather than hoping a bare name
 * search surfaces the right person. Applied once per run (or once per
 * profession change); best-effort — a filter that fails to apply just means
 * that search runs unfiltered rather than aborting the batch.
 */
export async function applySearchFilters(page, { geography = "Australia", currentTitle } = {}) {
  await addFilterValue(page, "Geography", geography).catch(() => {});
  if (currentTitle) await addFilterValue(page, "Current job title", currentTitle).catch(() => {});
}

/**
 * Loads a clean people-search page with Geography=Australia applied. A bare
 * goto to the search URL drops every filter, so anything that reloads the
 * page (a tab parked elsewhere, recovery after opening a profile) must come
 * through here or its next search silently runs worldwide.
 */
export async function openFilteredSearchPage(page) {
  await page.goto("https://www.linkedin.com/sales/search/people", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await applySearchFilters(page, { geography: "Australia" });
  await page.waitForTimeout(1000);
}

/**
 * Runs one Sales Navigator people search for a candidate and extracts up to
 * maxCards result cards (not just the top one — see searchCandidateOnSalesNavigator
 * for why). Returns [] (not throws) when nothing usable was found, so a
 * batch can keep moving through other candidates.
 *
 * Confirmed live: Sales Navigator's `?keywords=` URL parameter does NOT run
 * a search by itself — it must go through the actual search input
 * (#global-typeahead-search-input) followed by Enter. Result cards render as
 * <li class="artdeco-list__item"> containing a[href*="/sales/lead/"] with
 * [data-anonymize="person-name"|"title"|"company-name"|"location"] fields —
 * this part matches what was originally guessed and needed no change.
 */
// Sales Navigator's two genuine zero-result states (confirmed live
// 2026-10-13): a plain "No leads matched your search", and — when a filter
// such as Geography=Australia excludes everyone — "No matches found" followed
// by "N LEADS AVAILABLE IF YOU REMOVE THE REGION FILTER" and a list of those
// out-of-filter (overseas) people. That list is NOT a result set; before this
// fix it was scraped as if it were.
const EMPTY_STATE_PATTERN = /no leads matched your search|no matches found|leads available if you remove/i;
const RATE_LIMIT_PATTERN = /HTTP ERROR 429|too many requests|this page isn.t working/i;

export function classifySearchPage({ bodyText = "", leadLinkCount = 0 } = {}) {
  if (RATE_LIMIT_PATTERN.test(bodyText)) return "rate_limited";
  if (EMPTY_STATE_PATTERN.test(bodyText)) return "empty";
  if (leadLinkCount > 0) return "results";
  return "pending";
}

export function urlHasKeywords(url, query) {
  const squash = (value) => value.toLowerCase().replace(/\s+/g, " ").trim();
  try {
    return squash(decodeURIComponent(decodeURIComponent(url))).includes(`keywords:${squash(query)}`);
  } catch { return false; }
}
const regionFilterApplied = (url) => {
  try { return /type:REGION/.test(decodeURIComponent(decodeURIComponent(url))); } catch { return false; }
};

/**
 * Runs one keyword search and returns its result cards, [] for a genuine
 * empty result, or THROWS — never silently returns [] for a page that didn't
 * load. Silently returning [] on a timeout is what let ~6,900 ACT candidates
 * be marked identity_unresolved during hours when search was broken
 * (0 finds in 6,945 first attempts vs 15% in healthy hours).
 */
async function runOneSalesNavigatorQuery(page, query, maxCards = 5, { requireRegionFilter = true } = {}) {
  const searchInput = page.locator("#global-typeahead-search-input");
  if (!(await searchInput.count()) || (requireRegionFilter && !regionFilterApplied(page.url()))) {
    await openFilteredSearchPage(page);
    if (!(await searchInput.count())) throw new SearchUnavailableError(`Sales Navigator search box missing (url=${page.url()})`);
  }
  await searchInput.click();
  await searchInput.fill("");
  await searchInput.type(query, { delay: 60 });
  await page.waitForTimeout(500);
  await searchInput.press("Enter");

  // Wait for THIS query's page (the URL carries the keywords) before reading
  // anything, so the previous search's cards are never mistaken for these.
  let state = "pending";
  let urlMatchedAt = 0;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    if (!urlHasKeywords(page.url(), query)) continue;
    // The URL flips before the list re-renders; give the old cards a moment to clear.
    urlMatchedAt ||= Date.now();
    if (Date.now() - urlMatchedAt < 1500) continue;
    const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const leadLinkCount = await page.locator('a[href*="/sales/lead/"]').count().catch(() => 0);
    state = classifySearchPage({ bodyText, leadLinkCount });
    if (state !== "pending") break;
  }
  if (state === "rate_limited") throw new RateLimitedError(`LinkedIn rate limit page shown for "${query}"`);
  if (state === "pending") throw new SearchUnavailableError(`Search for "${query}" never loaded results or an empty-state`);
  if (requireRegionFilter && !regionFilterApplied(page.url())) {
    throw new SearchUnavailableError(`Geography=Australia filter is not applied (url=${page.url()})`);
  }
  if (state === "empty") return [];
  await page.waitForTimeout(1000);

  return page.evaluate((max) => {
    const items = [...document.querySelectorAll("li.artdeco-list__item")]
      .filter((li) => li.querySelector('a[href*="/sales/lead/"]'))
      .slice(0, max);
    return items.map((li, index) => {
      const link = li.querySelector('a[href*="/sales/lead/"]');
      const text = (selector) => li.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || "";
      return {
        index,
        salesLeadHref: link.getAttribute("href"),
        name: text('[data-anonymize="person-name"]'),
        headline: text('[data-anonymize="title"]'),
        company: text('[data-anonymize="company-name"]'),
        location: text('[data-anonymize="location"]')
      };
    });
  }, maxCards).catch(() => []);
}

/**
 * Among a set of same-name search-result cards, puts the ones whose
 * returned job title looks nursing/medical first — that's occupation
 * evidence we already have without opening a profile. Cards with a
 * different name entirely are dropped: opening them would just burn a
 * click on someone who can never pass scoreIdentityMatch's name check.
 */
export function rankCandidateCards(cards, candidate) {
  // Only same-named people currently in a healthcare role, located in
  // Australia (or with no location shown — the Geography filter already
  // restricts results to Australia, and the decision step still requires a
  // positive Australian location before attaching anything). Recruiters,
  // engineers etc. sharing the name are never opened.
  const eligible = cards.filter((card) => namesMatch(candidate.full_name, card.name)
    && isHealthcareRole(card.headline, card.company)
    && (!clean(card.location) || isAustralianLocation(card.location)));
  const nursing = eligible.filter((card) => NURSING_TITLE_PATTERN.test(card.headline || ""));
  const rest = eligible.filter((card) => !NURSING_TITLE_PATTERN.test(card.headline || ""));
  return [...nursing, ...rest];
}

/**
 * Tries each query tier from buildSalesNavigatorQueries in order — "First
 * Last", full name, name+location, then name+university — considering only
 * same-named healthcare workers in Australia (rankCandidateCards). Within a tier, a
 * search for a common name can return several different people sharing it
 * (confirmed live: an unfiltered "Anushka Tamboli" search surfaced a
 * Brisbane test analyst ahead of the actual Canberra Hospital nurse).
 * Blindly taking the top card risks either attaching the wrong person or —
 * just as bad — missing a real, findable candidate because the right
 * profile wasn't ranked first. So each same-named card is opened in
 * ranked order (occupation-matching cards first) until one is corroborated
 * by either its job title or its education section, capped at 3 opens per
 * tier to bound the extra browsing — and a tier that finds only
 * uncorroborated cards does NOT stop the search: every later tier still
 * gets tried, since a narrower query (e.g. name+university) is often
 * exactly what surfaces the real person when a bare name search doesn't.
 * If nothing corroborates anywhere, the very first same-named card found
 * across all tiers is returned as a best-effort result — scoreIdentityMatch's
 * own corroboration gate (see applyBrowserLeadDecision) is the real
 * backstop that decides whether it's trustworthy enough to attach.
 * Returns null when no tier produced even a same-named card.
 */
export async function searchCandidateOnSalesNavigator(page, candidate) {
  const queries = buildSalesNavigatorQueries(candidate);
  if (!queries.length) return null;

  // The fallback is tracked across ALL tiers, not returned as soon as one
  // tier runs out of candidates to check. Confirmed live: a bare-name tier
  // 1 search for "Anushka Tamboli" only surfaced the wrong (test-analyst)
  // namesake in its top cards — returning early there means tier 3
  // (name+university), the query that actually finds the real nurse, never
  // runs at all. Every tier gets a chance to produce a corroborated match
  // before settling for the best uncorroborated one found anywhere.
  let fallback = null;
  for (let tierIndex = 0; tierIndex < queries.length; tierIndex++) {
    // Reading more cards from an already-loaded page costs no extra requests.
    const cards = await runOneSalesNavigatorQuery(page, queries[tierIndex], 10);
    const ranked = rankCandidateCards(cards, candidate);
    if (!ranked.length) {
      // The broadest query (tier 0, "First Last") finding NOBODY with that
      // name at all is a strong "not on LinkedIn in Australia" signal — a
      // narrower/qualified variant is essentially guaranteed to also find
      // nobody, so stop rather than trying the other tiers. This is
      // deliberately NOT the same as "tier 0 found same-named people, just
      // not a healthcare one" — that case still escalates through every
      // tier, since a more specific query is exactly what recovers a
      // same-named person ranked below the namesakes (confirmed live:
      // "Anushka Tamboli").
      if (tierIndex === 0 && !cards.some((card) => namesMatch(candidate.full_name, card.name))) break;
      continue;
    }
    const query = queries[tierIndex];

    let tierFirst = null;
    for (const card of ranked.slice(0, 3)) {
      const { profileUrl, educationSnippet } = await openLeadAndExtract(page, card.index)
        .catch(() => ({ profileUrl: "", educationSnippet: "" }));
      const result = {
        profileUrl: profileUrl || new URL(card.salesLeadHref, "https://www.linkedin.com").toString(),
        name: clean(card.name),
        headline: clean(card.headline),
        company: clean(card.company),
        location: clean(card.location),
        educationSnippet: clean(educationSnippet),
        matchedQuery: query
      };
      // Every ranked card is already a same-named healthcare worker in
      // Australia. A university match settles it; a single such person in
      // this tier is unambiguous enough to stop. Several same-named
      // healthcare workers keep escalating — the name+university tier can
      // still single out the right one — and the first is kept as fallback.
      if (hasUniversityCorroborationInText(educationSnippet, candidate)) return result;
      tierFirst ||= result;
      fallback ||= result;
    }
    if (ranked.length === 1) return tierFirst;
  }
  return fallback;
}

/**
 * Canary: searches for someone already confirmed on LinkedIn and reports
 * whether they're still found. A run of "not found" results is only trusted
 * once a canary passes right after it — the September run marked ~6,900
 * candidates "not found" through hours when search was silently returning
 * nothing, which a canary would have caught within a handful of searches.
 * Throws RateLimitedError on LinkedIn's rate-limit page; otherwise returns
 * true/false (a page that never loads counts as a failed canary).
 */
export async function searchCanaryPasses(page, canaries) {
  for (const canary of canaries) {
    try {
      const cards = await runOneSalesNavigatorQuery(page, shortSearchName(canary), 10);
      if (cards.some((card) => namesMatch(canary.full_name, card.name))) return true;
    } catch (error) {
      if (error instanceof RateLimitedError) throw error;
    }
  }
  return false;
}

/**
 * Clicks the result at cardIndex in-place (Sales Navigator renders the lead
 * profile as a client-routed overlay — a fresh tab navigated directly to
 * the lead URL renders empty, confirmed live) to read the canonical
 * linkedin.com/in/ profile URL and an education snippet if present, then
 * navigates back to the results list so the next card can be opened the
 * same way.
 */
async function openLeadAndExtract(page, cardIndex = 0) {
  const leadLink = page.locator('a[href*="/sales/lead/"]').nth(cardIndex);
  let profileUrl = "";
  let educationSnippet = "";
  try {
    await leadLink.click();
    await page.waitForTimeout(3000);
    profileUrl = await page.evaluate(() => {
      const link = document.querySelector('a[href*="linkedin.com/in/"]');
      return link ? link.href.split("?")[0] : "";
    });
    if (!profileUrl) {
      // The public /in/ URL isn't always inline — Sales Navigator often
      // gates it behind a "Contact info" flyout. Try opening it before
      // giving up (confirmed missing on candidate #30 Ekta Singh, whose
      // lead recorded a raw sales/lead/ URL instead of a canonical one).
      const contactInfo = page.getByRole("button", { name: /contact info/i }).first();
      if (await contactInfo.count().catch(() => 0)) {
        await contactInfo.click().catch(() => {});
        await page.waitForTimeout(1500);
        profileUrl = await page.evaluate(() => {
          const link = document.querySelector('a[href*="linkedin.com/in/"]');
          return link ? link.href.split("?")[0] : "";
        });
        await page.keyboard.press("Escape").catch(() => {});
      }
    }
    educationSnippet = await page.evaluate(() => {
      const headers = [...document.querySelectorAll("h2, h3, [role=heading]")];
      const eduHeader = headers.find((h) => /education/i.test(h.textContent || ""));
      const section = eduHeader?.closest("section") || eduHeader?.parentElement;
      return section ? section.textContent.replace(/\s+/g, " ").trim().slice(0, 500) : "";
    });
  } finally {
    await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(1200);
    // Defensive recovery: if the back navigation didn't land back on a
    // usable search page (SPA history can be unpredictable), reload fresh —
    // with the Australia filter re-applied (a bare reload drops it).
    if (!(await page.locator("#global-typeahead-search-input").count())) {
      await openFilteredSearchPage(page).catch(() => {});
    }
  }
  return { profileUrl, educationSnippet };
}

// ---------------------------------------------------------------------------
// Pure logic: normalize a raw browser find, log it, and apply the identity
// decision. No Playwright/browser dependency below this line — unit testable.
// ---------------------------------------------------------------------------

export function normalizeBrowserLead(raw) {
  if (!raw) return null;
  return {
    fullName: clean(raw.name),
    linkedinUrl: clean(raw.profileUrl),
    employer: clean(raw.company),
    currentTitle: clean(raw.headline),
    location: clean(raw.location),
    education: clean(raw.educationSnippet)
  };
}

export function recordBrowserLead(db, { candidateId, normalized, raw }) {
  db.prepare(`INSERT INTO browser_leads
    (candidate_id, linkedin_url, matched_full_name, headline, employer, current_title, location, education_snippet, raw_payload, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      candidateId,
      normalized?.linkedinUrl || null,
      normalized?.fullName || null,
      raw?.headline || null,
      normalized?.employer || null,
      normalized?.currentTitle || null,
      normalized?.location || null,
      normalized?.education || null,
      JSON.stringify(raw || {}),
      normalized?.linkedinUrl ? "found" : "not_found"
    );
}

/**
 * Scores a normalized browser lead against the candidate's licensed AHPRA
 * record using the same scoreIdentityMatch used everywhere else in the
 * pipeline (identical hard-conflict rejection: non-AU phone, overseas
 * location, name-mismatched LinkedIn slug all still zero the score here).
 *
 * A clean high-confidence match is written straight to identity_status =
 * 'confirmed' — no pending_confirmation queue — following the exact same
 * field convention already used by swarm-orchestrator.mjs's academic-engine
 * auto-confirm path, just with a different identity_provider. Anything that
 * doesn't clear the bar is left at manual_review; it is not held back
 * waiting on a human decision, it simply isn't a confident enough match to
 * act on automatically.
 */
export function applyBrowserLeadDecision(db, candidate, normalized, thresholds = {}, audit = () => {}, options = {}) {
  if (!normalized?.linkedinUrl) {
    db.prepare("UPDATE candidates SET workflow_stage = 'identity_unresolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(candidate.id);
    return { decision: "not_found", score: 0 };
  }

  const educationResult = { ...normalized };
  // scoreIdentityMatch reads result.university/school/education for the
  // AHPRA-qualification cross-check; the browser agent's education snippet
  // maps onto that same input.
  if (normalized.education) educationResult.education = normalized.education;

  const match = scoreIdentityMatch(candidate, educationResult, thresholds);
  const high = Number(thresholds.high ?? 85);

  // Require real corroboration — a university/qualification match or a
  // nursing/medical job title — before treating a lead as this candidate's
  // identity, for auto-confirm as much as for manual_review. In practice a
  // wrong-profession namesake rarely reaches the 85-point auto-confirm bar
  // on name+location alone (structurally short by ~10 points without a
  // qualification match), but this makes that protection explicit and
  // applies it uniformly rather than relying on the scoring arithmetic to
  // happen to work out that way.
  //
  // Since 2026-10-13 (user requirement) a lead is only ever attached when the
  // person is CURRENTLY in a healthcare role (title/employer — recruiters,
  // engineers etc. are never attached even with a matching university) and
  // their profile location is positively Australian (a bare "Greater
  // Philadelphia" with no country no longer slips through). A university
  // match still adds score toward auto-confirmation.
  const nameMatched = match.reasons.includes("Name matches licensed source");
  const inHealthcare = isHealthcareRole(normalized.currentTitle, normalized.employer);
  const inAustralia = isAustralianLocation(normalized.location);
  const hasSufficientEvidence = nameMatched && inHealthcare && inAustralia;

  if (match.score >= high && match.conflicts.length === 0 && hasSufficientEvidence) {
    const notes = `Sales Navigator auto-verified: ${match.reasons.join("; ")}`;
    db.prepare(`UPDATE candidates SET
        identity_status = 'confirmed',
        workflow_stage = 'identity_confirmed',
        identity_match_score = ?,
        match_confidence = 'high',
        identity_provider = 'browser_agent_salesnav',
        identity_provider_reference = ?,
        match_reasons = ?,
        recruiter_notes = ?,
        reviewer_decision = 'confirmed',
        identity_reviewed_at = CURRENT_TIMESTAMP,
        linkedin_url = ?,
        employer = COALESCE(NULLIF(?, ''), employer),
        current_title = COALESCE(NULLIF(?, ''), current_title),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`)
      .run(match.score, normalized.linkedinUrl, JSON.stringify(match.reasons), notes,
        normalized.linkedinUrl, normalized.employer || "", normalized.currentTitle || "", candidate.id);
    db.prepare(`INSERT INTO review_history (candidate_id, decision, match_score, notes, reviewer)
      VALUES (?, 'confirmed', ?, ?, 'Browser Agent (Sales Navigator)')`)
      .run(candidate.id, match.score, notes);
    recordVerifiedProfileLocation(db, candidate.id, { locationText: normalized.location, index: options.postcodeIndex });
    audit("candidate.auto_confirmed_browser_agent", "candidate", candidate.id,
      { score: match.score, linkedinUrl: normalized.linkedinUrl, reasons: match.reasons });
    return { decision: "confirmed", score: match.score, reasons: match.reasons };
  }

  // Found but not confident enough to auto-confirm. Only attach the found
  // profile to the candidate record when there's real corroboration, not
  // just a name match — a bare name+location hit on an otherwise-empty
  // profile (candidate #163 Ambrin John: 0 followers, no headline, no
  // posts, no education/employer evidence) isn't strong enough to park on
  // a candidate's identity even for manual review. Require the name to
  // match AND at least one of: an AHPRA-qualification university match, or
  // a nursing/medical job title on the returned profile. Anything weaker —
  // including a flat name mismatch, which is evidence about a different
  // person entirely — is recorded for audit (score/reasons/conflicts) but
  // never written into linkedin_url/employer/current_title, since every
  // future re-discovery attempt (claimCandidates with needsLinkedIn: true)
  // skips a candidate that already has a linkedin_url, and a weak/wrong
  // write would permanently strand them. (hasSufficientEvidence computed
  // above, shared with the auto-confirm check.)
  db.prepare(`UPDATE candidates SET workflow_stage = 'manual_review', identity_match_score = ?,
      match_confidence = ?, match_reasons = ?, conflicting_evidence = ?,
      linkedin_url = COALESCE(?, linkedin_url), employer = COALESCE(NULLIF(?, ''), employer),
      current_title = COALESCE(NULLIF(?, ''), current_title),
      identity_provider = 'browser_agent_salesnav', identity_provider_reference = ?,
      identity_discovered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`)
    .run(match.score, match.confidence, JSON.stringify(match.reasons), JSON.stringify(match.conflicts),
      hasSufficientEvidence ? normalized.linkedinUrl : null,
      hasSufficientEvidence ? (normalized.employer || "") : "",
      hasSufficientEvidence ? (normalized.currentTitle || "") : "",
      hasSufficientEvidence ? normalized.linkedinUrl : null, candidate.id);
  db.prepare(`INSERT INTO review_history (candidate_id, decision, match_score, notes, reviewer)
    VALUES (?, 'manual_review', ?, ?, 'Browser Agent (Sales Navigator)')`)
    .run(candidate.id, match.score,
      `Sales Navigator lead found but below confirmation threshold: ${match.conflicts.join("; ") || match.reasons.join("; ") || "insufficient evidence"}`);
  return { decision: "manual_review", score: match.score, conflicts: match.conflicts };
}

/** Convenience helper combining an Australian-qualification hint for the search query, mirroring the Clay pilots. */
export function candidateSearchContext(candidate) {
  const auQual = primaryAustralianQualification(candidate.qualifications);
  return { institution: auQual?.institution || null, domain: auQual?.domain || null };
}
