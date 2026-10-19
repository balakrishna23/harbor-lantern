import { campaignEligibility } from "./domain.mjs";

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function candidateFilter(searchParams) {
  const search = (searchParams.get("search") || "").trim();
  const status = searchParams.get("status") || "";
  const state = searchParams.get("state") || "";
  const where = [];
  const params = [];
  if (search) {
    where.push("(c.full_name LIKE ? OR c.ahpra_number LIKE ? OR c.profession LIKE ? OR c.employer LIKE ?)");
    const value = `%${search}%`;
    params.push(value, value, value, value);
  }
  if (status) {
    where.push("c.identity_status = ?");
    params.push(status);
  }
  if (state) {
    where.push("c.state = ?");
    params.push(state.toUpperCase());
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function listCandidates(db, searchParams) {
  const page = positiveInteger(searchParams.get("page"), 1, 1_000_000);
  const pageSize = positiveInteger(searchParams.get("pageSize"), 50, 100);
  const { clause, params } = candidateFilter(searchParams);
  const total = db.prepare(`SELECT COUNT(*) count FROM candidates c ${clause}`).get(...params).count;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * pageSize;
  const candidates = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.candidate_id = c.id) registration_count
    FROM candidates c ${clause}
    ORDER BY c.id DESC LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);
  return {
    candidates,
    pagination: { page: currentPage, pageSize, total, totalPages }
  };
}

export function candidateDetail(db, candidateId) {
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId);
  if (!candidate) return null;
  return {
    candidate,
    campaignEligibility: campaignEligibility(candidate),
    registrations: db.prepare(`SELECT id, source_row, registration_number, registration_status,
      registration_type, registration_expiry, created_at
      FROM registrations WHERE candidate_id = ? ORDER BY id`).all(candidateId),
    matchEvidence: db.prepare("SELECT * FROM match_evidence WHERE candidate_id = ? ORDER BY id DESC LIMIT 20").all(candidateId),
    reviewHistory: db.prepare("SELECT * FROM review_history WHERE candidate_id = ? ORDER BY id DESC LIMIT 50").all(candidateId),
    suppressionHistory: db.prepare("SELECT * FROM suppression_history WHERE candidate_id = ? ORDER BY id DESC LIMIT 50").all(candidateId),
    contactPoints: db.prepare(`SELECT id, kind, verification_status, provider, provider_reference,
      enriched_at, active, created_at FROM contact_points WHERE candidate_id = ? ORDER BY id DESC LIMIT 50`).all(candidateId),
    enrichmentJobs: db.prepare(`SELECT id, batch_id, kind, provider, status, dry_run, estimated_credits,
      actual_credits, error_code, error_message, created_at, completed_at
      FROM enrichment_jobs WHERE candidate_id = ? ORDER BY id DESC LIMIT 50`).all(candidateId),
    // Browser-agent finds that were too weak to auto-attach to linkedin_url
    // (see applyBrowserLeadDecision's hasSufficientEvidence gate) still get
    // logged here so a human reviewer can see and judge them, instead of the
    // find being invisible just because it wasn't confident enough to act on
    // automatically.
    suggestedLeads: db.prepare(`SELECT id, linkedin_url, matched_full_name, headline, employer,
      current_title, location, education_snippet, created_at
      FROM browser_leads WHERE candidate_id = ? AND status = 'found' ORDER BY id DESC LIMIT 10`).all(candidateId)
  };
}
