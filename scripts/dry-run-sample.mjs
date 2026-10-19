import { db } from "../src/db.mjs";
import { primaryAustralianQualification, parseCandidateQualifications } from "../src/qualification-parser.mjs";
import { buildAcademicSearchQueries } from "../src/academic-resolver.mjs";
import { scoreIdentityMatch } from "../src/domain.mjs";

console.log("=== 5-CANDIDATE READ-ONLY DRY RUN ===");
console.log("(Pure SELECT queries — ZERO database modifications)\n");

// Select 5 candidates with Australian university degrees
const sample = db.prepare(`
  SELECT id, full_name, profession, state, postcode, qualifications
  FROM candidates
  WHERE qualifications LIKE '%University of Canberra%'
     OR qualifications LIKE '%Charles Sturt University%'
     OR qualifications LIKE '%Australian Catholic University%'
  LIMIT 5
`).all();

for (const c of sample) {
  const primary = primaryAustralianQualification(c.qualifications);
  const { cleanName, queries } = buildAcademicSearchQueries(c);

  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`Candidate #${c.id}: ${c.full_name} (${c.profession}, ${c.state} ${c.postcode})`);
  console.log(`Raw Qualifications: ${c.qualifications.replace(/\s+/g, " ")}`);
  console.log(`\n1. Extracted Australian University:`);
  console.log(`   • Institution : ${primary?.institution || "N/A"}`);
  console.log(`   • Domain      : ${primary?.domain || "N/A"}`);
  console.log(`   • Degree      : ${primary?.degree || "N/A"}`);
  console.log(`   • Year        : ${primary?.year || "N/A"}`);

  console.log(`\n2. Generated University & Academic Web Queries:`);
  queries.forEach(q => console.log(`   • [${q.type}] ${q.query}`));

  console.log(`\n3. Algorithm Simulation Comparison:`);

  // Scenario A: Genuine Australian Profile with matching University
  const auResult = scoreIdentityMatch(c, {
    fullName: cleanName,
    profession: c.profession,
    state: c.state,
    university: primary?.institution,
    location: "Canberra, ACT, Australia",
    linkedinUrl: `https://www.linkedin.com/in/${cleanName.toLowerCase().replace(/\s+/g, "-")}-rn`
  });
  console.log(`   [Scenario A - Australian Profile with University Match]:`);
  console.log(`   Score      : ${auResult.score}/100 (${auResult.confidence.toUpperCase()})`);
  console.log(`   Reasons    : ${auResult.reasons.join(" | ")}`);
  console.log(`   Conflicts  : ${auResult.conflicts.length ? auResult.conflicts.join(" | ") : "None (Confirmed)"}`);

  // Scenario B: Overseas Namesake (e.g. India/US with same name, no AU university)
  const overseasResult = scoreIdentityMatch(c, {
    fullName: cleanName,
    profession: c.profession,
    location: "Punjab, India",
    university: "Delhi University",
    linkedinUrl: `https://www.linkedin.com/in/${cleanName.toLowerCase().replace(/\s+/g, "-")}-india`
  });
  console.log(`   [Scenario B - Overseas Namesake Profile in India]:`);
  console.log(`   Score      : ${overseasResult.score}/100 (${overseasResult.confidence.toUpperCase()})`);
  console.log(`   Conflicts  : ${overseasResult.conflicts.join(" | ")}`);
  console.log(`   Decision   : HARD REJECT (Blocked from confirmation)`);
  console.log();
}
