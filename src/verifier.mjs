/**
 * Verifies a provider's person record against the licensed AHPRA register,
 * without relying on location (the national extract has none).
 *
 * Evidence used, strongest first:
 *   name (required) - training institution - graduation year - nursing title
 *   - country - how unique the name is on the register - provider likelihood
 *
 * Decisions:
 *   accept  strong, conflict-free evidence; still recorded with reasons
 *   review  plausible, needs a recruiter
 *   reject  different person, overseas, or too little evidence
 */
import { comparable, namesMatch } from "./domain.mjs";
import { parseCandidateQualifications } from "./qualification-parser.mjs";
import { inferInstitutionState } from "./institution-state.mjs";

const NURSING_TITLE = /\b(nurse|nursing|rn|midwife|midwifery|cnc|cns|cne|num|nurse unit manager|perioperative|scrub|theatre)\b/i;
const NOT_CLINICAL = /\b(recruit\w*|talent|sales|account manager|business development|marketing)\b/i;
// Unregistered support roles: not evidence of a registered nurse.
const SUPPORT_ROLE = /\b(assistant in nursing|nursing assistant|nurse assistant|ain|personal care|care worker|support worker)\b/i;

export const VERIFIER_WEIGHTS = Object.freeze({
  name: 30, australia: 15, nursingTitle: 20, school: 20, gradYear: 10, uniqueName: 10, rareName: 5, highLikelihood: 5, conflictPenalty: 15
});

export function isNursingTitle(title) {
  const t = String(title || "");
  return NURSING_TITLE.test(t) && !NOT_CLINICAL.test(t) && !SUPPORT_ROLE.test(t);
}

/** True when a linkedin.com/in/ slug contains neither the first nor the last name. */
export function slugConflictsWithName(firstName, lastName, linkedinUrl) {
  let url;
  try { url = new URL(linkedinUrl); } catch { return false; }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !url.pathname.startsWith("/in/")) return false;
  const slug = decodeURIComponent(url.pathname.slice(4)).toLowerCase().replace(/[^a-z]/g, "");
  const first = comparable(firstName).split(" ")[0];
  const last = comparable(lastName).split(" ").at(-1);
  if (!first || !last || first.length < 2 || last.length < 2) return false;
  return !slug.includes(first) && !slug.includes(last);
}

function schoolsMatch(registerInstitution, profileSchool) {
  const a = comparable(registerInstitution);
  const b = comparable(profileSchool);
  if (!a || !b) return false;
  const ka = inferInstitutionState(registerInstitution);
  const kb = inferInstitutionState(profileSchool);
  if (ka.known && kb.known) return ka.key === kb.key;
  // Unknown to the lookup: require a multi-word containment either way.
  const multiword = (s) => s.split(" ").length >= 2;
  return (multiword(a) && ` ${b} `.includes(` ${a} `)) || (multiword(b) && ` ${a} `.includes(` ${b} `));
}

const rawInstitution = (q) => String(q.raw || "").replace(/^[•\s]+/, "").split(",").map((p) => p.trim())[1] || null;

/**
 * @param {object} candidate  candidates row (snake_case, as stored)
 * @param {object} keys       deriveMatchKeys() output for the candidate
 * @param {object} lookup     LookupResult from a provider adapter
 */
