import crypto from "node:crypto";
import { parseCandidateQualifications } from "./qualification-parser.mjs";
import { parseAndValidatePhone } from "./phone-validator.mjs";

const aliases = {
  ahpraNumber: ["ahpra registration number", "registration number", "ahpra number", "registration_number"],
  fullName: ["health practitioner", "full name", "name"],
  firstName: ["first name", "firstname", "given name"],
  middleName: ["middle name", "middlename"],
  lastName: ["last name", "lastname", "surname", "family name"],
  alternativeName: ["alternative name", "other name"],
  profession: ["profession"],
  registrationStatus: ["registration status", "status"],
  registrationType: ["registration type", "registration type "],
  registrationExpiry: ["registration expiry date", "expiry", "expiry date"],
  suburb: ["suburb", "city"],
  state: ["state", "region"],
  postcode: ["postcode", "postal code"],
  qualifications: ["qualifications", "qualification"],
  languages: ["languages", "languages (in addition to english)", "languages  (in addition to english)"],
  specialty: ["specialty"],
  specialtyFields: ["specialty fields"],
  linkedinUrl: ["linkedin url", "linkedin", "professional profile url"],
  employer: ["current employer", "employer", "company"],
  currentTitle: ["current title", "job title", "title"]
};

const normalizeHeader = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");
// The source workbook stores some free-text fields (qualifications, in
// particular) with literal HTML entities rather than the actual characters —
// e.g. "Mental Health &amp; Neuro Sciences" instead of "...&...". Left
// undecoded, this both displays wrong in the UI and silently breaks
// substring matching against a provider's plain-text profile data (a real
// institution-name match failed on this before it was found and fixed).
const decodeHtmlEntities = (value) => value
  .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&nbsp;/gi, " ");
const clean = (value) => decodeHtmlEntities(String(value ?? "")).trim().replace(/\s+/g, " ");
const upper = (value) => clean(value).toUpperCase();

function findValue(row, names) {
  const indexed = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]));
  for (const name of names) {
    const value = indexed[normalizeHeader(name)];
    if (value != null && clean(value)) return clean(value);
  }
  return "";
}

export function normalizeCandidate(row) {
  const result = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, findValue(row, names)]));
  result.state = upper(result.state);
  result.suburb = upper(result.suburb);
  result.postcode = result.postcode.replace(/\.0$/, "");
  result.fullName = clean(result.fullName || [result.firstName, result.middleName, result.lastName].filter(Boolean).join(" "));
  result.firstName = clean(result.firstName);
  result.middleName = clean(result.middleName);
  result.lastName = clean(result.lastName);
  result.ahpraNumber = upper(result.ahpraNumber).replace(/\s+/g, "");
  result.registrationStatus = clean(result.registrationStatus);
  result.linkedinUrl = clean(result.linkedinUrl);
  result.sourceHash = candidateSourceHash(result);
  result.identityConfidence = identityConfidence(result);
  return result;
}

export function candidateSourceHash(candidate) {
  const identity = candidate.ahpraNumber || [candidate.fullName, candidate.profession, candidate.state, candidate.postcode].join("|").toLowerCase();
  return crypto.createHash("sha256").update(identity).digest("hex");
}

export function identityConfidence(candidate) {
  let score = 0;
  if (candidate.fullName) score += 25;
  if (candidate.profession) score += 20;
  if (candidate.state || candidate.postcode) score += 15;
  if (candidate.qualifications) score += 20;
  if (candidate.linkedinUrl && candidate.employer) score += 20;
  else if (candidate.linkedinUrl || candidate.employer) score += 10;
  return Math.min(score, 100);
}

