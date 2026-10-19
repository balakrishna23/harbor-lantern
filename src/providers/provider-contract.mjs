/**
 * The shape every enrichment provider adapter returns, so the verifier and
 * the runner never depend on one vendor's response format.
 *
 * LookupResult = {
 *   provider: string,
 *   status: "match" | "no_match" | "skipped" | "error",
 *   errorCode: null | "credits_exhausted" | "rate_limited" | "auth" | "bad_request" | "provider_error" | "network",
 *   retryable: boolean,
 *   likelihood: number | null,          // provider's own 1-10 confidence, when given
 *   creditsUsed: number,
 *   providerReference: string | null,
 *   person: NormalisedPerson | null,
 *   query: object,                      // what was sent, for audit (never the API key)
 *   raw: object | null
 * }
 *
 * NormalisedPerson = {
 *   fullName, firstName, middleName, lastName,
 *   linkedinUrl, socials: [{ network, url }],
 *   currentTitle, employer, location, country, region,
 *   education: [{ school, endYear, degrees: [] }],
 *   emails: [{ address, type }], phones: [{ number, type }],
 *   contactAvailability: { email: true|false|null, phone: true|false|null }
 * }
 * contactAvailability matters on plans that only say WHETHER a value exists
 * (PDL's free plan returns true/false instead of the address or number).
 */

export function emptyPerson() {
  return {
    fullName: null, firstName: null, middleName: null, lastName: null,
    linkedinUrl: null, socials: [],
    currentTitle: null, employer: null, location: null, country: null, region: null,
    education: [], emails: [], phones: [],
    contactAvailability: { email: null, phone: null }
  };
}

export function lookupResult(provider, fields) {
  return {
    provider,
    status: "error",
    errorCode: null,
    retryable: false,
    likelihood: null,
    creditsUsed: 0,
    providerReference: null,
    person: null,
    query: {},
    raw: null,
    ...fields
  };
}

/** Errors that mean "stop the whole run", not "skip this nurse". */
export const RUN_STOPPING_ERRORS = new Set(["credits_exhausted", "auth"]);

export function normaliseUrl(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
