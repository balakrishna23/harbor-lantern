/**
 * Academic & University Website Resolver
 * Searches official Australian university (.edu.au) websites, graduation lists,
 * and regional ACT healthcare portals to authoritatively verify candidate identities.
 */

import { parseCandidateQualifications, primaryAustralianQualification } from "./qualification-parser.mjs";

export function buildAcademicSearchQueries(candidate) {
  const cleanName = String(candidate.full_name || "")
    .replace(/^(Dr|Mr|Mrs|Ms|Miss)\s+/i, "")
    .trim();

  const primaryQual = primaryAustralianQualification(candidate.qualifications);
  const queries = [];

  if (primaryQual && primaryQual.domain) {
    // Exact domain query targeting the candidate's specific Australian university
    queries.push({
      type: "university_domain",
      domain: primaryQual.domain,
      institution: primaryQual.institution,
      query: `site:${primaryQual.domain} "${cleanName}"`
    });

    // Degree + university query
    if (primaryQual.degree) {
      queries.push({
        type: "university_degree",
        domain: primaryQual.domain,
        institution: primaryQual.institution,
        query: `site:${primaryQual.domain} "${cleanName}" "${primaryQual.degree}"`
      });
    }
  }

  // Broad, domain-unrestricted query — catches hospital staff pages, nursing
  // association directories, and anywhere else a name might surface that
  // isn't a university/government domain. Uses the candidate's own licensed
  // location when known, falling back to ACT/Australia generically.
  const locationTerms = [candidate.suburb, candidate.state, "Canberra", "ACT", "Australia"].filter(Boolean);
  queries.push({
    type: "broad_web",
    domain: null,
    query: `"${cleanName}" ("Registered Nurse" OR "Bachelor of Nursing") (${[...new Set(locationTerms)].map((t) => `"${t}"`).join(" OR ")})`
  });

  return { cleanName, primaryQual, queries };
}

/**
 * Searches DuckDuckGo HTML for a query without external API keys.
 */
export async function searchAcademicWeb(query, fetchImpl = fetch) {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;

  try {
    const res = await fetchImpl(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!res.ok) return [];
    const text = await res.text();

    const results = [];
    const snippetMatches = [...text.matchAll(/<a class="result__url"[^>]*href="([^"]+)"[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];

    for (const match of snippetMatches) {
      let href = match[1];
      // Decode DuckDuckGo redirect URL
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) href = decodeURIComponent(uddg[1]);
      const snippet = match[2].replace(/<[^>]+>/g, "").trim();

      results.push({ url: href, snippet });
    }

    return results;
  } catch (err) {
    return [];
  }
}

/**
 * Evaluates academic search results against candidate facts.
 */
export function scoreAcademicEvidence(candidate, searchResults, primaryQual) {
  const cleanName = String(candidate.full_name || "").replace(/^(Dr|Mr|Mrs|Ms|Miss)\s+/i, "").toLowerCase();
  const nameParts = cleanName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0];
  const lastName = nameParts[nameParts.length - 1];

  let score = 0;
  const verifiedUrls = [];
  const reasons = [];

  for (const item of searchResults) {
    const lowerUrl = (item.url || "").toLowerCase();
    const lowerSnippet = (item.snippet || "").toLowerCase();

    // Check if name is in snippet or URL
    const hasFirstName = firstName && (lowerSnippet.includes(firstName) || lowerUrl.includes(firstName));
    const hasLastName = lastName && (lowerSnippet.includes(lastName) || lowerUrl.includes(lastName));
    if (!hasFirstName || !hasLastName) continue;

    // Check domain authority
    const isEduAu = lowerUrl.includes(".edu.au");
    const isGovAu = lowerUrl.includes(".gov.au");
    const matchesTargetDomain = primaryQual?.domain && lowerUrl.includes(primaryQual.domain);

    if (matchesTargetDomain) {
      score = Math.max(score, 100);
      verifiedUrls.push(item.url);
      reasons.push(`Authoritative match on official candidate university domain (${primaryQual.domain})`);
    } else if (isEduAu) {
      score = Math.max(score, 90);
      verifiedUrls.push(item.url);
      reasons.push("Match on official Australian educational institution (.edu.au)");
    } else if (isGovAu) {
      score = Math.max(score, 85);
      verifiedUrls.push(item.url);
      reasons.push("Match on Australian government/health portal (.gov.au)");
    } else if (lowerSnippet.includes("nurse") || lowerSnippet.includes("hospital") || lowerSnippet.includes("health")) {
      score = Math.max(score, 70);
      verifiedUrls.push(item.url);
      reasons.push("Relevant healthcare mention linked to candidate name");
    }
  }

  return {
    academicMatchScore: score,
    isAcademicVerified: score >= 85,
    verifiedUrls: [...new Set(verifiedUrls)],
    reasons: [...new Set(reasons)]
  };
}