// "&" is expanded to "and" (not simply stripped) so institution names that
// spell it out one way in AHPRA's source data and the other way on a
// provider's profile (e.g. "Mental Health & Neuro Sciences" vs "...and...")
// still normalize to the same comparable string instead of silently failing
// a substring match.
export const comparable = (value) => clean(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const honorifics = new Set(["dr", "miss", "mr", "mrs", "ms", "mx", "prof", "sir"]);
const comparableName = (value) => comparable(value).split(" ").filter((token) => token && !honorifics.has(token)).join(" ");
/**
 * True when sourceValue (an AHPRA candidate's full name) and resultValue (a
 * provider/LinkedIn display name) are plausibly the same person, tried in
 * three progressively narrower ways:
 *  1. Exact match once both sides are lowercased and honorifics stripped.
 *  2. First-token + last-token positional match, tolerating any number of
 *     DROPPED MIDDLE tokens (e.g. "Sophia Rose Michelle De Bellavista" vs
 *     "Sophia de bellavista" — both have first="sophia", last="bellavista").
 *  3. Dropped-LEADING-token match: tolerates a dropped leading token, which
 *     is a common LinkedIn display pattern for South Asian/Nepali/Filipino
 *     multi-part AHPRA names (e.g. "Mergu Bala Krishna" vs "Bala Krishna").
 *     The shorter token list must appear as a literal, contiguous, in-order
 *     TAIL of the longer list — not "any shared token" and not "last name
 *     only" — and must be at least 2 tokens long, so a bare shared surname
 *     alone (e.g. "Krishna") can never trigger a match on its own. This
 *     deliberately does NOT tolerate a dropped TRAILING token (e.g. "Arshdeep
 *     Kaur Tarnowski" vs just "Arshdeep Kaur" does NOT match) — in this
 *     population "Kaur"/"Singh" function more like gender markers than
 *     distinguishing surnames, so allowing the family name to be dropped
 *     risks matching an unrelated same-first-name person. Nor does it
 *     tolerate reordering (e.g. "John Michael Smith" vs "Michael John Smith"
 *     does not match — for equal-length lists this branch collapses to full
 *     equality, already covered by branch 1).
 */
export function namesMatch(sourceValue, resultValue) {
  const sourceTokens = comparableName(sourceValue).split(" ").filter(Boolean);
  const resultTokens = comparableName(resultValue).split(" ").filter(Boolean);
  if (sourceTokens.join(" ") === resultTokens.join(" ")) return sourceTokens.length > 0;
  if (sourceTokens.length >= 2 && resultTokens.length >= 2
    && sourceTokens[0] === resultTokens[0] && sourceTokens.at(-1) === resultTokens.at(-1)) return true;

  const [shortTokens, longTokens] = sourceTokens.length <= resultTokens.length
    ? [sourceTokens, resultTokens]
    : [resultTokens, sourceTokens];
  if (shortTokens.length < 2 || shortTokens.length >= longTokens.length) return false;
  const tail = longTokens.slice(longTokens.length - shortTokens.length);
  return tail.join(" ") === shortTokens.join(" ");
}

function linkedinSlugConflictsWithName(fullName, linkedinUrl) {
  if (!fullName || !linkedinUrl) return false;
  let url;
  try { url = new URL(linkedinUrl); } catch { return false; }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname) || !url.pathname.startsWith("/in/")) return false;
  const nameTokens = comparable(fullName).split(" ").filter(Boolean);
  const first = nameTokens.find((token) => !honorifics.has(token));
  const last = nameTokens.at(-1);
  const rawSlug = decodeURIComponent(url.pathname.slice(4)).toLowerCase().replace(/[^a-z0-9]/g, "");
  const slugTokens = comparable(decodeURIComponent(url.pathname.slice(4))).split(" ").filter(Boolean);
  const hasFirst = (first && slugTokens.includes(first)) || (first && rawSlug.includes(first));
  const hasLast = (last && slugTokens.includes(last)) || (last && rawSlug.includes(last));
  return Boolean(first && last && !hasFirst && !hasLast);
}

