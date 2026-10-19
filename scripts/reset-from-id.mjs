#!/usr/bin/env node
/**
 * Resets every candidate with id >= the given threshold back to a fresh,
 * unprocessed state, discarding whatever the browser agent / academic
 * resolver previously concluded about them (confirmed, manual_review, or
 * unresolved — all of it). Requested after fixing a real gap in the search
 * logic: a Sales Navigator search for a common name could surface the
 * wrong namesake as the top result and never check further candidates or
 * try the university-scoped query tier (see src/browser-agent.mjs's
 * rankCandidateCards + the tier-escalation fix in searchCandidateOnSalesNavigator).
 * Rather than hand-auditing every prior result, everything from this id
 * onward gets re-searched from scratch under the corrected logic.
 *
 * A full database backup is taken automatically before any write (see
 * data/backups/). Run: node scripts/reset-from-id.mjs <id>
 */
import fs from "node:fs";
import path from "node:path";
import { db, audit } from "../src/db.mjs";

const threshold = Number(process.argv[2]);
if (!Number.isInteger(threshold) || threshold < 1) {
  console.error("Usage: node scripts/reset-from-id.mjs <id>  (resets every candidate with id >= <id>)");
  process.exit(1);
}

const backupDir = path.resolve("data/backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `hcrhub-pre-reset-from-${threshold}-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
fs.copyFileSync(path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite"), backupPath);
console.log(`Backup written to ${backupPath}`);

const before = db.prepare(`
  SELECT COUNT(*) total,
    SUM(identity_status = 'confirmed') confirmed,
    SUM(workflow_stage = 'manual_review') manual_review,
    SUM(workflow_stage = 'identity_unresolved') unresolved
  FROM candidates WHERE id >= ?
`).get(threshold);
console.log(`Candidates with id >= ${threshold}: ${before.total} (confirmed: ${before.confirmed}, manual_review: ${before.manual_review}, unresolved: ${before.unresolved})`);

if (!before.total) {
  console.log("Nothing to reset.");
  process.exit(0);
}

db.exec("BEGIN IMMEDIATE");
try {
  const result = db.prepare(`
    UPDATE candidates SET
      workflow_stage = 'source_imported',
      identity_status = 'unreviewed',
      linkedin_url = NULL,
      employer = NULL,
      current_title = NULL,
      identity_match_score = NULL,
      match_confidence = NULL,
      match_reasons = NULL,
      conflicting_evidence = NULL,
      identity_provider = NULL,
      identity_provider_reference = NULL,
      identity_discovered_at = NULL,
      identity_reviewed_at = NULL,
      reviewer_decision = NULL,
      recruiter_notes = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id >= ?
  `).run(threshold);
  audit("candidates.bulk_reset_from_id", "database", "hcrhub.sqlite",
    { threshold, candidatesReset: result.changes, backupPath, reason: "rechecking under corrected multi-candidate search logic" });
  db.exec("COMMIT");
  console.log(`Reset ${result.changes} candidate(s) to source_imported / unreviewed. They are now eligible for fresh discovery.`);
} catch (error) {
  db.exec("ROLLBACK");
  console.error("Reset failed, rolled back:", error);
  process.exit(1);
}
