import { db } from "../src/db.mjs";

console.log("==================================================================");
console.log("   HCRHUB DATABASE DUPLICATION & URL SCORING VERIFICATION AUDIT   ");
console.log("==================================================================\n");

// 1. DUPLICATION CHECKS
console.log("--- 1. DUPLICATION ANALYSIS ---");

// A. Duplicate registration numbers (AHPRA)
const regDups = db.prepare(`
  SELECT ahpra_number, COUNT(*) as cnt, GROUP_CONCAT(id) as ids, GROUP_CONCAT(full_name) as names
  FROM candidates 
  WHERE ahpra_number IS NOT NULL AND ahpra_number != ''
  GROUP BY ahpra_number 
  HAVING cnt > 1
`).all();
console.log(`[A] Duplicate AHPRA Registration Numbers: ${regDups.length}`);
if (regDups.length > 0) {
  console.log("    Duplicates found:", JSON.stringify(regDups.slice(0, 5), null, 2));
}

// B. Duplicate Full Name + Suburb/State
const nameLocDups = db.prepare(`
  SELECT full_name, state, postcode, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
  FROM candidates 
  GROUP BY lower(trim(full_name)), state, postcode 
  HAVING cnt > 1
`).all();
console.log(`[B] Duplicate Full Name + State + Postcode: ${nameLocDups.length}`);
if (nameLocDups.length > 0) {
  console.log("    Sample duplicates:", JSON.stringify(nameLocDups.slice(0, 5), null, 2));
}

// C. Duplicate Full Name across the entire database
const nameDups = db.prepare(`
  SELECT full_name, COUNT(*) as cnt, GROUP_CONCAT(id) as ids
  FROM candidates 
  GROUP BY lower(trim(full_name))
  HAVING cnt > 1
`).all();
console.log(`[C] Same Full Name across different records (e.g. common names): ${nameDups.length}`);
if (nameDups.length > 0) {
  console.log("    Sample identical names:", JSON.stringify(nameDups.slice(0, 5), null, 2));
}

// D. Duplicate LinkedIn URLs on candidates table
const candUrlDups = db.prepare(`
  SELECT linkedin_url, COUNT(*) as cnt, GROUP_CONCAT(id) as ids, GROUP_CONCAT(full_name) as names
  FROM candidates 
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
  GROUP BY linkedin_url 
  HAVING cnt > 1
`).all();
console.log(`[D] Duplicate LinkedIn URLs assigned to multiple candidates: ${candUrlDups.length}`);
if (candUrlDups.length > 0) {
  console.log("    Duplicate URLs:", JSON.stringify(candUrlDups, null, 2));
}

// E. Duplicate candidates in browser_leads (multiple searches)
const leadCandDups = db.prepare(`
  SELECT candidate_id, COUNT(*) as cnt
  FROM browser_leads
  GROUP BY candidate_id
  HAVING cnt > 1
`).all();
console.log(`[E] Candidates searched multiple times in browser_leads: ${leadCandDups.length}`);

// F. Duplicate LinkedIn URLs recorded in browser_leads
const rawUrlDups = db.prepare(`
  SELECT linkedin_url, COUNT(*) as cnt, GROUP_CONCAT(candidate_id) as c_ids
  FROM browser_leads
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
  GROUP BY linkedin_url
  HAVING cnt > 1
`).all();
console.log(`[F] Duplicate LinkedIn URLs found across different candidates in browser_leads: ${rawUrlDups.length}`);
if (rawUrlDups.length > 0) {
  console.log("    Sample raw duplicate URLs:", JSON.stringify(rawUrlDups.slice(0, 5), null, 2));
}

// 2. SCORED URLS & DETAILED VALIDATION
console.log("\n--- 2. SCORED URLS BREAKDOWN ---");

const candidatesWithUrl = db.prepare(`
  SELECT id, full_name, profession, state, postcode, qualifications,
         linkedin_url, identity_match_score, workflow_stage, identity_status,
         recruiter_notes, updated_at
  FROM candidates 
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
  ORDER BY identity_match_score DESC, id ASC
`).all();

console.log(`Total Candidates with Scored/Stored LinkedIn URLs: ${candidatesWithUrl.length}`);

