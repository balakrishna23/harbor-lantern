#!/usr/bin/env node
/**
 * Live audit: opens every LinkedIn URL currently attached to a candidate
 * (confirmed or manual_review, via the browser agent) in the real,
 * logged-in Brave session and checks for #163-style issues — either a
 * broken/non-existent page, or a paper-thin profile (0 followers, no
 * headline, no posts) that shouldn't have been attached at all. Uses a
 * fresh tab per profile in the same CDP context so it doesn't interfere
 * with a concurrently-running discovery batch.
 */
import { chromium } from "playwright-core";
import { db } from "../src/db.mjs";

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const DELAY_MS = 4000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function auditProfile(context, candidate) {
  const page = await context.newPage();
  try {
    await page.goto(candidate.linkedin_url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(2500);
    const title = await page.title();
    const info = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const followerMatch = bodyText.match(/(\d[\d,]*)\s+followers?/i);
      const notFound = /this profile (is )?not available|page not found|this page doesn.?t exist/i.test(bodyText);
      const headline = document.querySelector('[data-anonymize="title"], .text-body-medium')?.textContent?.trim() || "";
      return {
        followers: followerMatch ? followerMatch[1] : null,
        notFound,
        headline,
        bodySnippetLength: bodyText.length
      };
    });
    return { ok: true, title, ...info };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const rows = db.prepare(`
    SELECT id, full_name, linkedin_url, identity_status, identity_match_score, match_reasons
    FROM candidates
    WHERE identity_provider = 'browser_agent_salesnav' AND linkedin_url IS NOT NULL AND linkedin_url != ''
    ORDER BY id
  `).all();

  console.log(`Auditing ${rows.length} attached LinkedIn profile(s)...\n`);

  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];

  const flagged = [];
  for (const candidate of rows) {
    const result = await auditProfile(context, candidate);
    const nameOverlap = result.title
      ? candidate.full_name.toLowerCase().replace(/^(dr|mr|mrs|ms|miss)\s+/i, "").split(" ").some((t) => t.length > 2 && result.title.toLowerCase().includes(t))
      : false;
    const thin = result.ok && !result.notFound && (!result.followers || result.followers === "0") && !result.headline;
    const suspicious = !result.ok || result.notFound || !nameOverlap || thin;

    console.log(`#${candidate.id} ${candidate.full_name} (${candidate.identity_status}, score ${candidate.identity_match_score})`);
    console.log(`  ${candidate.linkedin_url}`);
    if (!result.ok) {
      console.log(`  -> FAILED TO LOAD: ${result.error}`);
    } else {
      console.log(`  -> title="${result.title}" | followers=${result.followers ?? "0/none"} | headline="${result.headline || "(none)"}" | notFound=${result.notFound}`);
    }
    console.log(`  -> name overlap with page title: ${nameOverlap} | thin profile: ${thin} | ${suspicious ? "FLAGGED" : "looks fine"}\n`);

    if (suspicious) flagged.push({ ...candidate, ...result, thin, nameOverlap });
    await sleep(DELAY_MS);
  }

  console.log("===============================================================");
  console.log(`AUDIT COMPLETE — ${flagged.length} of ${rows.length} flagged for review`);
  console.log("===============================================================");
  flagged.forEach((f) => console.log(`  #${f.id} ${f.full_name}: ${f.error || (f.notFound ? "not found" : f.thin ? "thin profile" : "name mismatch")}`));
}

main().catch((err) => {
  console.error("Fatal audit error:", err);
  process.exit(1);
});
