import { normalizeCandidate } from "./domain.mjs";

/**
 * Inserts parsed source rows (header-keyed objects) for one import: one
 * candidate per registration number, plus every source registration row.
 * A row whose registration number already exists is a duplicate — its
 * registration type is merged onto the existing candidate and its
 * registration row is still kept, but the existing candidate's other fields
 * (location, identity work) are never overwritten.
 *
 * The caller owns the transaction, so the HTTP upload can wrap a whole file
 * and scripts/import-register-jsonl.mjs can commit in chunks.
 */
export function insertCandidateRows(db, importId, rows, { firstSourceRow = 2 } = {}) {
  const insert = db.prepare(`INSERT INTO candidates (
    import_id, source_row, source_hash, ahpra_number, full_name, first_name, middle_name, last_name,
    alternative_name, profession, registration_status, registration_type, registration_expiry, suburb, state, postcode,
    qualifications, languages, specialty, specialty_fields, linkedin_url, employer, current_title, identity_confidence, identity_status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const findCandidate = db.prepare("SELECT id, registration_type FROM candidates WHERE source_hash = ?");
  const addRegistration = db.prepare(`INSERT INTO registrations (
    import_id, candidate_id, source_row, registration_number, registration_status, registration_type,
    registration_expiry, source_record
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateRegistrationTypes = db.prepare("UPDATE candidates SET registration_type = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  let inserted = 0, duplicates = 0, rejected = 0;
  rows.forEach((row, index) => {
    const sourceRow = firstSourceRow + index;
    const c = normalizeCandidate(row);
    if (!c.fullName) { rejected += 1; return; }
    let candidateId;
    try {
      const result = insert.run(importId, sourceRow, c.sourceHash, c.ahpraNumber, c.fullName, c.firstName, c.middleName,
        c.lastName, c.alternativeName, c.profession, c.registrationStatus, c.registrationType, c.registrationExpiry,
        c.suburb, c.state, c.postcode, c.qualifications, c.languages, c.specialty, c.specialtyFields, c.linkedinUrl, c.employer,
        c.currentTitle, c.identityConfidence, c.identityConfidence >= 85 ? "pending_confirmation" : "manual_review");
      candidateId = Number(result.lastInsertRowid);
      inserted += 1;
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint")) {
        duplicates += 1;
        const existing = findCandidate.get(c.sourceHash);
        candidateId = existing.id;
        const types = [...new Set([...(existing.registration_type || "").split("; ").filter(Boolean), c.registrationType].filter(Boolean))];
        updateRegistrationTypes.run(types.join("; "), candidateId);
      }
      else throw error;
    }
    addRegistration.run(importId, candidateId, sourceRow, c.ahpraNumber, c.registrationStatus,
      c.registrationType, c.registrationExpiry, JSON.stringify(row));
  });
  return { inserted, duplicates, rejected };
}