// Breakdown by score brackets
const scoreBrackets = {
  "100 pts": candidatesWithUrl.filter(c => c.identity_match_score === 100).length,
  "90-99 pts": candidatesWithUrl.filter(c => c.identity_match_score >= 90 && c.identity_match_score < 100).length,
  "80-89 pts": candidatesWithUrl.filter(c => c.identity_match_score >= 80 && c.identity_match_score < 90).length,
  "60-79 pts": candidatesWithUrl.filter(c => c.identity_match_score >= 60 && c.identity_match_score < 80).length,
  "< 60 pts / None": candidatesWithUrl.filter(c => !c.identity_match_score || c.identity_match_score < 60).length,
};
console.log("Score Distribution:", JSON.stringify(scoreBrackets, null, 2));

// Breakdown by workflow stage
const stageBreakdown = {};
for (const c of candidatesWithUrl) {
  stageBreakdown[c.workflow_stage] = (stageBreakdown[c.workflow_stage] || 0) + 1;
}
console.log("Workflow Stages with URLs:", JSON.stringify(stageBreakdown, null, 2));

// 3. CROSS-VERIFICATION OF SCORED URLS
console.log("\n--- 3. CROSS-VERIFICATION OF SCORED CANDIDATES ---");

function validateLinkedInUrl(url) {
  if (!url) return { valid: false, reason: "Missing URL" };
  try {
    const parsed = new URL(url);
    if (!["www.linkedin.com", "linkedin.com", "au.linkedin.com"].includes(parsed.hostname)) {
      return { valid: false, reason: `Invalid domain: ${parsed.hostname}` };
    }
    const isPublicProfile = /^\/in\/[a-zA-Z0-9_-]+\/?$/.test(parsed.pathname);
    const isSalesLead = /^\/sales\/lead\/[a-zA-Z0-9_-]+/.test(parsed.pathname);
    if (!isPublicProfile && !isSalesLead) {
      return { valid: false, reason: `Unrecognized LinkedIn URL path: ${parsed.pathname}` };
    }
    return {
      valid: true,
      type: isPublicProfile ? "public_profile" : "sales_navigator_lead",
      path: parsed.pathname
    };
  } catch (err) {
    return { valid: false, reason: `Malformed URL: ${err.message}` };
  }
}

const verifiedCandidates = [];
for (const cand of candidatesWithUrl) {
  const urlCheck = validateLinkedInUrl(cand.linkedin_url);
  
  // Extract qualifications institution
  let quals = [];
  try {
    quals = JSON.parse(cand.qualifications || "[]");
  } catch {
    quals = [cand.qualifications];
  }

  // Cross verification check
  const verification = {
    id: cand.id,
    name: cand.full_name,
    profession: cand.profession,
    state: cand.state,
    score: cand.identity_match_score,
    stage: cand.workflow_stage,
    status: cand.identity_status,
    url: cand.linkedin_url,
    urlValid: urlCheck.valid,
    urlType: urlCheck.type || "invalid",
    urlReason: urlCheck.reason || "OK",
    notes: cand.recruiter_notes
  };
  verifiedCandidates.push(verification);
}

console.log(JSON.stringify(verifiedCandidates, null, 2));

// 4. BROWSER LEADS WITH URLS
console.log("\n--- 4. BROWSER_LEADS TABLE WITH EXTRACTED URLS ---");
const leadsWithUrl = db.prepare(`
  SELECT id, candidate_id, matched_full_name, linkedin_url, headline, location, created_at
  FROM browser_leads
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
`).all();
console.log(`Total Leads in browser_leads with extracted URLs: ${leadsWithUrl.length}`);
const leadUrlValidation = {
  valid: 0,
  invalid: 0,
  sampleInvalid: []
};
for (const l of leadsWithUrl) {
  const check = validateLinkedInUrl(l.linkedin_url);
  if (check.valid) {
    leadUrlValidation.valid++;
  } else {
    leadUrlValidation.invalid++;
    leadUrlValidation.sampleInvalid.push({ id: l.id, url: l.linkedin_url, reason: check.reason });
  }
}
console.log(`Browser Leads URL Syntax Check: Valid=${leadUrlValidation.valid}, Invalid=${leadUrlValidation.invalid}`);
if (leadUrlValidation.sampleInvalid.length > 0) {
  console.log("Sample invalid lead URLs:", leadUrlValidation.sampleInvalid);
}