export function scoreIdentityMatch(candidate, result, thresholds = {}) {
  let score = 0;
  const reasons = [];
  const conflicts = [];
  const compare = (label, sourceValue, resultValue, weight) => {
    if (!resultValue) return;
    if (comparable(sourceValue) && comparable(sourceValue) === comparable(resultValue)) {
      score += weight;
      reasons.push(`${label} matches licensed source`);
    } else if (sourceValue) {
      conflicts.push(`${label} differs from licensed source`);
    }
  };
  if (result.fullName) {
    if (namesMatch(candidate.full_name, result.fullName)) {
      score += 40;
      reasons.push("Name matches licensed source");
    } else if (candidate.full_name) {
      conflicts.push("Name differs from licensed source");
    }
  }
  compare("Profession", candidate.profession, result.profession, 20);
  if (result.postcode) compare("Postcode", candidate.postcode, result.postcode, 15);
  else compare("State", candidate.state, result.state, 10);
  compare("Qualification", candidate.qualifications, result.qualifications, 10);

  // University & Academic Qualification Verification
  if (candidate.qualifications) {
    const candidateQuals = parseCandidateQualifications(candidate.qualifications);
    const primaryAu = candidateQuals.find((q) => q.isAustralian && q.institution);
    const resultEdu = comparable(result.university || result.school || result.education || "");
    if (resultEdu && primaryAu && primaryAu.institution) {
      const targetInst = comparable(primaryAu.institution);
      const shortDomain = primaryAu.domain ? primaryAu.domain.split(".")[0] : null;
      if (resultEdu.includes(targetInst) || (shortDomain && resultEdu.includes(shortDomain))) {
        score += 25;
        reasons.push(`University matches AHPRA licensed qualifications (${primaryAu.institution})`);
      } else if (candidateQuals.some((q) => q.institution && resultEdu.includes(comparable(q.institution)))) {
        score += 20;
        reasons.push("Education institution matches an AHPRA licensed degree");
      }
    }

    // Graduation-year cross-check: a distinctive, cheap disambiguator that a
    // coincidental namesake is unlikely to share even when name/location/employer
    // happen to line up. Only applied when the provider actually returns a year.
    const profileYear = Number(result.graduationYear || result.educationYear);
    if (primaryAu?.year && Number.isFinite(profileYear)) {
      const diff = Math.abs(profileYear - primaryAu.year);
      if (diff <= 2) {
        score += 15;
        reasons.push(`Graduation year (${profileYear}) matches AHPRA qualification year (${primaryAu.year})`);
      } else {
        conflicts.push(`Graduation year (${profileYear}) does not match AHPRA qualification year (${primaryAu.year})`);
      }
    }
  }

  // Australian Geographic / Location Enforcement
  const locStr = comparable(result.location || result.country || "");
  if (locStr) {
    const nonAu = ["india", "united states", "usa", "canada", "united arab emirates", "uae", "united kingdom", "uk", "philippines", "pakistan"];
    if (nonAu.some((c) => locStr.includes(c)) && !locStr.includes("australia")) {
      conflicts.push(`Profile location (${result.location || result.country}) is outside Australia`);
      score = 0;
    } else if (locStr.includes("australia") || locStr.includes("act") || locStr.includes("canberra") || locStr.includes("nsw")) {
      score += 10;
      reasons.push("Profile location confirmed in Australia");
    }
  }

  if (result.linkedinUrl) {
    score += 15;
    reasons.push("Professional profile URL returned");
    if (linkedinSlugConflictsWithName(candidate.full_name, result.linkedinUrl)) {
      conflicts.push("LinkedIn profile slug does not contain the candidate's first or last name");
    } else {
      // Cross-check slug: if slug has last name but a conflicting first name, flag conflict
      const nameTokens = comparable(candidate.full_name).split(" ").filter((t) => !honorifics.has(t));
      if (nameTokens.length >= 2) {
        const first = nameTokens[0];
        const last = nameTokens.at(-1);
        const givenTokens = [...nameTokens.slice(0, -1), ...comparable(candidate.alternative_name || "").split(" ").filter(Boolean)];
        try {
          const rawSlug = comparable(decodeURIComponent(new URL(result.linkedinUrl).pathname.slice(4)));
          const slugTokens = rawSlug.split(" ").filter(Boolean);
          const hasMatchingGiven = givenTokens.some((t) => slugTokens.includes(t) || rawSlug.startsWith(t[0] + "-") || rawSlug.startsWith(t[0] + last));
          if (slugTokens.includes(last) && !hasMatchingGiven) {
            // Slug matches surname but has a totally different first name
            if (slugTokens.length > 1 && slugTokens[0] !== last && slugTokens[0].length > 2) {
              conflicts.push(`LinkedIn profile slug first name differs from candidate first name (${first})`);
            }
          }
        } catch {}
      }
    }
  }
  if (result.employer && result.currentTitle) {
    score += 10;
    reasons.push("Employer and current title returned");
  } else if (result.employer || result.currentTitle) {
    score += 5;
    reasons.push("Employment evidence returned");
  }

  // Returned phone conflict: a non-Australian number returned alongside the
  // identity match is strong evidence of an overseas namesake. This used to be
  // caught only after the fact, once contact enrichment discovered the phone
  // number for an already-"confirmed" identity — see applyContactResult, which
  // now re-flags an identity if this happens post-confirmation. Checking it
  // here as well stops it reaching a confirmation decision in the first place
  // whenever a provider happens to return phone data alongside identity data.
  const returnedPhone = result.businessPhone || result.mobilePhone;
  if (returnedPhone) {
    const phone = parseAndValidatePhone(returnedPhone);
    if (phone.isInternational) {
      conflicts.push(`Returned phone number (${returnedPhone}) is not an Australian number`);
    }
  }

  score = Math.max(0, Math.min(100, score - (conflicts.length * 10)));
  if (conflicts.some(isHardConflictText)) {
    score = 0;
  }
  const high = Number(thresholds.high ?? 85);
  const manual = Number(thresholds.manual ?? 60);
  const confidence = score >= high && conflicts.length === 0 ? "high" : score >= manual ? "medium" : "low";
  return { score, confidence, reasons, conflicts };
}

