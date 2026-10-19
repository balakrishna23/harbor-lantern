const honorifics = new Set(["mr", "mrs", "ms", "miss", "dr", "sir", "mx"]);
const words = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  .split(/\s+/).filter((word) => word && !honorifics.has(word));

function overlap(left, right) {
  const a = new Set(words(left));
  const b = new Set(words(right));
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / Math.max(a.size, b.size);
}

export function scoreProfileCandidate(candidate, profile) {
  const reasons = [], conflicts = [];
  const sourceName = words(candidate.full_name);
  const profileName = words(profile.fullName);
  const nameOverlap = overlap(candidate.full_name, profile.fullName);
  let score = Math.round(nameOverlap * 55);
  if (sourceName.join(" ") === profileName.join(" ")) {
    score = 60;
    reasons.push("Exact normalized name");
  } else if (sourceName[0] === profileName[0] && sourceName.at(-1) === profileName.at(-1)) {
    score = Math.max(score, 48);
    reasons.push("First and last name match");
  } else if (sourceName.at(-1) !== profileName.at(-1)) {
    conflicts.push("Last name differs");
  }
  if (/nurs/i.test(`${profile.headline || ""} ${profile.currentTitle || ""}`)) {
    score += 10;
    reasons.push("Nursing role matches profession");
  }
  const location = `${profile.location || ""} ${profile.state || ""}`;
  if (/\b(act|australian capital territory|canberra)\b/i.test(location) && candidate.state === "ACT") {
    score += 10;
    reasons.push("ACT location matches");
  } else if (profile.state && candidate.state && profile.state.toUpperCase() !== candidate.state.toUpperCase()) {
    conflicts.push("Profile state differs from licensed source");
  }
  const qualificationOverlap = overlap(candidate.qualifications, `${profile.education || ""} ${profile.qualification || ""}`);
  if (qualificationOverlap >= 0.25) {
    score += qualificationOverlap >= 0.5 ? 20 : 12;
    reasons.push("Education evidence matches qualification");
  }
  score = Math.max(0, Math.min(100, score - conflicts.length * 8));
  return { candidateId: candidate.id, score, reasons, conflicts };
}

export function rankProfileCandidates(candidates, profile, limit = 5) {
  return candidates.map((candidate) => ({ candidate, ...scoreProfileCandidate(candidate, profile) }))
    .filter((match) => match.score >= 35)
    .sort((a, b) => b.score - a.score || a.candidate.id - b.candidate.id)
    .slice(0, limit);
}

export function findProfileCandidates(db, profile, limit = 5) {
  const profileWords = words(profile.fullName);
  let candidates;
  if (profileWords.length > 0) {
    const lastNameToken = profileWords.at(-1);
    const firstNameToken = profileWords[0];
    candidates = db.prepare(`SELECT id, full_name, first_name, last_name, profession, state, suburb,
      postcode, qualifications, identity_status FROM candidates
      WHERE registration_status = 'Registered' AND identity_status <> 'rejected'
        AND (last_name LIKE ? OR first_name LIKE ? OR full_name LIKE ?)
      LIMIT 250`).all(`%${lastNameToken}%`, `%${firstNameToken}%`, `%${lastNameToken}%`);
    if (!candidates.length) {
      candidates = db.prepare(`SELECT id, full_name, first_name, last_name, profession, state, suburb,
        postcode, qualifications, identity_status FROM candidates
        WHERE registration_status = 'Registered' AND identity_status <> 'rejected'
        LIMIT 100`).all();
    }
  } else {
    candidates = db.prepare(`SELECT id, full_name, first_name, last_name, profession, state, suburb,
      postcode, qualifications, identity_status FROM candidates
      WHERE registration_status = 'Registered' AND identity_status <> 'rejected'
      LIMIT 100`).all();
  }
  return rankProfileCandidates(candidates, profile, limit);
}

