import { PATTERNS, buildEmail, patternConfidence } from "./patterns.mjs";
import { probeAddresses } from "./verify.mjs";

/**
 * Finds a likely work email for one person:
 *   employer → domain (employer index) → format (learned per domain) →
 *   address → optional mail-server check.
 *
 * Every result records HOW it was found, and mayEmail is false for any
 * address we built ourselves. Australia's Spam Act 2003 only allows
 * "inferred consent" for addresses the person has conspicuously published,
 * and only for messages about their role; an address worked out from a
 * format was never published by them. Only "published" sources (a future
 * crawler) can set mayEmail. This is a guardrail, not legal advice.
 *
 * Returns { email, domain, pattern, confidence, verification, source, mayEmail, reason, alternatives }.
 */
const CONFIDENCE_ORDER = ["none", "weak", "moderate", "strong", "verified"];
const capConfidence = (value, cap) => (CONFIDENCE_ORDER.indexOf(value) > CONFIDENCE_ORDER.indexOf(cap) ? cap : value);

/**
 * The register sometimes stores a whole name in the surname field with no
 * first name ("Arshdeep Kaur" / "Tanvi Shalini Thomas"); split it into first
 * token + last token. A first name with several parts ("Meera Anu") leaves
 * it unclear which part the address uses. Either case caps confidence at
 * "moderate".
 */
export function emailNameParts(person) {
  const first = String(person.firstName || "").trim();
  const last = String(person.lastName || "").trim();
  if (first && last) return { firstName: first, lastName: last, uncertain: /\s/.test(first) };
  const tokens = (first || last).split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  return { firstName: tokens[0], lastName: tokens.at(-1), uncertain: true };
}

export async function findWorkEmail(rawPerson, { patternsByDomain, employerIndex, verify = false, probe = probeAddresses } = {}) {
  const base = { email: null, domain: null, pattern: null, confidence: "none", verification: "not_checked", source: null, mayEmail: false, alternatives: [] };
  const parts = emailNameParts(rawPerson);
  if (!parts) return { ...base, reason: "name incomplete" };
  const person = { ...rawPerson, firstName: parts.firstName, lastName: parts.lastName };
  if (!person.employer) return { ...base, reason: "employer unknown" };

  const employer = employerIndex.resolve(person.employer);
  if (!employer) return { ...base, reason: `no email domain known for employer "${person.employer}"` };
  const domain = employer.domain;
  const learned = patternsByDomain.get(domain);
  const confidence = patternConfidence(learned);

  // Known format: build it. Unknown format: rank the common formats and, if
  // a mail-server check is possible, let the server pick.
  const order = learned?.best
    ? [learned.best, ...PATTERNS.map((p) => p.id).filter((id) => id !== learned.best)]
    : PATTERNS.map((p) => p.id);
  const candidates = [...new Set(order.map((id) => buildEmail(person, id, domain)).filter(Boolean))];
  if (!candidates.length) return { ...base, domain, reason: "could not build an address from the name" };

  let email = learned?.best ? buildEmail(person, learned.best, domain) : null;
  let verification = "not_checked";
  if (verify) {
    const toCheck = email ? [email] : candidates.slice(0, 4);
    const checked = await probe(domain, toCheck);
    if (checked.status === "no_mx") return { ...base, domain, verification: "no_mx", reason: "domain does not accept email" };
    if (checked.status === "checked") {
      if (checked.catchAll) verification = "catch_all";
      else {
        const accepted = toCheck.find((address) => checked.results[address] === "accepted");
        if (accepted) { email = accepted; verification = "accepted"; }
        else if (email && checked.results[email] === "rejected") { verification = "rejected"; }
        else verification = "unknown";
      }
    } else {
      verification = "unverifiable";
    }
  }
  if (!email) return { ...base, domain, verification, reason: "email format for this domain not learned yet", alternatives: candidates.slice(0, 4) };
  if (verification === "rejected") return { ...base, domain, verification, reason: "mail server rejected the address", alternatives: candidates.slice(1, 4) };

  return {
    email,
    domain,
    pattern: learned?.best || null,
    confidence: verification === "accepted" ? "verified" : parts.uncertain ? capConfidence(confidence, "moderate") : confidence,
    verification,
    source: "derived_from_format",
    mayEmail: false,
    reason: `format ${learned?.best || "?"} learned from ${learned?.total ?? 0} address(es) at ${domain}; employer→domain ${employer.source}`,
    alternatives: candidates.filter((address) => address !== email).slice(0, 3)
  };
}
