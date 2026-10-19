import { db } from "../src/db.mjs";

const stats = db.prepare(`
  SELECT identity_provider, COUNT(*) as count 
  FROM candidates 
  WHERE identity_status = 'confirmed' 
  GROUP BY identity_provider
`).all();

console.log("Confirmed Candidates by Identity Provider:");
console.log(stats);

const details = db.prepare(`
  SELECT id, full_name, identity_provider, linkedin_url, mobile_phone, international_phone, work_email, employer
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY identity_provider, id
`).all();

console.log("\nBreakdown by provider:");
for (const s of stats) {
  const list = details.filter(d => d.identity_provider === s.identity_provider);
  console.log(`\n=== Provider: ${s.identity_provider} (${list.length}) ===`);
  list.slice(0, 10).forEach(c => {
    console.log(`  [#${c.id}] ${c.full_name} | Mobile: ${c.mobile_phone || 'None'} | Intl: ${c.international_phone || 'None'} | Email: ${c.work_email || 'None'}`);
  });
}