/**
 * Writes the auto-confirm decision for a successful academic-web verification
 * (university/.edu.au/.gov.au evidence, no Sales Navigator or Clay lookup
 * involved). Shared by swarm-orchestrator.mjs's academic-verification engine
 * and the browser agent's "check other places" fallback, so both write the
 * exact same field convention instead of maintaining two copies of this
 * UPDATE. Only called when result.isAcademicVerified is true.
 */
export function applyAcademicVerificationDecision(db, candidate, result, audit = () => {}) {
  const primaryUrl = result.verifiedUrls[0] || null;
  const notes = `Academic & University Verified: ${result.reasons.join("; ")}`;
  db.prepare(`
    UPDATE candidates
    SET identity_status = 'confirmed',
        workflow_stage = 'identity_confirmed',
        identity_match_score = ?,
        match_confidence = 'high',
        identity_provider = 'academic_resolver',
        identity_provider_reference = ?,
        match_reasons = ?,
        recruiter_notes = ?,
        reviewer_decision = 'confirmed',
        identity_reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(result.academicMatchScore, primaryUrl, JSON.stringify(result.reasons), notes, candidate.id);
  db.prepare(`INSERT INTO review_history (candidate_id, decision, match_score, notes, reviewer)
    VALUES (?, 'confirmed', ?, ?, 'Academic Resolver')`)
    .run(candidate.id, result.academicMatchScore, notes);
  audit("candidate.auto_confirmed_academic_resolver", "candidate", candidate.id,
    { score: result.academicMatchScore, url: primaryUrl, reasons: result.reasons });
  return { decision: "confirmed", score: result.academicMatchScore };
}

/**
 * End-to-end academic verification for a single candidate.
 */
export async function verifyCandidateAcademics(candidate, fetchImpl = fetch) {
  const { primaryQual, queries } = buildAcademicSearchQueries(candidate);
  if (!queries.length) {
    return { academicMatchScore: 0, isAcademicVerified: false, verifiedUrls: [], reasons: ["No academic queries available"] };
  }

  // Try every built query tier (at most 3: university-domain-scoped, degree-
  // scoped, and a domain-unrestricted broad query covering hospital staff
  // pages, nursing associations, and anywhere else a name might surface).
  // Previously capped at the first 2 tiers, which — for the ~92% of
  // candidates who have a recognized AU qualification — meant only the two
  // narrow university-scoped queries ever ran; the unrestricted "other
  // places" query was unreachable for almost everyone. The early-break below
  // still avoids unnecessary requests once a strong domain match is found.
  let allResults = [];
  for (const q of queries) {
    const results = await searchAcademicWeb(q.query, fetchImpl);
    if (results.length > 0) {
      allResults.push(...results);
      // If we got strong results on the primary university domain, no need to over-query
      if (q.type === "university_domain" && results.some(r => r.url.includes(".edu.au"))) {
        break;
      }
    }
  }

  return scoreAcademicEvidence(candidate, allResults, primaryQual);
}
