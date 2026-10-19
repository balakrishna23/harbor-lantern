import { db, audit } from "../src/db.mjs";
import { exportCombinedSheet } from "./export-combined.mjs";

console.log("=== APPLYING DEMOTION OF OVERSEAS MISMATCHED NAMESAKES ===");

const suspectIds = [
  36, 41, 42, 44, 45, 48, 50, 51, 52, 60, 62, 64, 66, 70, 72, 78, 79, 
  83, 84, 86, 92, 95, 98, 100, 102, 103, 105, 107, 108, 110, 111, 116, 
  118, 121, 122, 127, 128
];

console.log(`Target candidates for demotion: ${suspectIds.length}`);

db.exec("BEGIN TRANSACTION");

try {
  const selectStmt = db.prepare("SELECT * FROM candidates WHERE id = ?");
  const updateStmt = db.prepare(`
    UPDATE candidates
    SET identity_status = 'rejected',
        workflow_stage = 'rejected_namesake',
        campaign_status = 'not_ready',
        contact_basis_approved = 0,
        identity_confidence = 0,
        identity_match_score = 0,
        match_confidence = 'rejected',
        reviewer_decision = 'rejected',
        work_email = NULL,
        linkedin_url = NULL,
        employer = NULL,
        current_title = NULL,
        conflicting_evidence = ?,
        recruiter_notes = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  for (const id of suspectIds) {
    const prev = selectStmt.get(id);
    if (!prev) {
      console.warn(`Candidate #${id} not found, skipping.`);
      continue;
    }

    const conflictData = JSON.stringify([{
      type: "overseas_mismatch",
      previous_linkedin: prev.linkedin_url,
      previous_email: prev.work_email,
      quarantined_intl_phone: prev.international_phone,
      previous_employer: prev.employer,
      reason: "Foreign phone or overseas corporate domain does not match Australian nursing institution"
    }]);

    const reasonNote = `Rejected: Overseas namesake mismatch. Previous matched profile (${prev.linkedin_url || 'N/A'}, ${prev.work_email || prev.international_phone || 'foreign entity'}) was determined to be an overseas namesake and does not match the candidate's Australian nursing qualification/institution.`;

    updateStmt.run(conflictData, reasonNote, id);

    audit("demote_overseas_namesake", "candidates", id, {
      full_name: prev.full_name,
      previous_linkedin: prev.linkedin_url,
      previous_email: prev.work_email,
      international_phone: prev.international_phone
    });

    console.log(`✓ Demoted #${id}: ${prev.full_name} (was: ${prev.linkedin_url})`);
  }

  db.exec("COMMIT");
  console.log("\nTransaction committed successfully!");
} catch (err) {
  db.exec("ROLLBACK");
  console.error("Failed to apply demotions, transaction rolled back:", err);
  process.exit(1);
}

// Verify counts in DB
const remainingConfirmed = db.prepare("SELECT COUNT(*) as count FROM candidates WHERE identity_status = 'confirmed'").get();
const totalRejected = db.prepare("SELECT COUNT(*) as count FROM candidates WHERE identity_status = 'rejected'").get();

console.log("\n=== POST-DEMOTION DATABASE STATUS ===");
console.log(`• Remaining Confirmed Candidates : ${remainingConfirmed.count}`);
console.log(`• Total Rejected Candidates     : ${totalRejected.count}`);

// Re-export combined sheet
const exportResult = exportCombinedSheet();
console.log(`\nClean export generated: ${exportResult.path} (${exportResult.total} confirmed candidates)`);
console.log(`Latest mirror generated: ${exportResult.latestPath}`);
