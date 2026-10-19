/**
 * Email address formats ("patterns") and learning them from real examples.
 *
 * This is how work-email finders do it: collect real addresses at an
 * employer's domain, work out which format they follow (first.last@,
 * flast@ ...), then build the same format for someone else at that employer.
 * Here the examples come from addresses we already hold (contact_points) or
 * that are published; nothing is guessed from general knowledge.
 */

// Strip accents, apostrophes and anything that never appears in an address.
export function normaliseNamePart(value) {
  return String(value ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Spellings of the first and last name an address might use. Multi-part
 * surnames show up joined ("acharyakharel" for "Acharya Kharel"),
 * hyphenated, or as just the final part.
 */
export function nameVariants({ firstName, lastName }) {
  const first = normaliseNamePart(firstName).split(/[\s-]+/).filter(Boolean)[0] || "";
  const lastParts = normaliseNamePart(lastName).split(/[\s-]+/).filter(Boolean);
  const lasts = new Set();
  if (lastParts.length) {
    lasts.add(lastParts.join(""));
    lasts.add(lastParts.join("-"));
    lasts.add(lastParts.at(-1));
  }
  return { first, lasts: [...lasts].filter(Boolean) };
}

// Ordered roughly by how common each format is at Australian employers.
export const PATTERNS = [
  { id: "first.last", build: (f, l) => `${f}.${l}` },
  { id: "flast", build: (f, l) => `${f[0]}${l}` },
  { id: "f.last", build: (f, l) => `${f[0]}.${l}` },
  { id: "firstlast", build: (f, l) => `${f}${l}` },
  { id: "first_last", build: (f, l) => `${f}_${l}` },
  { id: "first-last", build: (f, l) => `${f}-${l}` },
  { id: "first", build: (f) => f },
  { id: "firstl", build: (f, l) => `${f}${l[0]}` },
  { id: "first.l", build: (f, l) => `${f}.${l[0]}` },
  { id: "lastf", build: (f, l) => `${l}${f[0]}` },
  { id: "last.first", build: (f, l) => `${l}.${f}` },
  { id: "last", build: (f, l) => l }
];
const PATTERN_BY_ID = new Map(PATTERNS.map((pattern) => [pattern.id, pattern]));

export function splitEmail(email) {
  const match = String(email ?? "").trim().toLowerCase().match(/^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/);
  return match ? { local: match[1], domain: match[2] } : null;
}

/** Which formats produce this address for this person (empty when it isn't theirs). */
export function explainEmail(person, email) {
  const parts = splitEmail(email);
  if (!parts) return [];
  const { first, lasts } = nameVariants(person);
  if (!first) return [];
  const matches = new Set();
  for (const last of lasts.length ? lasts : [""]) {
    for (const pattern of PATTERNS) {
      if (!last && pattern.build.length > 1 && pattern.id !== "first") continue;
      if (pattern.build(first, last || "x") === parts.local) matches.add(pattern.id);
    }
  }
  // "first" alone also explains first.last-style addresses' prefix — only
  // count it when nothing more specific does.
  if (matches.size > 1) matches.delete("first");
  return [...matches];
}

/** Builds the address in a given format, or null if the name can't fill it. */
export function buildEmail(person, patternId, domain) {
  const pattern = PATTERN_BY_ID.get(patternId);
  const { first, lasts } = nameVariants(person);
  if (!pattern || !first || !lasts.length || !domain) return null;
  return `${pattern.build(first, lasts[0])}@${domain}`;
}

/**
 * Learns each domain's format from (person, email) examples. Examples whose
 * address can't be explained by the person's own name are dropped as noise —
 * a provider sometimes returns someone else's address (seen in our own data:
 * "Aditi Bhattarai" → zquadri@…).
 * Returns Map(domain → { total, counts: {patternId: n}, best, share, noise }).
 */
export function learnDomainPatterns(examples) {
  const domains = new Map();
  for (const example of examples) {
    const parts = splitEmail(example.email);
    if (!parts) continue;
    const entry = domains.get(parts.domain) || { total: 0, counts: {}, noise: 0 };
    const explained = explainEmail(example, example.email);
    if (!explained.length) {
      entry.noise += 1;
    } else {
      entry.total += 1;
      // An ambiguous example (e.g. a one-letter first name) shares its vote.
      for (const id of explained) entry.counts[id] = (entry.counts[id] || 0) + 1 / explained.length;
    }
    domains.set(parts.domain, entry);
  }
  for (const entry of domains.values()) {
    const ranked = Object.entries(entry.counts).sort((a, b) => b[1] - a[1]);
    entry.best = ranked[0]?.[0] || null;
    entry.share = entry.total ? (ranked[0]?.[1] || 0) / entry.total : 0;
  }
  return domains;
}

/**
 * How much to trust a learned format: "strong" = 3+ consistent examples,
 * "moderate" = 2 or a clear majority, "weak" = a single example.
 */
export function patternConfidence(entry) {
  if (!entry?.best) return "none";
  if (entry.total >= 3 && entry.share >= 0.8) return "strong";
  if (entry.total >= 2 && entry.share >= 0.6) return "moderate";
  return "weak";
}
