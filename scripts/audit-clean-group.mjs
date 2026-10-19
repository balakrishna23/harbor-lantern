import { db } from "../src/db.mjs";
import { parseCandidateQualifications } from "../src/qualification-parser.mjs";

const candidates = db.prepare(`
  SELECT id, full_name, suburb, state, postcode, qualifications, linkedin_url, 
         work_email, mobile_phone, international_phone, employer, current_title
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY id ASC
`).all();

const cleanCandidates = candidates.filter(c => {
  if (c.international_phone) return false;
  const emailDomain = c.work_email ? c.work_email.split("@")[1]?.toLowerCase() : null;
  if (emailDomain) {
    const isAuDomain = emailDomain.endsWith(".au");
    const isGeneric = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com"].includes(emailDomain);
    if (!isAuDomain && !isGeneric) return false;
  }
  return true;
});

console.log(`=== ANALYZING ${cleanCandidates.length} CANDIDATES WITHOUT FOREIGN FLAGS ===`);

cleanCandidates.forEach(c => {
  const quals = parseCandidateQualifications(c.qualifications);
  const auQual = quals.find(q => q.isAustralian && q.institution);
  console.log(`\n[#${c.id}] ${c.full_name} (${c.suburb || 'ACT'}, ${c.state || 'ACT'})`);
  console.log(`  Uni: ${auQual?.institution || 'None'}`);
  console.log(`  LinkedIn: ${c.linkedin_url}`);
  console.log(`  Mobile: ${c.mobile_phone || 'None'}`);
  console.log(`  Email: ${c.work_email || 'None'}`);
  console.log(`  Employer: ${c.employer || 'None'}`);
});
