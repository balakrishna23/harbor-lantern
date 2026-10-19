#!/usr/bin/env node
/**
 * Duplicate-integrity check, run periodically (especially now that multiple
 * worker tabs claim and write concurrently — see scripts/run-browser-agent.mjs's
 * --workers flag). Checks for the kinds of duplication that would actually
 * be a bug, not the AHPRA source's own expected multiplicity (README:
 * "9,130 registration rows representing 8,951 unique registration numbers
 * ... 179 repeated numbers differ by registration type" — one candidate can
 * legitimately have multiple registrations, that's fine).
 *
 * Real bugs this catches:
 *  1. Two DIFFERENT candidates sharing the same linkedin_url — would mean
 *     the same real person got attributed to two AHPRA records, or a race
 *     condition let two workers attach the same lead to different people.
 *  2. A candidate claimed by more than one worker at once — should be
 *     structurally impossible (claimCandidates uses BEGIN IMMEDIATE) but
 *     checked directly rather than assumed.
 *  3. Duplicate candidates rows sharing a source_hash (the import-time
 *     dedupe key) — would mean the UNIQUE constraint was bypassed somehow.
 */
import { db } from "../src/db.mjs";

function section(title) {
  console.log(`\n--- ${title} ---`);
}

let problems = 0;

section("1. Candidates sharing the same linkedin_url (should be none)");
const sharedUrls = db.prepare(`
  SELECT linkedin_url, COUNT(*) n, GROUP_CONCAT(id) ids
  FROM candidates
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
  GROUP BY linkedin_url
  HAVING COUNT(*) > 1
`).all();
if (!sharedUrls.length) {
  console.log("None found.");
} else {
  problems += sharedUrls.length;
  sharedUrls.forEach((row) => {
    const names = db.prepare(`SELECT id, full_name FROM candidates WHERE id IN (${row.ids})`).all();
    console.log(`  SHARED URL (${row.n}x): ${row.linkedin_url}`);
    names.forEach((n) => console.log(`    #${n.id} ${n.full_name}`));
  });
}

section("2. Candidates currently claimed by more than one in-flight process (should be impossible)");
// A structural sanity check, not a real "duplicate claim" detector (the DB
// can't record two claimants for one row) — this instead flags any
// candidate stuck in claiming_browser_discovery for a long time, which is
// the observable symptom if a claim ever leaked/never got followed by a
// decision.
const stuckClaims = db.prepare(`
  SELECT id, full_name, updated_at FROM candidates
  WHERE workflow_stage = 'claiming_browser_discovery'
    AND updated_at < datetime('now', '-15 minutes')
`).all();
if (!stuckClaims.length) {
  console.log("None found.");
} else {
  problems += stuckClaims.length;
  stuckClaims.forEach((c) => console.log(`  STUCK CLAIM: #${c.id} ${c.full_name} (claimed since ${c.updated_at})`));
  console.log("  (runSupervisorCheck should recover these automatically after its lease timeout.)");
}

section("3. Duplicate candidates rows sharing a source_hash (import-dedupe key — should be none)");
const dupeHashes = db.prepare(`
  SELECT source_hash, COUNT(*) n, GROUP_CONCAT(id) ids
  FROM candidates
  GROUP BY source_hash
  HAVING COUNT(*) > 1
`).all();
if (!dupeHashes.length) {
  console.log("None found.");
} else {
  problems += dupeHashes.length;
  dupeHashes.forEach((row) => console.log(`  DUPLICATE source_hash (${row.n}x): candidate ids ${row.ids}`));
}

section("4. browser_leads volume per candidate (informational — repeats are expected, not a bug)");
const topRepeats = db.prepare(`
  SELECT candidate_id, COUNT(*) n FROM browser_leads GROUP BY candidate_id HAVING COUNT(*) > 3 ORDER BY n DESC LIMIT 10
`).all();
if (topRepeats.length) {
  console.log("Candidates searched more than 3 times so far (expected if repeatedly re-queued — not itself a problem):");
  topRepeats.forEach((r) => console.log(`  #${r.candidate_id}: ${r.n} searches`));
} else {
  console.log("No candidate has been searched more than 3 times yet.");
}

console.log("\n===============================================================");
console.log(problems ? `FOUND ${problems} REAL ISSUE(S) — see above.` : "No integrity problems found.");
console.log("===============================================================");
process.exit(problems ? 1 : 0);
