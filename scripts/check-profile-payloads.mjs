import { db } from "../src/db.mjs";

console.log("=== CHECKING PROVIDER RESPONSES FOR CONFIRMED CANDIDATES ===");

const confirmed = db.prepare("SELECT id, full_name, linkedin_url, qualifications FROM candidates WHERE identity_status = 'confirmed' LIMIT 10").all();

for (const c of confirmed) {
  const responses = db.prepare("SELECT response_kind, payload_json FROM provider_responses WHERE candidate_id = ?").all(c.id);
  console.log(`\n[Candidate #${c.id}] ${c.full_name}`);
  console.log(`Qualifications: ${c.qualifications}`);
  console.log(`LinkedIn URL: ${c.linkedin_url}`);
  console.log(`Total responses stored: ${responses.length}`);
  responses.forEach(r => {
    try {
      const parsed = JSON.parse(r.payload_json);
      console.log(`  - Kind: ${r.response_kind}, Keys: ${Object.keys(parsed).join(", ")}`);
      if (parsed.education || parsed.schools || parsed.university || parsed.location || parsed.headline) {
        console.log(`    Profile Details Found:`, {
          education: parsed.education || parsed.schools || parsed.university,
          location: parsed.location,
          headline: parsed.headline
        });
      }
    } catch {}
  });
}
