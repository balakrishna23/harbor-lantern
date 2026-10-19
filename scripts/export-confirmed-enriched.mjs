#!/usr/bin/env node
/**
 * Full-detail CSV of every confirmed candidate, including the Clay email
 * enrichment results (work_email/email_status) added 2026-09-30.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.mjs";
import { toCsv } from "../src/csv.mjs";

function readableJsonList(value) {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.join("; ") : String(parsed);
  } catch {
    return String(value);
  }
}

const rows = db.prepare(`
  SELECT id, ahpra_number, full_name, profession, registration_status, registration_type,
         registration_expiry, suburb, state, postcode, qualifications, languages, specialty,
         specialty_fields, linkedin_url, employer, current_title, company_domain,
         identity_status, identity_confidence, identity_match_score, match_confidence,
         match_reasons, work_email, email_status, business_phone, mobile_phone, international_phone,
         contact_basis_approved, suppressed, opted_out, campaign_status, recruiter_notes,
         identity_provider, identity_discovered_at, identity_reviewed_at, updated_at
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY id ASC
`).all();

const columns = [
  "id", "ahpra_number", "full_name", "profession", "registration_status", "registration_type",
  "registration_expiry", "suburb", "state", "postcode", "qualifications", "languages", "specialty",
  "specialty_fields", "linkedin_url", "employer", "current_title", "company_domain",
  "identity_status", "identity_confidence", "identity_match_score", "match_confidence",
  "match_reasons", "work_email", "email_status", "business_phone", "mobile_phone", "international_phone",
  "contact_basis_approved", "suppressed", "opted_out", "campaign_status", "recruiter_notes",
  "identity_provider", "identity_discovered_at", "identity_reviewed_at", "updated_at"
];

const transformed = rows.map((r) => ({ ...r, match_reasons: readableJsonList(r.match_reasons) }));

const csv = toCsv(transformed, columns);
const outPath = path.resolve("exports/HCRHUB_Confirmed_Enriched_Candidates.csv");
fs.writeFileSync(outPath, csv, "utf8");

const withEmail = rows.filter((r) => r.work_email).length;
console.log(`Exported ${rows.length} confirmed candidates (${withEmail} with a work email) to ${outPath}`);
process.exit(0);
