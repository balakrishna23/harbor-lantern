import crypto from "node:crypto";
import { formatStructuredReviewNotes, scoreIdentityMatch } from "./domain.mjs";
import { primaryAustralianQualification } from "./qualification-parser.mjs";

const honorificRegex = /^(Dr|Mr|Mrs|Ms|Miss|Prof|Sir|Mx)\s+/i;
export const cleanCandidateName = (name) => String(name || "").replace(honorificRegex, "").trim();

/**
 * The WHERE clause claimCandidates uses, exported so anything that counts
 * "work remaining" (scripts/auto-run-browser-agent.mjs) uses the exact same
 * eligibility instead of a hand-maintained copy — two copies drifting apart
 * once kept the auto-runner spinning on 2 unclaimable candidates for an hour.
 */
export function claimEligibility({
  sourceStage = ["source_imported", "manual_review"],
  cohort = null,
  profession = null,
  needsLinkedIn = true,
  excludeBrowserAgentAttempted = false,
  attemptedSince = null
} = {}) {
  const conditions = ["registration_status = 'Registered'"];
  const params = [];

  if (needsLinkedIn) {
    conditions.push("(linkedin_url IS NULL OR linkedin_url = '')");
  }

  // A manual_review candidate whose lead wasn't corroborated enough to
  // attach (linkedin_url stays null) is otherwise re-claimed on every future
  // batch forever, with no bound — confirmed live: 320 candidates
  // re-searched 2-24 times each, 1,188 wasted searches out of 8,296 total,
  // for no benefit (same non-corroborated outcome each time). Matches the
  // existing identity_unresolved convention: one real attempt, then it sits
  // until a deliberate requeue, not an automatic one.
  //
  // attemptedSince scopes that "one attempt" to a search round instead of
  // all time: only a browser_leads row created at/after it counts. Used for
  // the 2026-10-13 re-search, after most of the original round turned out to
  // have run while search was silently broken.
  if (excludeBrowserAgentAttempted) {
    if (attemptedSince) {
      conditions.push("NOT EXISTS (SELECT 1 FROM browser_leads bl WHERE bl.candidate_id = candidates.id AND bl.created_at >= ?)");
      params.push(attemptedSince);
    } else {
      conditions.push("NOT EXISTS (SELECT 1 FROM browser_leads bl WHERE bl.candidate_id = candidates.id)");
    }
  }

  if (sourceStage) {
    if (Array.isArray(sourceStage)) {
      conditions.push(`workflow_stage IN (${sourceStage.map(() => "?").join(",")})`);
      params.push(...sourceStage);
    } else {
      conditions.push("workflow_stage = ?");
      params.push(sourceStage);
    }
  }
  if (cohort) {
    conditions.push("state = ?");
    params.push(cohort.toUpperCase());
  }
  if (profession) {
    conditions.push("profession = ?");
    params.push(profession);
  }
  return { whereClause: conditions.join(" AND "), params };
}

/**
 * Claim options for the Sales Navigator browser agent, shared by the batch
 * runner (claims) and the auto-runner (counts what's left). With a round
 * timestamp, identity_unresolved candidates are eligible again — once each.
 */
export function browserDiscoveryClaimOptions(attemptedSince = null) {
  return {
    sourceStage: attemptedSince ? ["source_imported", "manual_review", "identity_unresolved"] : ["source_imported", "manual_review"],
    needsLinkedIn: true,
    excludeBrowserAgentAttempted: true,
    attemptedSince
  };
}

/**
 * Atomically claim candidates from SQLite to avoid race conditions between parallel workers.
 */
