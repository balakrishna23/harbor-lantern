import { db } from "../src/db.mjs";

function cleanSlug(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.replace(/^\/in\//, "").replace(/\/$/, "")).toLowerCase();
  } catch {
    return "";
  }
}

const candidates = db.prepare(`
  SELECT id, full_name, linkedin_url
  FROM candidates
  WHERE identity_status = 'confirmed' AND linkedin_url IS NOT NULL AND linkedin_url != ''
`).all();

console.log(`Auditing ${candidates.length} confirmed candidates' LinkedIn slugs...\n`);

let matches = 0;
let mismatches = 0;

for (const c of candidates) {
  const cleanName = c.full_name.replace(/^(Dr|Mr|Mrs|Ms|Miss)\s+/i, "").toLowerCase();
  const nameParts = cleanName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0];
  const lastName = nameParts[nameParts.length - 1];
  const slug = cleanSlug(c.linkedin_url);

  // Check if both first and last are in slug
  const hasFirst = slug.includes(firstName) || slug.startsWith(firstName[0] + "-") || slug.startsWith(firstName[0] + lastName);
  const hasLast = slug.includes(lastName);

  const isStrongMatch = hasFirst && hasLast;

  if (isStrongMatch) {
    matches++;
  } else {
    mismatches++;
    console.log(`[MISMATCH] Candidate #${c.id} "${c.full_name}" vs Slug "${slug}" (URL: ${c.linkedin_url})`);
  }
}

console.log(`\nResults: ${matches} strong slug matches, ${mismatches} mismatches.`);
