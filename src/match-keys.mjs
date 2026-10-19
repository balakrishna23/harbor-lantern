/**
 * Match keys: everything in the licensed register that can tell two nurses
 * apart when the register has no usable location.
 *
 *  - Name uniqueness across the whole register (first+last, and with middle)
 *  - Training institution, graduation year and the state that institution
 *    implies (soft location hint, see institution-state.mjs)
 *  - Country of qualification (flags overseas-trained nurses)
 *
 * Pure functions only; persistence lives in scripts/build-match-keys.mjs.
 */
import { comparable } from "./domain.mjs";
import { parseCandidateQualifications } from "./qualification-parser.mjs";
import { inferInstitutionState } from "./institution-state.mjs";

const HONORIFICS = new Set(["dr", "miss", "mr", "mrs", "ms", "mx", "prof", "sir"]);
const AU_STATES = new Set(["ACT", "NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT"]);

const nameTokens = (value) => comparable(value).split(" ").filter((t) => t && !HONORIFICS.has(t));

/**
 * "first|last" key. Nurses registered under a single name (no first name on
 * the register) get "-|name". Null only when no last name exists at all.
 */
export function nameKey(candidate) {
  const first = nameTokens(candidate.first_name ?? candidate.firstName)[0];
  const last = nameTokens(candidate.last_name ?? candidate.lastName).join(" ");
  if (!last) return null;
  return `${first || "-"}|${last}`;
}

/** "first|middle|last" key; middle may be empty. */
export function fullNameKey(candidate) {
  const base = nameKey(candidate);
  if (!base) return null;
  const middle = nameTokens(candidate.middle_name ?? candidate.middleName).join(" ");
  const [first, last] = base.split("|");
  return `${first}|${middle}|${last}`;
}

/** Counts how many register people share each key. Rows: one per candidate. */
export function buildNameCounts(rows) {
  const byName = new Map();
  const byFullName = new Map();
  for (const row of rows) {
    const k = nameKey(row);
    if (k) byName.set(k, (byName.get(k) || 0) + 1);
    const f = fullNameKey(row);
    if (f) byFullName.set(f, (byFullName.get(f) || 0) + 1);
  }
  return { byName, byFullName };
}

export function uniquenessBand(count) {
  if (!count) return "unknown";
  if (count === 1) return "unique";
  if (count <= 3) return "rare";
  return "common";
}

/**
 * Priority tier for lookups, cheapest-to-confirm first.
 *  1 unique name + known training institution
 *  2 unique name, no usable institution
 *  3 rare name (2-3 people) + institution to separate them
 *  4 common name + institution (needs strong education evidence)
 *  5 rare or common name with no institution: too ambiguous to spend credits on
 */
export function priorityTier(band, hasInstitution) {
  if (band === "unique") return hasInstitution ? 1 : 2;
  if (band === "rare") return hasInstitution ? 3 : 5;
  if (band === "common") return hasInstitution ? 4 : 5;
  return 5;
}

const NOT_AN_INSTITUTION = /^(australia|new zealand|india|philippines|united kingdom|unknown|institute unknown|other( not recognised)?|not specified|n\/a|unspecified|not applicable|education|nursing|general)$/i;

function rawInstitution(q) {
  const value = String(q.raw || "").replace(/^[•\s]+/, "").split(",").map((p) => p.trim())[1] || "";
  return value && !NOT_AN_INSTITUTION.test(value) ? value : null;
}

export function deriveMatchKeys(candidate, counts) {
  const key = nameKey(candidate);
  const fullKey = fullNameKey(candidate);
  const nameCount = key ? counts.byName.get(key) || 0 : 0;
  const fullNameCount = fullKey ? counts.byFullName.get(fullKey) || 0 : 0;

  // Work from the RAW institution text (second comma field), not the
  // parser's canonicalised name, so the state lookup sees what AHPRA holds.
  const quals = parseCandidateQualifications(candidate.qualifications).map((q) => ({ ...q, institution: rawInstitution(q) }));
  const auQuals = quals.filter((q) => q.isAustralian && q.institution);
  // Earliest Australian qualification is the most likely entry-to-practice
  // degree, which is what a profile's education section usually lists.
  const primary = [...auQuals].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))[0] || null;
  const inferred = primary ? inferInstitutionState(primary.institution) : { state: null, known: false };
  const overseas = quals.find((q) => !q.isAustralian && q.country && q.country !== "Unknown") || null;
  const years = quals.map((q) => q.year).filter(Number.isFinite);

  const registerState = AU_STATES.has(String(candidate.state || "").toUpperCase()) ? String(candidate.state).toUpperCase() : null;
  const band = uniquenessBand(nameCount);
  // Middle name can rescue a shared first+last name.
  const effectiveBand = band !== "unique" && fullNameCount === 1 && fullKey && !fullKey.includes("||") ? "unique" : band;

  return {
    candidateId: candidate.id ?? null,
    nameKey: key,
    fullNameKey: fullKey,
    nameCount,
    fullNameCount,
    uniqueness: effectiveBand,
    institution: primary?.institution ?? null,
    institutionKnown: Boolean(inferred.known),
    gradYear: primary?.year ?? null,
    earliestYear: years.length ? Math.min(...years) : null,
    inferredState: inferred.state ?? null,
    registerState,
    qualificationCountry: overseas?.country ?? (auQuals.length ? "Australia" : null),
    overseasTrained: Boolean(overseas),
    tier: priorityTier(effectiveBand, Boolean(primary?.institution))
  };
}
