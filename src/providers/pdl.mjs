/**
 * People Data Labs Person Enrichment adapter.
 * Docs: https://docs.peopledatalabs.com/docs/input-parameters-person-enrichment-api
 *
 * Sends name + country (+ training institution as `school` when known).
 * Region is NOT sent: the inferred state is where someone trained, and many
 * nurses have moved since, so filtering on it would hide true matches.
 *
 * Never throws for HTTP outcomes; every outcome is a LookupResult.
 */
import { emptyPerson, lookupResult, normaliseUrl } from "./provider-contract.mjs";

export const PDL_ENDPOINT = "https://api.peopledatalabs.com/v5/person/enrich";
export const pdlProvider = Object.freeze({
  id: "pdl",
  label: "People Data Labs",
  supports: ["identity", "email", "phone"],
  // Credits are charged per successful match (200). Whether a 404 is ever
  // charged is not stated in PDL's docs; the ledger records what PDL reports.
  creditsPerMatch: 1
});

export function buildPdlQuery(candidate, keys = {}, options = {}) {
  const first = String(candidate.first_name || "").trim();
  const last = String(candidate.last_name || "").trim();
  if (!first || !last) return { skip: "PDL needs a first and last name; single-name registrations are not looked up" };
  const query = {
    first_name: first,
    last_name: last,
    country: "australia",
    min_likelihood: String(options.minLikelihood ?? 6),
    include_if_matched: "true",
    titlecase: "true"
  };
  const middle = String(candidate.middle_name || "").trim();
  if (middle) query.middle_name = middle;
  // sendSchool=false lets a bake-off measure whether the school helps or hurts.
  if (keys.institution && options.sendSchool !== false) query.school = keys.institution;
  if (options.required) query.required = options.required;
  return { query };
}

const year = (value) => {
  const m = String(value ?? "").match(/\b(19|20)\d\d\b/);
  return m ? Number(m[0]) : null;
};

export function normalisePdlPerson(data) {
  const p = emptyPerson();
  if (!data || typeof data !== "object") return p;
  p.fullName = data.full_name ?? null;
  p.firstName = data.first_name ?? null;
  p.middleName = data.middle_name ?? null;
  p.lastName = data.last_name ?? null;
  p.linkedinUrl = normaliseUrl(data.linkedin_url);
  p.currentTitle = data.job_title ?? null;
  p.employer = data.job_company_name ?? null;
  p.location = data.location_name ?? null;
  p.country = data.location_country ?? null;
  p.region = data.location_region ?? null;
  p.education = (Array.isArray(data.education) ? data.education : []).map((e) => ({
    school: e?.school?.name ?? null,
    endYear: year(e?.end_date),
    degrees: Array.isArray(e?.degrees) ? e.degrees : []
  })).filter((e) => e.school);

  const socials = new Map();
  for (const [network, url] of [["facebook", data.facebook_url], ["twitter", data.twitter_url], ["github", data.github_url]]) {
    const u = normaliseUrl(url);
    if (u) socials.set(u, { network, url: u });
  }
  for (const prof of Array.isArray(data.profiles) ? data.profiles : []) {
    const u = normaliseUrl(prof?.url);
    if (u && prof?.network !== "linkedin") socials.set(u, { network: prof.network ?? "other", url: u });
  }
  p.socials = [...socials.values()];

  // Contact fields: real values on paid bundles, true/false on the free plan.
  const emails = new Map();
  if (typeof data.work_email === "string") emails.set(data.work_email.toLowerCase(), { address: data.work_email, type: "work" });
  for (const e of Array.isArray(data.personal_emails) ? data.personal_emails : []) {
    if (typeof e === "string") emails.set(e.toLowerCase(), { address: e, type: "personal" });
  }
  p.emails = [...emails.values()];
  const phones = new Map();
  if (typeof data.mobile_phone === "string") phones.set(data.mobile_phone, { number: data.mobile_phone, type: "mobile" });
  for (const n of Array.isArray(data.phone_numbers) ? data.phone_numbers : []) {
    if (typeof n === "string" && !phones.has(n)) phones.set(n, { number: n, type: "unknown" });
  }
  p.phones = [...phones.values()];

  const flag = (...values) => {
    if (values.some((v) => (typeof v === "string" && v) || (Array.isArray(v) && v.some((x) => typeof x === "string")) || v === true)) return true;
    if (values.some((v) => v === false)) return false;
    return null;
  };
  p.contactAvailability = {
    email: flag(data.work_email, data.personal_emails, data.emails),
    phone: flag(data.mobile_phone, data.phone_numbers, data.phones)
  };
  return p;
}

const ERROR_BY_STATUS = { 400: "bad_request", 401: "auth", 402: "credits_exhausted", 403: "auth", 429: "rate_limited" };

/**
 * @param {object} query   from buildPdlQuery
 * @param {object} options { apiKey, fetchImpl = fetch, timeoutMs = 20000 }
 */
export async function pdlLookup(query, { apiKey, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const base = { query };
  if (!apiKey) return lookupResult("pdl", { ...base, errorCode: "auth", status: "error" });
  const url = `${PDL_ENDPOINT}?${new URLSearchParams(query)}`;
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { "X-Api-Key": apiKey, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return lookupResult("pdl", { ...base, errorCode: "network", retryable: true, raw: { message: String(error?.message || error) } });
  }
  let body = null;
  try { body = await response.json(); } catch { body = null; }

  if (response.status === 200 && body?.data) {
    return lookupResult("pdl", {
      ...base,
      status: "match",
      likelihood: Number.isFinite(body.likelihood) ? body.likelihood : null,
      creditsUsed: pdlProvider.creditsPerMatch,
      providerReference: body.data.id ?? null,
      person: normalisePdlPerson(body.data),
      raw: { likelihood: body.likelihood ?? null, matched: body.matched ?? null }
    });
  }
  if (response.status === 404) return lookupResult("pdl", { ...base, status: "no_match", raw: body?.error ?? null });
  const errorCode = ERROR_BY_STATUS[response.status] || (response.status >= 500 ? "provider_error" : "provider_error");
  return lookupResult("pdl", {
    ...base,
    errorCode,
    retryable: errorCode === "rate_limited" || response.status >= 500,
    raw: { httpStatus: response.status, error: body?.error ?? null }
  });
}
