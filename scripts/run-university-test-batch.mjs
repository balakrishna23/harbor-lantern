import { db } from "../src/db.mjs";
import { verifyCandidateAcademics, buildAcademicSearchQueries } from "../src/academic-resolver.mjs";

console.log("=== RUNNING LIVE UNIVERSITY VERIFICATION BATCH (5 CANDIDATES) ===\n");

// Select 5 candidates with Australian university credentials and no LinkedIn URL
const candidates = db.prepare(`
  SELECT id, full_name, profession, state, postcode, qualifications, recruiter_notes
  FROM candidates
  WHERE (qualifications LIKE '%University of Canberra%' OR qualifications LIKE '%Charles Sturt University%')
    AND (linkedin_url IS NULL OR linkedin_url = '')
    AND workflow_stage = 'manual_review'
  ORDER BY id ASC
  LIMIT 5
`).all();

console.log(`Found ${candidates.length} candidate(s) for live university verification:\n`);

db.exec("BEGIN IMMEDIATE");

try {
  const updateCandidateStmt = db.prepare(`
    UPDATE candidates
    SET recruiter_notes = CASE
          WHEN recruiter_notes IS NOT NULL AND recruiter_notes != '' THEN recruiter_notes || ' | ' || ?
          ELSE ?
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const insertEvidenceStmt = db.prepare(`
    INSERT INTO match_evidence
      (candidate_id, score, confidence_band, reasons_json, conflicts_json, provider, provider_reference, discovered_at)
    VALUES (?, ?, ?, ?, '[]', 'university_academic_search', ?, CURRENT_TIMESTAMP)
  `);

  for (const c of candidates) {
    const { cleanName, primaryQual, queries } = buildAcademicSearchQueries(c);
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`[Candidate #${c.id}] ${c.full_name} (${c.profession})`);
    console.log(`Institution: ${primaryQual?.institution || "N/A"} (${primaryQual?.domain || "N/A"})`);
    console.log(`Degree: ${primaryQual?.degree || "N/A"} (${primaryQual?.year || "N/A"})`);

    console.log(`Searching university domain (${primaryQual?.domain})...`);
    const result = await verifyCandidateAcademics(c);

    console.log(`Outcome: Score = ${result.academicMatchScore}/100, Verified = ${result.isAcademicVerified}`);
    if (result.verifiedUrls.length > 0) {
      console.log(`Verified URLs:`);
      result.verifiedUrls.forEach(u => console.log(`  • ${u}`));
    }
    console.log(`Reasons: ${result.reasons.join(" | ")}`);

    const noteText = result.isAcademicVerified
      ? `Academic Verified: ${result.verifiedUrls[0] || primaryQual?.domain} (Score: ${result.academicMatchScore})`
      : `Academic Search: No direct graduation match found on ${primaryQual?.domain}`;

    updateCandidateStmt.run(noteText, noteText, c.id);

    insertEvidenceStmt.run(
      c.id,
      result.academicMatchScore,
      result.isAcademicVerified ? "high" : "low",
      JSON.stringify(result.reasons),
      result.verifiedUrls[0] || `${primaryQual?.domain}:search`
    );
    console.log(`✅ DB Updated: candidate #${c.id} updated with academic match evidence.`);
  }

  db.exec("COMMIT");
  console.log(`\n🎉 Live University Verification Batch Completed Successfully!`);
} catch (err) {
  db.exec("ROLLBACK");
  console.error("Batch failed, transaction rolled back:", err);
  process.exit(1);
}
