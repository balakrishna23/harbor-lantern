#!/usr/bin/env node
/**
 * Scrapes LinkedIn Sales Navigator for support/disability/mental-health/
 * personal care workers across 3 NSW South Coast regions, using the same
 * card-extraction pattern proven reliable all session in src/browser-agent.mjs
 * (li.artdeco-list__item / a[href*="/sales/lead/"] / data-anonymize fields),
 * extended with pagination since this needs full result sets, not just the
 * top few cards per candidate search.
 *
 * Built after GrowMeOrganic's extension-driven extraction silently failed to
 * save any leads (list-selection didn't hold across a run) despite showing
 * "extracting: 12" — this stays fully in our own control instead.
 *
 * Two search passes per region (per user's confirmed plan):
 *  1. Title-filter search: Support Associate / Mental Health Worker / Direct
 *     Care Worker (LinkedIn's closest canonical titles to the 4 requested
 *     categories — confirmed live that disability support workers surface
 *     under these buckets too, e.g. "Nicole Danvers · Disability Support
 *     Worker" appeared in the Bega title-filter results).
 *  2. Keyword search: "disability support" (no title filter) — catches
 *     anyone LinkedIn's canonical taxonomy doesn't bucket into #1, since
 *     there's no dedicated "Disability Support Worker" canonical title.
 */
import fs from "node:fs";
import path from "node:path";
import { connectToBrave, addFilterValue } from "../src/browser-agent.mjs";
import { toCsv } from "../src/csv.mjs";

const PAGE_DELAY_MS = 4000;
const MAX_PAGES_PER_SEARCH = 25; // safety cap

const REGIONS = {
  "Bega area": ["Bega, New South Wales", "Tathra, New South Wales", "Merimbula, New South Wales", "Pambula, New South Wales", "Eden, New South Wales", "Bermagui, New South Wales", "Cobargo, New South Wales", "Candelo, New South Wales", "Bemboka, New South Wales"],
  "Narooma area": ["Narooma, New South Wales", "Central Tilba, New South Wales", "Tilba Tilba, New South Wales", "Bermagui, New South Wales", "Bodalla, New South Wales", "Tuross Head, New South Wales", "Moruya, New South Wales"],
  "Batemans Bay area": ["Batemans Bay, New South Wales", "Moruya, New South Wales", "Broulee, New South Wales", "Tomakin, New South Wales", "Mogo, New South Wales", "Nelligen, New South Wales", "Tuross Head, New South Wales"]
};

const TITLE_FILTERS = ["Support Associate", "Mental Health Worker", "Direct Care Worker"];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function extractCurrentPageCards(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll("li.artdeco-list__item")]
      .filter((li) => li.querySelector('a[href*="/sales/lead/"]'));
    return items.map((li) => {
      const link = li.querySelector('a[href*="/sales/lead/"]');
      const text = (selector) => li.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() || "";
      return {
        salesLeadHref: link.getAttribute("href"),
        name: text('[data-anonymize="person-name"]'),
        headline: text('[data-anonymize="title"]'),
        company: text('[data-anonymize="company-name"]'),
        location: text('[data-anonymize="location"]')
      };
    });
  }).catch(() => []);
}

async function goToNextPage(page) {
  const nextBtn = page.locator('button[aria-label="Next"]').first();
  if (!(await nextBtn.count())) return false;
  const disabled = await nextBtn.isDisabled().catch(() => true);
  if (disabled) return false;
  await nextBtn.click().catch(() => {});
  await page.waitForTimeout(2000);
  await page.waitForSelector('a[href*="/sales/lead/"]', { timeout: 15000 }).catch(() => {});
  return true;
}

async function runSearch(page, { region, searchLabel, towns, titles, keyword }) {
  await page.goto("https://www.linkedin.com/sales/search/people", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  for (const town of towns) {
    await addFilterValue(page, "Geography", town).catch(() => {});
  }
  if (titles) {
    for (const title of titles) {
      await addFilterValue(page, "Current job title", title).catch(() => {});
    }
  }
  if (keyword) {
    const searchInput = page.locator("#global-typeahead-search-input");
    await searchInput.click();
    await searchInput.fill("");
    await searchInput.type(keyword, { delay: 60 });
    await page.waitForTimeout(500);
    await searchInput.press("Enter");
  }

  await page.waitForTimeout(2000);
  const hasResults = await page.locator('a[href*="/sales/lead/"]').count();
  if (!hasResults) {
    console.log(`[${region} / ${searchLabel}] No results.`);
    return [];
  }

  const results = [];
  let pageNum = 1;
  while (pageNum <= MAX_PAGES_PER_SEARCH) {
    const cards = await extractCurrentPageCards(page);
    for (const card of cards) results.push({ region, searchLabel, ...card });
    console.log(`[${region} / ${searchLabel}] Page ${pageNum}: ${cards.length} cards (running total ${results.length})`);
    const hasNext = await goToNextPage(page);
    if (!hasNext) break;
    pageNum += 1;
    await sleep(PAGE_DELAY_MS);
  }
  return results;
}

async function main() {
  const { context } = await connectToBrave();
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes("linkedin.com/sales")) || await context.newPage();
  await page.bringToFront();

  const allResults = [];
  for (const [region, towns] of Object.entries(REGIONS)) {
    const titleResults = await runSearch(page, { region, searchLabel: "title-filter", towns, titles: TITLE_FILTERS });
    allResults.push(...titleResults);
    await sleep(PAGE_DELAY_MS);

    const keywordResults = await runSearch(page, { region, searchLabel: "disability-support-keyword", towns, keyword: "disability support" });
    allResults.push(...keywordResults);
    await sleep(PAGE_DELAY_MS);
  }

  const seen = new Set();
  const deduped = allResults.filter((r) => {
    const key = r.salesLeadHref;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const columns = ["region", "searchLabel", "name", "headline", "company", "location", "salesLeadHref"];
  const csv = toCsv(deduped, columns);
  const outPath = path.resolve("exports/south_coast_nsw_care_workers.csv");
  fs.writeFileSync(outPath, csv, "utf8");

  console.log("\n===============================================================");
  console.log(`Total raw cards: ${allResults.length} | Unique profiles: ${deduped.length}`);
  console.log(`Written to ${outPath}`);
  console.log("===============================================================");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
