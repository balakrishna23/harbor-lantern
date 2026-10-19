import { db } from "../src/db.mjs";

console.log("=== CONFIRMED CANDIDATES EMPLOYER AUDIT ===");

const rows = db.prepare(`
  SELECT id, full_name, employer, current_title, linkedin_url
  FROM candidates
  WHERE identity_status = 'confirmed' AND employer IS NOT NULL AND employer != ''
  ORDER BY id ASC
  LIMIT 25
`).all();

console.log(`Found ${rows.length} candidates with employer listed:`);
rows.forEach(r => {
  console.log(`[#${r.id}] ${r.full_name} | Role: "${r.current_title || 'N/A'}" | Employer: "${r.employer}" | URL: ${r.linkedin_url}`);
});
