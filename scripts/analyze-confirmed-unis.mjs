import { db } from "../src/db.mjs";
import { parseCandidateQualifications } from "../src/qualification-parser.mjs";

console.log("=== CONFIRMED CANDIDATES UNIVERSITY BREAKDOWN ===");

const rows = db.prepare(`
  SELECT id, full_name, qualifications, linkedin_url
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY id ASC
`).all();

console.log(`Total confirmed candidates: ${rows.length}`);

const withAuUni = [];
const withoutAuUni = [];

for (const r of rows) {
  const quals = parseCandidateQualifications(r.qualifications);
  const au = quals.find(q => q.isAustralian && q.institution);
  if (au) {
    withAuUni.push({
      id: r.id,
      name: r.full_name,
      institution: au.institution,
      domain: au.domain,
      degree: au.degree,
      year: au.year,
      linkedin: r.linkedin_url
    });
  } else {
    withoutAuUni.push({ id: r.id, name: r.full_name, raw: r.qualifications });
  }
}

console.log(`• With Australian University/College : ${withAuUni.length}`);
console.log(`• Without Australian Institution     : ${withoutAuUni.length}\n`);

console.log("First 15 Candidates with Australian University credentials:");
withAuUni.slice(0, 15).forEach((c, idx) => {
  console.log(`${idx + 1}. [ID #${c.id}] ${c.name} -> ${c.institution} (${c.degree}, ${c.year || 'N/A'}) [Domain: ${c.domain || 'N/A'}]`);
});
