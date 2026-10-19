import { db } from "../src/db.mjs";
import { parseCandidateQualifications } from "../src/qualification-parser.mjs";

const candidates = db.prepare(`
  SELECT id, full_name, suburb, state, postcode, qualifications, linkedin_url, 
         work_email, mobile_phone, international_phone, employer, current_title, 
         recruiter_notes, identity_confidence, identity_match_score
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY id ASC
`).all();

const suspects = [];
const clean = [];

for (const c of candidates) {
  const quals = parseCandidateQualifications(c.qualifications);
  const auQual = quals.find(q => q.isAustralian && q.institution);
  const emailDomain = c.work_email ? c.work_email.split("@")[1]?.toLowerCase() : null;
  
  const flags = [];
  if (c.international_phone) {
    flags.push(`Foreign phone: ${c.international_phone}`);
  }
  
  if (emailDomain) {
    const isAuDomain = emailDomain.endsWith(".au");
    const isGeneric = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com"].includes(emailDomain);
    if (!isAuDomain && !isGeneric) {
      flags.push(`Foreign corporate email: ${c.work_email}`);
    }
  }

  if (flags.length > 0) {
    suspects.push({ ...c, uni: auQual?.institution || "None", flags });
  } else {
    clean.push({ ...c, uni: auQual?.institution || "None" });
  }
}

console.log(`Suspects count: ${suspects.length}`);
console.log(`Clean count: ${clean.length}`);
console.log(`Suspect IDs: ${suspects.map(s => s.id).join(", ")}`);
