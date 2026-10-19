import fs from "node:fs";
import path from "node:path";
import { db as defaultDb } from "../src/db.mjs";
import { toCsv } from "../src/csv.mjs";

export function exportConfirmedCheckpoint(db = defaultDb, targetPath = "exports/hcrhub_enriched_checkpoint.csv") {
  const outputPath = path.resolve(targetPath);
  const columns = [
    "candidate_id", "ahpra_number", "full_name", "profession", "state", "postcode",
    "linkedin_url", "employer", "current_title", "identity_status", "match_confidence",
    "work_email", "email_status", "business_phone", "mobile_phone", "enrichment_source",
    "enriched_at", "contact_basis_approved", "campaign_status", "recruiter_notes"
  ];
  const rows = db.prepare(`
    SELECT id candidate_id, ahpra_number, full_name, profession, state, postcode,
           linkedin_url, employer, current_title, identity_status, match_confidence, work_email, email_status,
           business_phone, mobile_phone, enrichment_source, enriched_at, contact_basis_approved, campaign_status,
           recruiter_notes
    FROM candidates
    WHERE identity_status = 'confirmed'
    ORDER BY id
  `).all();

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const csvContent = toCsv(rows, columns);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.writeFileSync(outputPath, csvContent, "utf8");
      break;
    } catch (err) {
      if ((err.code === "EBUSY" || err.code === "EPERM") && attempt < 7) {
        const start = Date.now();
        while (Date.now() - start < 100 + Math.random() * 150) {}
        continue;
      }
      console.warn(`[exportConfirmedCheckpoint] Warning: could not write ${outputPath}: ${err.message}`);
      break;
    }
  }
  return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/export-checkpoint.mjs")) {
  const out = exportConfirmedCheckpoint();
  console.log(`Exported confirmed candidates to ${out}`);
}
