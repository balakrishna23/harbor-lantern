import crypto from 'node:crypto';
import { hasHardIdentityConflict } from './domain.mjs';
import { linkedinProfileUrl, isRegisteredRn } from './location-sheet-match.mjs';
import { verifySchoolEvidence } from './school-verification.mjs';

/** One atomic, idempotent evidence/check/candidate update per profile. Ambiguous
 * findings never change an existing identity. Register and contact facts remain
 * separate from observed profile identity. */
export function persistSchoolVerification(db, { runId, registerImportId, profile, evidence }) {
  const verification = verifySchoolEvidence(profile, evidence);
  const payload = JSON.stringify({ evidence, checks: verification.checks });
  const hash = crypto.createHash('sha256').update(payload).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT database_status, reason, candidate_id, evidence_hash FROM school_verification_checks WHERE run_id=? AND profile_id=?').get(runId, profile.id);
    if (previous?.evidence_hash === hash) {
      db.exec('COMMIT');
      return { verification, databaseWrite: { status: previous.database_status, reason: previous.reason, candidateId: previous.candidate_id, duplicate: true } };
    }
    let status = 'evidence_saved', reason = verification.reason;
    const candidateId = verification.candidateId || null;
    if (verification.status === 'confirmed') {
      const candidate = db.prepare('SELECT * FROM candidates WHERE id=?').get(candidateId);
      const chosen = profile.candidates.find(c => c.candidateId === candidateId);
      const registrations = db.prepare('SELECT registration_number, registration_status, registration_type, source_record FROM registrations WHERE candidate_id=? AND import_id=?').all(candidateId, registerImportId);
      const eligible = registrations.some(r => r.registration_number === chosen?.registrationNumber && isRegisteredRn({
        registrationStatus: r.registration_status, registrationType: r.registration_type,
        profession: Object.entries(JSON.parse(r.source_record)).find(([key]) => key.trim().toLowerCase() === 'profession')?.[1]
      }));
      const finalUrl = linkedinProfileUrl(evidence.finalUrl?.replace(/\/details\/education\/?(?:\?.*)?$/, '')) || profile.url;
      const acceptedUrls = new Set([profile.url, finalUrl]);
      const existingUrl = linkedinProfileUrl(candidate?.linkedin_url);
      const urlOwner = db.prepare('SELECT id FROM candidates WHERE id<>? AND linkedin_url IN (?, ?) LIMIT 1').get(candidateId, profile.url, finalUrl);
      if (!candidate || !eligible) { status = 'review_required'; reason = 'Registration eligibility could not be revalidated against the source extract'; }
      else if (candidate.identity_status === 'rejected' || hasHardIdentityConflict(candidate)) { status = 'review_required'; reason = 'Existing rejection or hard identity conflict requires recruiter review'; }
      else if (candidate.linkedin_url && !acceptedUrls.has(existingUrl) || urlOwner) { status = 'review_required'; reason = 'Existing profile assignment conflicts with this finding'; }
      else {
        const reasons = [verification.reason, ...verification.checks.filter(c => c.candidateId === candidateId).flatMap(c => c.pairs.map(p => `Register school ${p.register.school}${p.register.year ? ` (${p.register.year})` : ''}; LinkedIn ${p.profile.school}${p.profile.endYear ? ` (${p.profile.endYear})` : ''}`))];
        const notes = `LinkedIn school verification run ${runId}: ${reasons.join('; ')}`;
        db.prepare(`UPDATE candidates SET identity_status='confirmed',
          workflow_stage=CASE WHEN suppressed=1 THEN 'suppressed' WHEN opted_out=1 THEN 'opted_out' WHEN identity_status='confirmed' THEN workflow_stage ELSE 'identity_confirmed' END,
          linkedin_url=?, match_confidence='high', match_reasons=?, identity_provider='linkedin_school_verifier', identity_provider_reference=?,
          identity_discovered_at=CURRENT_TIMESTAMP, identity_reviewed_at=CURRENT_TIMESTAMP, reviewer_decision='confirmed',
          recruiter_notes=CASE WHEN COALESCE(recruiter_notes,'')='' THEN ? ELSE recruiter_notes || char(10) || ? END,
          updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(finalUrl, JSON.stringify(reasons), finalUrl, notes, notes, candidateId);
        db.prepare("INSERT INTO review_history(candidate_id, decision, notes, reviewer) VALUES (?, 'confirmed', ?, 'LinkedIn school verifier')").run(candidateId, notes);
        db.prepare("INSERT INTO match_evidence(candidate_id, confidence_band, reasons_json, provider, provider_reference) VALUES (?, 'high', ?, 'linkedin_school_verifier', ?)").run(candidateId, JSON.stringify(reasons), finalUrl);
        db.prepare("INSERT INTO audit_log(action,entity_type,entity_id,details) VALUES ('candidate.school_verified','candidate',?,?)").run(String(candidateId), JSON.stringify({ runId, profileId: profile.id, registerImportId, profileUrl: finalUrl }));
        status = 'candidate_updated';
      }
    }
    db.prepare(`INSERT INTO school_verification_checks(run_id,profile_id,register_import_id,candidate_id,decision,database_status,reason,profile_url,evidence_hash,evidence_json,checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,profile_id) DO UPDATE SET
      candidate_id=excluded.candidate_id,decision=excluded.decision,database_status=excluded.database_status,reason=excluded.reason,
      profile_url=excluded.profile_url,evidence_hash=excluded.evidence_hash,evidence_json=excluded.evidence_json,checked_at=excluded.checked_at,updated_at=CURRENT_TIMESTAMP`)
      .run(runId, profile.id, registerImportId, candidateId, verification.status, status, reason, profile.url, hash, payload, verification.checkedAt);
    db.exec('COMMIT');
    return { verification, databaseWrite: { status, reason, candidateId } };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
