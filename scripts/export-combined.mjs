import { db } from "../src/db.mjs";
import { toCsv } from "../src/csv.mjs";
import fs from "node:fs";
import path from "node:path";

export function exportCombinedSheet() {
  const combinedPath = path.resolve("exports/hcrhub_all_enriched_combined.csv");
  const columns = [
    "candidate_id", "ahpra_number", "full_name", "profession", "state", "postcode",
    "profile_location", "profile_suburb", "profile_state", "profile_postcode", "profile_location_precision",
    "employer", "current_title", "linkedin_url", "work_email", "email_status",
    "mobile_phone", "international_phone", "identity_status", "match_confidence", "campaign_status",
    "recruiter_notes"
  ];

  const rows = db.prepare(`
    SELECT id candidate_id, ahpra_number, full_name, profession, state, postcode,
           profile_location, profile_suburb, profile_state, profile_postcode, profile_location_precision,
           employer, current_title, linkedin_url, work_email, email_status,
           mobile_phone, international_phone, identity_status, match_confidence, campaign_status,
           recruiter_notes
    FROM candidates
    WHERE identity_status = 'confirmed'
    ORDER BY
      CASE WHEN work_email IS NOT NULL AND work_email <> '' THEN 0 ELSE 1 END,
      id ASC
  `).all();

  fs.mkdirSync(path.dirname(combinedPath), { recursive: true });
  const csvContent = toCsv(rows, columns);
  const latestPath = path.resolve("exports/hcrhub_all_enriched_combined_latest.csv");
  try {
    fs.writeFileSync(latestPath, csvContent, "utf8");
  } catch (e) {}

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      fs.writeFileSync(combinedPath, csvContent, "utf8");
      break;
    } catch (err) {
      if ((err.code === "EBUSY" || err.code === "EPERM") && attempt < 7) {
        const start = Date.now();
        while (Date.now() - start < 100 + Math.random() * 150) {}
        continue;
      }
      // If still locked (e.g. open in Excel), log warning but don't crash caller
      console.warn(`[exportCombinedSheet] Primary CSV locked (e.g. open in Excel), updated ${latestPath} instead`);
      break;
    }
  }
  return { path: combinedPath, latestPath, total: rows.length };
}

if (process.argv[1]?.endsWith("export-combined.mjs")) {
  const res = exportCombinedSheet();
  console.log(`Exported ${res.total} candidates to ${res.path}`);
}