// Markers that mean "this is not the same person, not just a weak match" —
// shared between live scoring (scoreIdentityMatch), the post-hoc foreign-phone
// safety net (enrichment.mjs), and the manual namesake-demotion script, so a
// candidate carrying any of them can be recognized consistently wherever the
// system later decides whether to let a "confirmed" decision through.
const HARD_CONFLICT_MARKERS = ["outside australia", "is not an australian number", "overseas_mismatch", "foreign_contact_discovered"];

function isHardConflictText(value) {
  return HARD_CONFLICT_MARKERS.some((marker) => String(value || "").toLowerCase().includes(marker));
}

/**
 * True when a candidate's recorded conflicting_evidence contains a hard
 * identity conflict (overseas location, a non-Australian phone number, or a
 * prior namesake demotion) — the exact evidence pattern behind the 37 confirmed
 * overseas namesakes that had to be found and reversed by hand. Used to gate
 * the recruiter/AI review endpoints: confirming over one of these requires an
 * explicit, documented override rather than a silent status flip.
 */
export function hasHardIdentityConflict(candidate) {
  const raw = candidate?.conflicting_evidence;
  if (!raw) return false;
  let list;
  try { list = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(list)) return false;
  return list.some((item) => {
    if (typeof item === "string") return isHardConflictText(item);
    if (item && typeof item === "object") {
      return isHardConflictText(item.type) || isHardConflictText(item.reason);
    }
    return false;
  });
}

export function campaignEligibility(candidate) {
  const reasons = [];
  if (candidate.registration_status?.toLowerCase() !== "registered") reasons.push("Registration is not active");
  if (candidate.identity_status !== "confirmed") reasons.push("Identity is not confirmed");
  if (candidate.email_status !== "valid") reasons.push("Work email is not verified");
  if (!candidate.contact_basis_approved) reasons.push("Contact basis is not approved");
  if (candidate.suppressed) reasons.push("Candidate is suppressed");
  if (candidate.opted_out) reasons.push("Candidate opted out");
  return { eligible: reasons.length === 0, reasons };
}

export function estimateCredits(count, kind, config = {}) {
  const identity = Number(config.identity ?? 1);
  const email = Number(config.email ?? 3);
  const phone = Number(config.phone ?? 9);
  if (kind === "identity") return count * identity;
  if (kind === "email") return count * email;
  if (kind === "phone") return count * phone;
  return count * (email + phone);
}

