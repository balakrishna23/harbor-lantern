import { toCsv } from "../csv.mjs";

/**
 * CRM-ready contact sheet. Column names follow what CRM importers
 * (HubSpot, Bullhorn, JobAdder, Salesforce) map automatically, so the same
 * file works whichever CRM is chosen. "OK to Email" carries the Spam Act
 * guardrail from the engine — a CRM push must only send rows marked Yes.
 */
export const CRM_COLUMNS = [
  "First Name", "Last Name", "Email", "Email Confidence", "Email Check", "Email Source", "OK to Email",
  "Job Title", "Company", "LinkedIn URL", "State", "Postcode",
  "Registration Number", "Registration Type", "HCRHUB ID"
];

const CONFIDENCE_LABEL = { verified: "Verified by mail server", strong: "High", moderate: "Medium", weak: "Low", none: "", provider: "From provider" };
const CHECK_LABEL = {
  unverified: "Not checked", valid: "Valid (provider check)", invalid: "Invalid (provider check)",
  accepted: "Accepted", rejected: "Rejected", catch_all: "Domain accepts any address", unknown: "Server gave no answer",
  unverifiable: "Not checked (port 25 blocked)", not_checked: "Not checked", no_mx: "Domain has no mail server"
};
const SOURCE_LABEL = {
  derived_from_format: "Built from employer's email format",
  published: "Published by the person",
  provider: "Found by a data provider (Clay)"
};

// Our own findings, plus work emails already held from a provider (the
// September Clay run) for anyone the engine didn't cover. A provider address's
// origin is unknown, so it isn't marked OK to email either.
export function crmRows(db) {
  return db.prepare(`
    WITH emails AS (
      SELECT candidate_id, email, confidence, verification, source, may_email FROM email_findings WHERE email IS NOT NULL
      UNION ALL
      SELECT cp.candidate_id, cp.contact_value, 'provider', COALESCE(cp.verification_status, 'not_checked'), 'provider', 0
        FROM contact_points cp
       WHERE cp.kind = 'work_email' AND cp.active = 1
         AND NOT EXISTS (SELECT 1 FROM email_findings f WHERE f.candidate_id = cp.candidate_id AND f.email IS NOT NULL)
    )
    SELECT c.id, c.first_name, c.last_name, c.current_title, c.employer, c.linkedin_url,
      COALESCE(NULLIF(c.state, ''), c.profile_state) state, COALESCE(NULLIF(c.postcode, ''), c.profile_postcode) postcode,
      c.ahpra_number, c.registration_type, e.email, e.confidence, e.verification, e.source, e.may_email
    FROM emails e JOIN candidates c ON c.id = e.candidate_id
    ORDER BY c.id`).all()
    .map((row) => ({
      "First Name": row.first_name, "Last Name": row.last_name, "Email": row.email,
      "Email Confidence": CONFIDENCE_LABEL[row.confidence] ?? row.confidence,
      "Email Check": CHECK_LABEL[row.verification] ?? row.verification,
      "Email Source": SOURCE_LABEL[row.source] ?? row.source ?? "",
      "OK to Email": row.may_email ? "Yes" : "No",
      "Job Title": row.current_title, "Company": row.employer, "LinkedIn URL": row.linkedin_url,
      "State": row.state, "Postcode": row.postcode,
      "Registration Number": row.ahpra_number, "Registration Type": row.registration_type, "HCRHUB ID": row.id
    }));
}

export function crmCsv(db) {
  const rows = crmRows(db);
  return { csv: toCsv(rows, CRM_COLUMNS), count: rows.length };
}
