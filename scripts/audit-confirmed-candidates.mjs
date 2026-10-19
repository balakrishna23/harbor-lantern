import { db } from "../src/db.mjs";
import { parseCandidateQualifications } from "../src/qualification-parser.mjs";

const candidates = db.prepare(`
  SELECT id, full_name, qualifications, linkedin_url, mobile_phone, work_email, employer, current_title, recruiter_notes
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY id ASC
`).all();

console.log(`Total Confirmed Candidates in DB: ${candidates.length}\n`);

const summary = candidates.map(c => {
  const quals = parseCandidateQualifications(c.qualifications);
  const auQual = quals.find(q => q.isAustralian && q.institution);
  return {
    id: c.id,
    name: c.full_name,
    uni: auQual?.institution || "No Australian Uni",
    uniDomain: auQual?.domain || null,
    linkedin: c.linkedin_url || "None",
    email: c.work_email || "None",
    phone: c.mobile_phone || "None",
    employer: c.employer || "None"
  };
});

// Group by University
const uniCounts = {};
for (const s of summary) {
  uniCounts[s.uni] = (uniCounts[s.uni] || 0) + 1;
}

console.log("=== UNIVERSITY DISTRIBUTION ACROSS 76 CONFIRMED CANDIDATES ===");
for (const [uni, count] of Object.entries(uniCounts).sort((a,b) => b[1] - a[1])) {
  console.log(`  - ${uni}: ${count}`);
}

console.log("\n=== CANDIDATE LIST (FIRST 30) ===");
summary.slice(0, 30).forEach(s => {
  console.log(`[#${s.id}] ${s.name} | Uni: ${s.uni} | LI: ${s.linkedin}`);
});