export function compactCandidateForAi(candidate, purpose = "identity") {
  const base = { id: candidate.id, name: candidate.full_name };
  if (candidate.ahpra_number) base.ahpra = candidate.ahpra_number;
  if (candidate.profession) base.prof = candidate.profession;

  if (purpose === "identity") {
    if (candidate.suburb || candidate.state || candidate.postcode) {
      base.loc = [candidate.suburb, candidate.state, candidate.postcode].filter(Boolean).join(" ");
    }
    if (candidate.qualifications) base.qual = candidate.qualifications;
    if (candidate.employer) base.emp = candidate.employer;
    if (candidate.current_title) base.title = candidate.current_title;
    if (candidate.linkedin_url) base.linkedin = candidate.linkedin_url;
    if (candidate.identity_status) base.status = candidate.identity_status;
    return base;
  }

  if (purpose === "email") {
    if (candidate.linkedin_url) base.linkedin = candidate.linkedin_url;
    if (candidate.employer) base.emp = candidate.employer;
    if (candidate.company_domain) base.domain = candidate.company_domain;
    if (candidate.work_email) base.email = candidate.work_email;
    if (candidate.email_status) base.email_status = candidate.email_status;
    return base;
  }

  if (candidate.suburb || candidate.state || candidate.postcode) {
    base.loc = [candidate.suburb, candidate.state, candidate.postcode].filter(Boolean).join(" ");
  }
  if (candidate.qualifications) base.qual = candidate.qualifications;
  if (candidate.employer) base.emp = candidate.employer;
  if (candidate.current_title) base.title = candidate.current_title;
  if (candidate.linkedin_url) base.linkedin = candidate.linkedin_url;
  if (candidate.work_email) base.email = candidate.work_email;
  if (candidate.identity_status) base.id_status = candidate.identity_status;
  if (candidate.email_status) base.email_status = candidate.email_status;
  if (candidate.identity_match_score != null) base.score = candidate.identity_match_score;
  return base;
}

const tagLabels = {
  "name:exact": "Exact name match",
  "name:partial": "First and last name match",
  "name:distinctive": "Exact distinctive name",
  "name:differs": "Name differs from source",
  "loc:match": "Location aligns with source",
  "loc:reloc": "Location reflects interstate relocation",
  "prof:match": "Role aligns with licensed profession",
  "edu:match": "Education matches source qualification",
  "role:rn": "Registered Nurse role verified",
  "slug:verified": "Profile URL slug matches candidate identity"
};

export function expandEvidenceTags(tags = []) {
  if (!Array.isArray(tags)) return [];
  return tags.map((tag) => {
    const cleanTag = String(tag).trim();
    if (tagLabels[cleanTag.toLowerCase()]) return tagLabels[cleanTag.toLowerCase()];
    const [prefix, ...rest] = cleanTag.split(":");
    if (!rest.length) return cleanTag;
    const value = rest.join(":").replace(/_/g, " ");
    switch (prefix.toLowerCase()) {
      case "name": return `Name: ${value}`;
      case "role": return `Role: ${value}`;
      case "loc": return `Location: ${value}`;
      case "edu": return `Education: ${value}`;
      case "emp": return `Employer: ${value}`;
      case "conflict": return `Discrepancy: ${value}`;
      default: return `${prefix}: ${value}`;
    }
  });
}

export function formatStructuredReviewNotes({ decision, tags = [], customNote = "" }) {
  const parts = [];
  if (decision === "confirmed") parts.push("Identity confirmed");
  else if (decision === "rejected") parts.push("Identity rejected");
  else if (decision === "pending_confirmation") parts.push("High-confidence identity match found; awaiting recruiter confirmation");

  const expanded = expandEvidenceTags(tags);
  if (expanded.length) parts.push(expanded.join("; "));
  if (customNote) parts.push(customNote);
  return parts.filter(Boolean).join(". ");
}

