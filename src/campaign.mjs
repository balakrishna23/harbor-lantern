import { campaignEligibility } from "./domain.mjs";

export function syncCampaignEligibility(db, candidateId) {
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId);
  if (!candidate) return null;
  const eligibility = campaignEligibility(candidate);
  let stage = candidate.workflow_stage;
  if (candidate.opted_out) stage = "opted_out";
  else if (candidate.suppressed) stage = "suppressed";
  else if (eligibility.eligible) stage = "campaign_ready";
  else if (candidate.email_status === "valid") stage = "email_verified";
  else if (stage === "contact_unresolved") stage = "contact_unresolved";
  else if (candidate.identity_status === "confirmed") {
    if (!stage?.startsWith("claiming_") && stage !== "phone_queued" && stage !== "email_queued") {
      stage = "identity_confirmed";
    }
  }
  else if (candidate.identity_status === "rejected") stage = "identity_rejected";
  db.prepare("UPDATE candidates SET campaign_status = ?, workflow_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(eligibility.eligible ? "ready" : "not_ready", stage, candidateId);
  return eligibility;
}

export function campaignReadyRows(db) {
  return db.prepare(`SELECT id candidate_id, ahpra_number, full_name, profession, state, employer,
    current_title, work_email, business_phone, mobile_phone, enrichment_source, enriched_at
    FROM candidates
    WHERE lower(registration_status) = 'registered'
      AND identity_status = 'confirmed'
      AND email_status = 'valid'
      AND contact_basis_approved = 1
      AND suppressed = 0
      AND opted_out = 0
    ORDER BY id`).all();
}
