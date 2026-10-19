import { db } from "../src/db.mjs";
import { parseCandidateQualifications } from "../src/qualification-parser.mjs";

console.log("=== DEEP AUDIT OF 76 CONFIRMED CANDIDATES ===");

const candidates = db.prepare(`
  SELECT id, full_name, suburb, state, postcode, qualifications, linkedin_url, 
         work_email, mobile_phone, international_phone, employer, current_title, 
         recruiter_notes, identity_confidence, identity_match_score
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY id ASC
`).all();

let suspects = [];
let strongAu = [];

for (const c of candidates) {
  const quals = parseCandidateQualifications(c.qualifications);
  const auQual = quals.find(q => q.isAustralian && q.institution);
  const emailDomain = c.work_email ? c.work_email.split("@")[1]?.toLowerCase() : null;
  
  // Flag indicators of mismatch:
  // 1. Quarantined international phone (+1, +91, +44, etc.)
  // 2. Email domain is commercial/foreign (.com, .org.uk, .in, etc. instead of .au or health-related)
  // 3. No Australian university or foreign employer
  
  const flags = [];
  if (c.international_phone) {
    flags.push(`Quarantined foreign phone: ${c.international_phone}`);
  }
  
  if (emailDomain) {
    const isAuDomain = emailDomain.endsWith(".au");
    const isGeneric = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com"].includes(emailDomain);
    if (!isAuDomain && !isGeneric) {
      flags.push(`Foreign/Commercial corporate email: ${c.work_email}`);
    }
  }

  const record = {
    id: c.id,
    name: c.full_name,
    uni: auQual?.institution || "None",
    linkedin: c.linkedin_url,
    email: c.work_email,
    mobile: c.mobile_phone,
    intlPhone: c.international_phone,
    employer: c.employer,
    flags
  };

  if (flags.length > 0) {
    suspects.push(record);
  } else {
    strongAu.push(record);
  }
}

console.log(`Total confirmed audited: ${candidates.length}`);
console.log(`• Potentially Misidentified / Mismatched Overseas Profiles (Flags > 0): ${suspects.length}`);
console.log(`• Clean Australian Profiles (No foreign flags): ${strongAu.length}\n`);

console.log("=== FLAGGED CANDIDATES (OVERSEAS PHONE OR OVERSEAS CORPORATE EMAIL) ===");
suspects.forEach(s => {
  console.log(`\n[Candidate #${s.id}] ${s.name}`);
  console.log(`  AHPRA Uni: ${s.uni}`);
  console.log(`  LinkedIn: ${s.linkedin}`);
  console.log(`  Email: ${s.email || 'N/A'}`);
  console.log(`  Flags:`);
  s.flags.forEach(f => console.log(`    - ${f}`));
});
