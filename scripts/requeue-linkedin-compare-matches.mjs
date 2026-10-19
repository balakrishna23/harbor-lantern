#!/usr/bin/env node
/**
 * Targeted, bounded re-search for the specific candidates flagged by
 * scripts/cross-check-linkedin-compare.mjs as "matched an AHPRA candidate,
 * but our system has no linkedin_url" (identity_unresolved candidates that
 * an external LinkedIn export found, which our own pipeline missed).
 *
 * Deliberately does NOT go through claimCandidates/the generic queue — these
 * candidates already have browser_leads rows from their first attempt, so
 * incident 14's excludeBrowserAgentAttempted exclusion would just skip them
 * again. This is a one-time, explicit, bounded pass over exactly the IDs in
 * the cross-check results, reusing the exact same verified search +
 * corroboration-gated decision logic as the main pipeline (not the compare
 * file's URLs directly — those aren't trusted at face value, same
 * discipline as every other find this session).
 */
import fs from "node:fs";
import { db, audit } from "../src/db.mjs";
import {
  connectToBrave, findOrOpenSalesNavigatorPage, applySearchFilters, searchCandidateOnSalesNavigator,
  normalizeBrowserLead, recordBrowserLead, applyBrowserLeadDecision
} from "../src/browser-agent.mjs";

const DELAY_MIN_MS = 8000;
const DELAY_MAX_MS = 15000;
const thresholds = {
  high: Number(process.env.MATCH_HIGH_THRESHOLD || 85),
  manual: Number(process.env.MATCH_MANUAL_THRESHOLD || 60)
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomDelay() {
  const ms = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
  return sleep(ms);
}

async function main() {
  const results = JSON.parse(fs.readFileSync("exports/linkedin_compare_crosscheck_results.json", "utf8"));
  const ids = [...new Set(results.matched_missing_url.map((r) => r.candidateId))];
  console.log(`Requeuing ${ids.length} candidates flagged by the LinkedIn compare-file cross-check.\n`);

  const { context } = await connectToBrave();
  const page = await findOrOpenSalesNavigatorPage(context);
  await applySearchFilters(page, { geography: "Australia" });
  console.log(`Attached to Sales Navigator tab: ${page.url()}\n`);

  let confirmed = 0, foundNotConfirmed = 0, stillNotFound = 0, errors = 0;

  for (const id of ids) {
    const candidate = db.prepare(`
      SELECT id, full_name, first_name, last_name, profession, state, suburb, postcode, qualifications, workflow_stage
      FROM candidates WHERE id = ?
    `).get(id);
    if (!candidate) { console.log(`#${id} not found in DB, skipping.`); continue; }

    try {
      console.log(`Searching #${candidate.id} ${candidate.full_name}...`);
      const raw = await searchCandidateOnSalesNavigator(page, candidate);
      const normalized = normalizeBrowserLead(raw);
      recordBrowserLead(db, { candidateId: candidate.id, normalized, raw });

      if (!normalized?.linkedinUrl) {
        console.log(`  -> Still not found.`);
        stillNotFound += 1;
        // Leave workflow_stage as identity_unresolved (searchCandidateOnSalesNavigator
        // returning null doesn't change it); no regression from this pass.
      } else {
        const result = applyBrowserLeadDecision(db, candidate, normalized, thresholds, audit);
        if (result.decision === "confirmed") {
          confirmed += 1;
          console.log(`  -> CONFIRMED (score ${result.score}): ${normalized.linkedinUrl}`);
        } else {
          foundNotConfirmed += 1;
          console.log(`  -> Found but not auto-confirmed (score ${result.score}${result.conflicts?.length ? `, conflicts: ${result.conflicts.join("; ")}` : ""}): ${normalized.linkedinUrl}`);
        }
      }
    } catch (error) {
      errors += 1;
      console.error(`  -> Error searching #${candidate.id}: ${error.message}`);
    }
    await randomDelay();
  }

  console.log("\n===============================================================");
  console.log(`Requeue complete. Confirmed: ${confirmed} | Found (needs review): ${foundNotConfirmed} | Still not found: ${stillNotFound} | Errors: ${errors}`);
  console.log("===============================================================");
  process.exit(0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
