import { db } from "../src/db.mjs";
import { scoreIdentityMatch } from "../src/domain.mjs";

console.log("=== PREVIEW: RE-EVALUATION OF 69 CONFIRMED CANDIDATES ===");
console.log("(Read-only simulation — NO database writes yet)\n");

const confirmed = db.prepare(`
  SELECT id, full_name, profession, state, postcode, qualifications, linkedin_url, employer, current_title, workflow_stage
  FROM candidates
  WHERE identity_status = 'confirmed'
  ORDER BY id
`).all();

const wouldKeepConfirmed = [];
const wouldMoveToReview = [];

for (const c of confirmed) {
  const match = scoreIdentityMatch(c, {
    fullName: c.full_name,
    profession: c.profession,
    state: c.state,
    postcode: c.postcode,
    qualifications: c.qualifications,
    linkedinUrl: c.linkedin_url,
    employer: c.employer,
    currentTitle: c.current_title
  });

  if (match.score >= 85 && match.conflicts.length === 0) {
    wouldKeepConfirmed.push(c);
  } else {
    wouldMoveToReview.push({ candidate: c, match });
  }
}

console.log(`Total confirmed records evaluated: ${confirmed.length}`);
console.log(`- Would KEEP confirmed (100% verified): ${wouldKeepConfirmed.length}`);
console.log(`- Would MOVE to manual_review (flagged for conflicts): ${wouldMoveToReview.length}\n`);

if (wouldMoveToReview.length > 0) {
  console.log("Candidates flagged with conflicts under upgraded algorithm:");
  wouldMoveToReview.forEach(({ candidate, match }) => {
    console.log(`• ID #${candidate.id} ${candidate.full_name}:`);
    console.log(`  URL: ${candidate.linkedin_url}`);
    console.log(`  Score: ${match.score} | Conflicts: ${match.conflicts.join(", ")}`);
  });
}
