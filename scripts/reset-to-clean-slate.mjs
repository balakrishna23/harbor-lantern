import { db, audit } from "../src/db.mjs";
import { exportCombinedSheet } from "./export-combined.mjs";
import fs from "node:fs";
import path from "node:path";

console.log("=== EXECUTING CLEAN SLATE DATABASE RESET ===");

// Safety backup — this script deletes every row across 9 enrichment tables
// and resets every candidate with no WHERE clause; always snapshot first.
const backupDir = path.resolve("data/backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `hcrhub-pre-clean-slate-${new Date().toISOString().slice(0, 10)}.sqlite`);
fs.copyFileSync(path.resolve("data/hcrhub.sqlite"), backupPath);
console.log(`[Backup] Preserved current database at ${backupPath}`);

db.exec("PRAGMA foreign_keys = OFF;");
db.exec("BEGIN TRANSACTION;");

try {
  // 1. Clear enrichment tables
  const tablesToClear = [
    "credit_ledger",
    "provider_responses",
    "match_evidence",
    "enrichment_attempts",
    "enrichment_jobs",
    "enrichment_batch_items",
    "enrichment_batches",
    "contact_points",
    "review_history"
  ];

  for (const table of tablesToClear) {
    const res = db.prepare(`DELETE FROM ${table}`).run();
    console.log(`✓ Cleared ${table}: ${res.changes} rows deleted`);
  }

  // 2. Reset all candidate enrichment fields while preserving core AHPRA identity data
  const candidateResult = db.prepare(`
    UPDATE candidates
    SET identity_status = 'unreviewed',
        workflow_stage = 'source_imported',
        campaign_status = 'not_ready',
        linkedin_url = NULL,
        work_email = NULL,
        email_status = 'not_checked',
        mobile_phone = NULL,
        business_phone = NULL,
        international_phone = NULL,
        employer = NULL,
        current_title = NULL,
        identity_confidence = 0,
        identity_match_score = NULL,
        match_confidence = NULL,
        match_reasons = NULL,
        conflicting_evidence = NULL,
        identity_provider = NULL,
        identity_provider_reference = NULL,
        identity_discovered_at = NULL,
        identity_reviewed_at = NULL,
        reviewer_decision = NULL,
        company_domain = NULL,
        contact_basis_approved = 0,
        recruiter_notes = NULL,
        enrichment_source = NULL,
        enriched_at = NULL,
        updated_at = CURRENT_TIMESTAMP
  `).run();

  console.log(`✓ Reset ${candidateResult.changes} candidate records to 'unreviewed' and 'source_imported'`);

  // 3. Record audit log
  audit("clean_slate_reset", "database", "hcrhub.sqlite", {
    candidates_reset: candidateResult.changes,
    timestamp: new Date().toISOString()
  });

  db.exec("COMMIT;");
  db.exec("PRAGMA foreign_keys = ON;");

  // Check foreign key integrity
  const fkErrors = db.prepare("PRAGMA foreign_key_check;").all();
  if (fkErrors.length > 0) {
    console.error("Foreign key check errors found:", fkErrors);
  } else {
    console.log("✓ Foreign key integrity check passed (0 errors)!");
  }

  console.log("\nDatabase transaction committed successfully. Clean slate achieved!");
} catch (err) {
  db.exec("ROLLBACK;");
  db.exec("PRAGMA foreign_keys = ON;");
  console.error("Clean slate reset failed, rolled back:", err);
  process.exit(1);
}

// 4. Update exports
const exportRes = exportCombinedSheet();
console.log(`\nExports refreshed: ${exportRes.path} (${exportRes.total} confirmed candidates)`);