export function claimCandidates(db, { claimingStage = "claiming_discovery", limit = 10, ...eligibility } = {}) {
  const { whereClause, params } = claimEligibility(eligibility);

  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare(`
      SELECT id, full_name, first_name, last_name, profession, state, suburb, postcode,
             qualifications, linkedin_url, workflow_stage, identity_status
      FROM candidates
      WHERE ${whereClause}
      ORDER BY id ASC
      LIMIT ?
    `).all(...params, limit);

    if (rows.length > 0) {
      const placeholders = rows.map(() => "?").join(",");
      db.prepare(`
        UPDATE candidates
        SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id IN (${placeholders})
      `).run(claimingStage, ...rows.map((r) => r.id));
    }

    db.exec("COMMIT");
    return rows;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Discovery Worker: Resolves LinkedIn URLs for claimed candidates.
 */
export async function runDiscoveryBatch(db, candidates, { clayClient = null, dryRun = false } = {}) {
  const results = [];
  if (!candidates.length) return results;

  for (const candidate of candidates) {
    const cleanedName = cleanCandidateName(candidate.full_name);
    let linkedinUrl = candidate.linkedin_url || null;
    let providerReference = null;

    if (!linkedinUrl && clayClient && !dryRun) {
      try {
        const subroutineId = "t_0tli15n295wEtwgVEN5"; // Person LinkedIn URL
        const auQual = primaryAustralianQualification(candidate.qualifications);
        const institution = auQual?.institution;
        const uniDomain = auQual?.domain;
        const companyName = candidate.employer || institution || "Canberra Health Services";
        const companyDomain = uniDomain || (candidate.employer ? null : "canberra.edu.au");

        const payload = {
          "Full name": cleanedName,
          "Country location": "Australia",
          "Existing job title": candidate.profession || "Registered Nurse",
          "Company name": companyName,
          "Company domain": companyDomain
        };

        const runRes = await clayClient.runSubroutineDirect(subroutineId, [payload]);
        const task = JSON.parse(runRes?.content?.[0]?.text || "{}");
        const entity = task.entities?.[0];
        const enrichments = Object.values(entity?.enrichments || {})[0];
        const val = typeof enrichments?.value === "string" ? JSON.parse(enrichments.value || "{}") : enrichments?.value || {};
        linkedinUrl = val?.["LinkedIn URL"] || val?.url || null;
        providerReference = task.taskId || null;
      } catch (err) {
        // Log and continue to preserve worker resilience
        console.error(`Discovery error for candidate ${candidate.id}:`, err.message);
      }
    }

    if (linkedinUrl) {
      db.prepare(`
        UPDATE candidates
        SET linkedin_url = ?, workflow_stage = 'identity_discovered',
            identity_provider = 'clay_mcp', identity_provider_reference = ?,
            identity_discovered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(linkedinUrl, providerReference, candidate.id);

      results.push({ candidateId: candidate.id, linkedinUrl, status: "discovered" });
    } else {
      // Mark as identity_unresolved so discovery progresses across other candidates
      db.prepare(`
        UPDATE candidates
        SET workflow_stage = 'identity_unresolved', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(candidate.id);
      results.push({ candidateId: candidate.id, linkedinUrl: null, status: "not_found" });
    }
  }

  return results;
}

/**
 * Verification Worker: Deterministically scores discovered candidates and routes
 * them to a decision band. A high score with zero conflicts is strong automated
 * evidence, but it is not a human's decision — it is routed to
 * "pending_confirmation" so a recruiter still confirms the match through the
 * review UI/API before contact enrichment or campaign export can use it. This
 * worker must never itself set identity_status to "confirmed"; doing so let an
 * automated scoring pass make an irreversible contact decision unsupervised,
 * which is how a batch of overseas namesakes previously reached "confirmed"
 * status on phone/location evidence the scorer didn't check until later.
 */
export function runVerificationBatch(db, candidateIds = [], thresholds = { high: 85, manual: 60 }) {
  const ids = candidateIds.length > 0 ? candidateIds : [];
  const query = ids.length > 0
    ? `SELECT * FROM candidates WHERE id IN (${ids.map(() => "?").join(",")})`
    : `SELECT * FROM candidates WHERE workflow_stage = 'identity_discovered'`;

  const candidates = db.prepare(query).all(...ids);
  const evaluated = [];

  for (const candidate of candidates) {
    const mockResult = {
      fullName: cleanCandidateName(candidate.full_name),
      profession: candidate.profession,
      state: candidate.state,
      postcode: candidate.postcode,
      qualifications: candidate.qualifications,
      linkedinUrl: candidate.linkedin_url,
      employer: candidate.employer,
      currentTitle: candidate.current_title
    };

    const match = scoreIdentityMatch(candidate, mockResult, thresholds);
    let decision = "manual_review";
    let workflowStage = candidate.linkedin_url ? "manual_review" : "identity_unresolved";
    let contactBasisApproved = 0;

    const tags = [];
    if (match.score >= thresholds.high && match.conflicts.length === 0 && candidate.linkedin_url) {
      // Never auto-confirm: a recruiter must review and confirm via
      // /api/candidates/:id/review (or the AI-recruiter review endpoint) before
      // this becomes "confirmed" and unlocks contact enrichment/campaign export.
      decision = "pending_confirmation";
      workflowStage = "pending_confirmation";
      tags.push("name:exact", "role:rn", `loc:${candidate.state || "ACT"}`);
      if (candidate.qualifications) tags.push("edu:degree");
    } else if (match.score < thresholds.manual) {
      decision = "rejected";
      workflowStage = "identity_rejected";
    }

    const notes = formatStructuredReviewNotes({
      decision,
      tags,
      customNote: match.reasons.join("; ")
    });

    db.prepare(`
      UPDATE candidates
      SET identity_status = ?, workflow_stage = ?, identity_match_score = ?,
          match_confidence = ?, contact_basis_approved = ?, recruiter_notes = ?,
          reviewer_decision = ?, identity_reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(decision, workflowStage, match.score, match.confidence, contactBasisApproved, notes, decision, candidate.id);

    db.prepare(`
      INSERT INTO review_history (candidate_id, decision, match_score, notes, reviewer)
      VALUES (?, ?, ?, ?, 'Autonomous Verification Worker')
    `).run(candidate.id, decision, match.score, notes);

    evaluated.push({
      candidateId: candidate.id,
      score: match.score,
      confidence: match.confidence,
      decision,
      workflowStage
    });
  }

  return evaluated;
}

/**
 * Supervisor: Recovers timed-out leases and tracks pipeline throughput.
 */
export function runSupervisorCheck(db, { leaseTimeoutMinutes = 10 } = {}) {
  // Free any jobs stuck in claiming states longer than leaseTimeoutMinutes
  const staleClaimed = db.prepare(`
    UPDATE candidates
    SET workflow_stage = 'source_imported', updated_at = CURRENT_TIMESTAMP
    WHERE workflow_stage LIKE 'claiming_%'
      AND updated_at < datetime('now', '-' || ? || ' minutes')
  `).run(leaseTimeoutMinutes);

  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_candidates,
      SUM(CASE WHEN registration_status = 'Registered' THEN 1 ELSE 0 END) AS registered,
      SUM(CASE WHEN linkedin_url IS NOT NULL AND linkedin_url <> '' THEN 1 ELSE 0 END) AS with_linkedin,
      SUM(CASE WHEN identity_status = 'confirmed' THEN 1 ELSE 0 END) AS identity_confirmed,
      SUM(CASE WHEN email_status = 'valid' THEN 1 ELSE 0 END) AS email_verified,
      SUM(CASE WHEN mobile_phone IS NOT NULL AND mobile_phone <> '' THEN 1 ELSE 0 END) AS with_phone,
      SUM(CASE WHEN campaign_status = 'ready' THEN 1 ELSE 0 END) AS campaign_ready
    FROM candidates
  `).get();

  return {
    staleRecovered: staleClaimed.changes,
    stats
  };
}
