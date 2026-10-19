#!/usr/bin/env node
/**
 * Incremental version of audit-live-linkedin-profiles.mjs: instead of
 * auditing every attached LinkedIn URL, only checks candidates whose
 * identity was discovered in the last N minutes (--minutes, default 15).
 * Meant to be run on a short recurring cadence (see docs/BROWSER_AGENT.md)
 * so newly-found matches get independently re-verified — via a fresh,
 * properly-filtered search rather than just re-opening the stored URL —
 * shortly after the auto-runner attaches them, rather than accumulating
 * unverified matches for hours.
 *
 * Re-runs the actual search (not just page.goto on the stored URL, which
 * can't render a raw sales/lead/ reference outside the SPA — see
 * src/browser-agent.mjs's openLeadAndExtract) and checks whether the same
 * corroboration (university or nursing/medical title) still holds. Flags
 * anything that doesn't for follow-up.
 */
import { chromium } from "playwright-core";
import { db } from "../src/db.mjs";
import { searchCandidateOnSalesNavigator, applySearchFilters, hasUniversityCorroborationInText } from "../src/browser-agent.mjs";

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const minutes = Number(process.argv.find((a) => a.startsWith("--minutes="))?.split("=")[1] || 15);
const NURSING_TITLE_PATTERN = /nurs|midwife/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const rows = db.prepare(`
    SELECT id, full_name, linkedin_url, identity_status, identity_match_score, identity_discovered_at, qualifications
    FROM candidates
    WHERE identity_provider = 'browser_agent_salesnav'
      AND linkedin_url IS NOT NULL AND linkedin_url != ''
      AND identity_discovered_at >= datetime('now', ?)
    ORDER BY identity_discovered_at DESC
  `).all(`-${minutes} minutes`);

  if (!rows.length) {
    console.log(`No leads discovered in the last ${minutes} minute(s). Nothing to re-verify.`);
    return;
  }
  console.log(`Re-verifying ${rows.length} lead(s) discovered in the last ${minutes} minute(s)...\n`);

  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto("https://www.linkedin.com/sales/search/people", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await applySearchFilters(page, { geography: "Australia" });

  const flagged = [];
  for (const candidate of rows) {
    const raw = await searchCandidateOnSalesNavigator(page, candidate).catch(() => null);
    const occupationMatches = raw ? NURSING_TITLE_PATTERN.test(raw.headline || "") : false;
    const universityMatches = raw ? hasUniversityCorroborationInText(raw.educationSnippet, candidate) : false;
    const stillCorroborated = occupationMatches || universityMatches;

    console.log(`#${candidate.id} ${candidate.full_name} (${candidate.identity_status}, score ${candidate.identity_match_score})`);
    console.log(`  stored: ${candidate.linkedin_url}`);
    if (raw) {
      console.log(`  re-search found: ${raw.name} | ${raw.headline} | ${raw.company} -> ${stillCorroborated ? "still corroborated" : "NOT corroborated this time"}`);
    } else {
      console.log(`  re-search found nothing this time`);
    }
    if (!stillCorroborated) flagged.push({ ...candidate, raw });
    console.log();
    await sleep(3000);
  }

  await page.close().catch(() => {});

  console.log("===============================================================");
  console.log(`RE-VERIFICATION COMPLETE — ${flagged.length} of ${rows.length} flagged`);
  console.log("===============================================================");
  flagged.forEach((f) => console.log(`  #${f.id} ${f.full_name}: re-search did not corroborate the stored match`));
  if (flagged.length) {
    console.log("\nThese were NOT automatically changed — flagged for manual follow-up only.");
  }
}

main().catch((err) => {
  console.error("Fatal recent-lead audit error:", err);
  process.exit(1);
});