export function verifyIdentity(candidate, keys, lookup, thresholds = {}) {
  const accept = Number(thresholds.accept ?? 70);
  const review = Number(thresholds.review ?? 45);
  const person = lookup?.person;
  const reasons = [];
  const conflicts = [];
  const hard = [];
  const signals = { nameMatch: false, inAustralia: null, nursingTitle: false, schoolMatch: false, yearMatch: false, uniqueness: keys?.uniqueness ?? "unknown" };

  if (!person || lookup.status !== "match") {
    return { decision: "reject", score: 0, signals, reasons, conflicts: ["Provider returned no match"] };
  }
  const W = VERIFIER_WEIGHTS;
  let score = 0;

  // Name (required)
  const names = [candidate.full_name, [candidate.first_name, candidate.middle_name, candidate.last_name].filter(Boolean).join(" "), candidate.alternative_name].filter(Boolean);
  const profileName = person.fullName || [person.firstName, person.middleName, person.lastName].filter(Boolean).join(" ");
  signals.nameMatch = Boolean(profileName) && names.some((n) => namesMatch(n, profileName));
  if (signals.nameMatch) { score += W.name; reasons.push("Name matches the register"); }
  else hard.push("Name differs from the register");

  // Middle name, when both sides have one
  const regMiddle = comparable(candidate.middle_name).charAt(0);
  const profMiddle = comparable(person.middleName).charAt(0);
  if (regMiddle && profMiddle && regMiddle !== profMiddle) conflicts.push("Middle name differs from the register");

  if (person.linkedinUrl && slugConflictsWithName(candidate.first_name, candidate.last_name, person.linkedinUrl)) {
    conflicts.push("LinkedIn address contains neither the first nor the last name");
  }

  // Country
  const country = comparable(person.country);
  if (country) {
    signals.inAustralia = country === "australia";
    if (signals.inAustralia) { score += W.australia; reasons.push("Profile is based in Australia"); }
    else hard.push(`Profile is based outside Australia (${person.country})`);
  }

  // Current title
  if (isNursingTitle(person.currentTitle)) { signals.nursingTitle = true; score += W.nursingTitle; reasons.push(`Current title is nursing (${person.currentTitle})`); }
  else if (person.currentTitle && NOT_CLINICAL.test(person.currentTitle)) conflicts.push(`Current title is non-clinical (${person.currentTitle})`);
  else if (person.currentTitle && SUPPORT_ROLE.test(person.currentTitle)) reasons.push(`Current title is a support role (${person.currentTitle}); not counted as nursing evidence`);

  // Education vs AHPRA qualifications
  const quals = parseCandidateQualifications(candidate.qualifications)
    .map((q) => ({ institution: rawInstitution(q), year: q.year }))
    .filter((q) => q.institution);
  // Nurses often study at the same school more than once (bachelor's, then a
  // postgraduate course) while the register lists one of those years. So the
  // year is judged per school: it matches if ANY profile year at that school
  // is within 1 year of ANY register year there, and conflicts only when
  // none is within 2. At most one year conflict is recorded.
  const pairs = [];
  for (const edu of person.education || []) {
    for (const q of quals) if (schoolsMatch(q.institution, edu.school)) pairs.push({ edu, q });
  }
  if (pairs.length) {
    signals.schoolMatch = true;
    score += W.school;
    reasons.push(`Studied at ${pairs[0].edu.school}, as on the register`);
    const dated = pairs.filter((p) => p.q.year && p.edu.endYear).map((p) => ({ ...p, diff: Math.abs(p.q.year - p.edu.endYear) }));
    if (dated.length) {
      const best = dated.reduce((a, b) => (b.diff < a.diff ? b : a));
      if (best.diff <= 1) { signals.yearMatch = true; score += W.gradYear; reasons.push(`Graduation year ${best.edu.endYear} matches the register (${best.q.year})`); }
      else if (best.diff > 2) conflicts.push(`Graduation year ${best.edu.endYear} differs from the register (${best.q.year})`);
    }
  }

  // Name rarity on the register
  if (signals.uniqueness === "unique") { score += W.uniqueName; reasons.push("No other nurse on the register shares this name"); }
  else if (signals.uniqueness === "rare") { score += W.rareName; reasons.push("Only 2-3 nurses on the register share this name"); }

  if (Number(lookup.likelihood) >= 8) { score += W.highLikelihood; reasons.push(`Provider confidence ${lookup.likelihood}/10`); }

  score = Math.max(0, Math.min(100, score - conflicts.length * W.conflictPenalty));

  let decision;
  if (hard.length) {
    decision = "reject";
    score = 0;
  } else if (
    conflicts.length === 0 && score >= accept && signals.inAustralia === true
    && (signals.nursingTitle || signals.schoolMatch)
    && (signals.uniqueness === "unique" || signals.schoolMatch)
  ) {
    decision = "accept";
  } else if (score >= review) {
    decision = "review";
  } else {
    decision = "reject";
    conflicts.push("Not enough evidence to link this profile to the register");
  }
  return { decision, score, signals, reasons, conflicts: [...hard, ...conflicts] };
}
