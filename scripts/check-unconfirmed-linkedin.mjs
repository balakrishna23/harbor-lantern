import { db } from "../src/db.mjs";
import { parseCandidateQualifications } from "../src/qualification-parser.mjs";
import { scoreIdentityMatch } from "../src/domain.mjs";

console.log("=== CHECKING UNCONFIRMED CANDIDATES WITH LINKEDIN URLS ===\n");

const rows = db.prepare(`
  SELECT id, full_name, profession, state, postcode, qualifications, linkedin_url, employer, current_title, recruiter_notes
  FROM candidates
  WHERE linkedin_url IS NOT NULL AND linkedin_url != ''
    AND identity_status != 'confirmed'
`).all();

console.log(`Found ${rows.length} unconfirmed candidates with LinkedIn URLs:`);

for (const c of rows) {
  const quals = parseCandidateQualifications(c.qualifications);
  const primary = quals.find(q => q.isAustralian);
  const evaluated = scoreIdentityMatch(c, {
    fullName: c.full_name,
    profession: c.profession,
    state: c.state,
    postcode: c.postcode,
    qualifications: c.qualifications,
    linkedinUrl: c.linkedin_url,
    employer: c.employer,
    currentTitle: c.current_title
  });

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Candidate #${c.id}: ${c.full_name}`);
  console.log(`• Qualifications : ${c.qualifications || 'None'}`);
  console.log(`• Parsed Uni     : ${primary?.institution || 'N/A'} (${primary?.domain || 'N/A'})`);
  console.log(`• LinkedIn URL   : ${c.linkedin_url}`);
  console.log(`• Upgraded Score : ${evaluated.score}/100 (${evaluated.confidence.toUpperCase()})`);
  console.log(`• Reasons        : ${evaluated.reasons.join(" | ")}`);
  console.log(`• Conflicts      : ${evaluated.conflicts.length ? evaluated.conflicts.join(" | ") : 'None'}`);
}
