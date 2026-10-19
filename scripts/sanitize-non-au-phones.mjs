import { db } from "../src/db.mjs";
import { parseAndValidatePhone } from "../src/phone-validator.mjs";
import { syncCampaignEligibility } from "../src/campaign.mjs";

console.log("=== SANITIZING NON-AUSTRALIAN PHONE NUMBERS ===");

const candidates = db.prepare(`
  SELECT id, full_name, mobile_phone, business_phone, international_phone
  FROM candidates
  WHERE (mobile_phone IS NOT NULL AND mobile_phone != '')
     OR (business_phone IS NOT NULL AND business_phone != '')
`).all();

console.log(`Auditing ${candidates.length} candidates with phone data...`);

let auRetained = 0;
let quarantined = 0;

db.exec("BEGIN IMMEDIATE");

try {
  const updateStmt = db.prepare(`
    UPDATE candidates
    SET mobile_phone = ?,
        business_phone = ?,
        international_phone = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  for (const c of candidates) {
    let newMobile = null;
    let newBusiness = null;
    let intlPhone = c.international_phone || null;

    if (c.mobile_phone) {
      const parsed = parseAndValidatePhone(c.mobile_phone);
      if (parsed.isValidAu) {
        newMobile = parsed.normalized;
        auRetained++;
      } else {
        intlPhone = intlPhone || parsed.raw;
        quarantined++;
        console.log(`[Candidate #${c.id}] ${c.full_name}: Quarantining non-AU mobile ${parsed.raw}`);
      }
    }

    if (c.business_phone) {
      const parsed = parseAndValidatePhone(c.business_phone);
      if (parsed.isValidAu) {
        newBusiness = parsed.normalized;
      } else {
        intlPhone = intlPhone || parsed.raw;
      }
    }

    updateStmt.run(newMobile, newBusiness, intlPhone, c.id);
  }

  // Deactivate non-AU phones in contact_points table too
  const allPoints = db.prepare(`SELECT id, candidate_id, kind, contact_value FROM contact_points WHERE kind IN ('mobile_phone', 'business_phone') AND active = 1`).all();
  for (const cp of allPoints) {
    const parsed = parseAndValidatePhone(cp.contact_value);
    if (!parsed.isValidAu) {
      db.prepare("UPDATE contact_points SET active = 0, verification_status = 'quarantined_non_au' WHERE id = ?").run(cp.id);
    } else {
      db.prepare("UPDATE contact_points SET contact_value = ? WHERE id = ?").run(parsed.normalized, cp.id);
    }
  }

  db.exec("COMMIT");
  console.log(`\nSanitization Complete:`);
  console.log(`- Australian phones retained: ${auRetained}`);
  console.log(`- Non-AU phones quarantined: ${quarantined}`);
} catch (e) {
  db.exec("ROLLBACK");
  console.error("Sanitization failed:", e);
  process.exit(1);
}

// Re-sync campaign eligibility
const remaining = db.prepare(`SELECT id FROM candidates WHERE identity_status = 'confirmed'`).all();
for (const r of remaining) {
  syncCampaignEligibility(db, r.id);
}
console.log("Campaign eligibility re-synchronized.");
