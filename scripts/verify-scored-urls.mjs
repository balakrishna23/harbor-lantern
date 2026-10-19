import { db } from "../src/db.mjs";

console.log("==================================================================");
console.log("       DETAILED CROSS-VERIFICATION OF SCORED CANDIDATE URLS       ");
console.log("==================================================================\n");

const scored = db.prepare(`
  SELECT id, ahpra_number, full_name, profession, suburb, state, postcode,
         qualifications, linkedin_url, identity_match_score,
         workflow_stage, identity_status, recruiter_notes, updated_at
  FROM candidates
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
  ORDER BY identity_match_score DESC, id ASC
`).all();

console.log(`Total Candidates with Stored LinkedIn URL: ${scored.length}\n`);

for (const c of scored) {
  console.log(`------------------------------------------------------------------`);
  console.log(`Candidate #${c.id}: ${c.full_name} (${c.profession})`);
  console.log(`AHPRA Number: ${c.ahpra_number} | State: ${c.state} ${c.postcode}`);
  console.log(`Stage: ${c.workflow_stage} | Score: ${c.identity_match_score}/100 | Status: ${c.identity_status}`);
  console.log(`LinkedIn URL: ${c.linkedin_url}`);
  console.log(`Qualifications: ${c.qualifications}`);
  console.log(`Recruiter Notes: ${c.recruiter_notes}`);

  // URL Syntax Validation
  let urlObj;
  let isSyntaxValid = false;
  let urlType = "unknown";
  try {
    urlObj = new URL(c.linkedin_url);
    if (urlObj.hostname.includes("linkedin.com")) {
      isSyntaxValid = true;
      if (urlObj.pathname.startsWith("/in/")) urlType = "Public Profile";
      else if (urlObj.pathname.startsWith("/sales/lead/")) urlType = "Sales Navigator Lead";
    }
  } catch (e) {
    isSyntaxValid = false;
  }
  console.log(`URL Validation: [${isSyntaxValid ? "VALID" : "INVALID"}] Type: ${urlType}`);

  // Name & Slug match check
  const slug = urlObj ? urlObj.pathname.replace(/\/sales\/lead\/|\/in\//, "").split("/")[0] : "";
  console.log(`Identifier Slug: ${slug}`);
}

console.log(`\n==================================================================`);
console.log(`       BROWSER LEADS AUDIT: MULTIPLE / DUPLICATE URLS             `);
console.log(`==================================================================\n`);

// Check if any single LinkedIn URL was captured for multiple different candidates
const sharedLeads = db.prepare(`
  SELECT linkedin_url, count(distinct candidate_id) as distinct_candidates, group_concat(distinct candidate_id) as cand_ids
  FROM browser_leads
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
  GROUP BY linkedin_url
  HAVING distinct_candidates > 1
`).all();

console.log(`LinkedIn URLs shared across distinct candidate IDs in browser_leads: ${sharedLeads.length}`);
if (sharedLeads.length > 0) {
  for (const s of sharedLeads) {
    console.log(`URL: ${s.linkedin_url}`);
    console.log(`Candidates: ${s.cand_ids} (${s.distinct_candidates} candidates)`);
    // Find matched names
    const details = db.prepare(`
      SELECT b.candidate_id, c.full_name as original_name, b.matched_full_name, b.headline, b.location
      FROM browser_leads b
      JOIN candidates c ON c.id = b.candidate_id
      WHERE b.linkedin_url = ?
    `).all(s.linkedin_url);
    console.log("Lead Details:", JSON.stringify(details, null, 2));
  }
}
