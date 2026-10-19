/**
 * Provider bake-off: run a provider over a small, fixed sample and measure
 * match rate, accuracy against already-confirmed identities, and contact
 * coverage. Writes only to provider_lookups; never edits candidates.
 */
import crypto from "node:crypto";
import { verifyIdentity } from "./verifier.mjs";
import { RUN_STOPPING_ERRORS } from "./providers/provider-contract.mjs";

const CANDIDATE_COLUMNS = `c.id, c.full_name, c.first_name, c.middle_name, c.last_name, c.alternative_name, c.qualifications,
  c.state, c.linkedin_url, c.identity_status, c.registration_status,
  m.name_count, m.full_name_count, m.uniqueness, m.institution, m.grad_year, m.inferred_state, m.tier`;

/** Stable pseudo-random order so a re-run with the same seed picks the same nurses. */
const seededOrder = (seed) => (a, b) => {
  const h = (id) => crypto.createHash("sha1").update(`${seed}:${id}`).digest("hex");
  return h(a.id) < h(b.id) ? -1 : 1;
};

/**
 * groups: { confirmed: n, tier1: n, tier3: n, tier4: n }
 * Skips nurses this provider has already been asked about, unless force.
 */
export function selectSample(db, { groups = { confirmed: 50, tier1: 50 }, seed = "bakeoff", provider, force = false } = {}) {
  const notDone = force ? "" : `AND NOT EXISTS (SELECT 1 FROM provider_lookups p WHERE p.candidate_id = c.id AND p.provider = '${provider.replace(/[^a-z0-9_]/gi, "")}' AND p.status IN ('match','no_match'))`;
  const picked = [];
  for (const [group, n] of Object.entries(groups)) {
    if (!n) continue;
    let where;
    if (group === "confirmed") where = "c.identity_status = 'confirmed'";
    else if (/^tier[1-5]$/.test(group)) where = `m.tier = ${Number(group.slice(4))} AND c.identity_status <> 'confirmed'`;
    else throw new Error(`Unknown sample group "${group}"`);
    const rows = db.prepare(`SELECT ${CANDIDATE_COLUMNS} FROM candidates c JOIN match_keys m ON m.candidate_id = c.id
      WHERE ${where} AND c.registration_status = 'Registered' ${notDone}`).all();
    rows.sort(seededOrder(seed));
    for (const row of rows.slice(0, n)) picked.push({ ...row, sampleGroup: group });
  }
  return picked;
}

const keysFromRow = (row) => ({
  uniqueness: row.uniqueness, institution: row.institution, gradYear: row.grad_year, inferredState: row.inferred_state,
  nameCount: row.name_count, fullNameCount: row.full_name_count, tier: row.tier
});

export const normaliseLinkedin = (url) => String(url || "").toLowerCase()
  .replace(/^https?:\/\//, "").replace(/^[a-z]{2,3}\.linkedin\.com/, "linkedin.com").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");

/**
 * Runs lookups. options:
 *   dryRun (default true)  build queries only; no provider calls, no writes
 *   maxCredits             hard ceiling; stops before a call could exceed it
 *   delayMs, sleep         pacing between calls
 *   queryOptions           passed to provider.buildQuery (minLikelihood, sendSchool, required)
 *   lookupOptions          passed to provider.lookup (apiKey, fetchImpl)
 */
export async function runLookups(db, { provider, candidates, runId = crypto.randomUUID(), options = {} }) {
  const dryRun = options.dryRun !== false;
  const maxCredits = Number(options.maxCredits ?? 100);
  const delayMs = Number(options.delayMs ?? 400);
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const creditsPerCall = Number(provider.creditsPerMatch ?? 1);

  const insert = dryRun ? null : db.prepare(`INSERT INTO provider_lookups(run_id, candidate_id, sample_group, provider, query_json, status, error_code,
    likelihood, credits_used, provider_reference, decision, score, signals_json, reasons_json, conflicts_json, person_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const outcomes = [];
  let creditsSpent = 0;
  let stoppedBecause = null;

  for (const row of candidates) {
    const keys = keysFromRow(row);
    const built = provider.buildQuery(row, keys, options.queryOptions || {});
    if (built.skip) { outcomes.push({ row, status: "skipped", reason: built.skip }); continue; }
    if (dryRun) { outcomes.push({ row, status: "planned", query: built.query }); continue; }
    if (creditsSpent + creditsPerCall > maxCredits) { stoppedBecause = `credit ceiling (${maxCredits}) reached`; break; }

    let result = await provider.lookup(built.query, options.lookupOptions || {});
    if (result.errorCode === "rate_limited") {
      await sleep(Number(options.rateLimitWaitMs ?? 60000));
      result = await provider.lookup(built.query, options.lookupOptions || {});
    }
    creditsSpent += Number(result.creditsUsed || 0);
    const verdict = result.status === "match" ? verifyIdentity(row, keys, result) : null;
    insert.run(runId, row.id, row.sampleGroup ?? null, provider.id, JSON.stringify(result.query ?? built.query), result.status, result.errorCode,
      result.likelihood, Number(result.creditsUsed || 0), result.providerReference, verdict?.decision ?? null, verdict?.score ?? null,
      JSON.stringify(verdict?.signals ?? {}), JSON.stringify(verdict?.reasons ?? []), JSON.stringify(verdict?.conflicts ?? []),
      result.person ? JSON.stringify(result.person) : null);
    outcomes.push({ row, status: result.status, errorCode: result.errorCode, result, verdict });

    if (RUN_STOPPING_ERRORS.has(result.errorCode)) { stoppedBecause = `provider error: ${result.errorCode}`; break; }
    if (delayMs) await sleep(delayMs);
  }
  return { runId, dryRun, creditsSpent, stoppedBecause, outcomes, summary: summarise(outcomes) };
}

export function summarise(outcomes) {
  const groups = {};
  for (const o of outcomes) {
    const g = (groups[o.row.sampleGroup ?? "all"] ??= {
      looked_up: 0, planned: 0, skipped: 0, matched: 0, no_match: 0, errors: 0,
      accept: 0, review: 0, reject: 0, email_available: 0, phone_available: 0, any_social: 0,
      truth_checked: 0, truth_same_profile: 0, truth_different_profile: 0
    });
    if (o.status === "planned") { g.planned++; continue; }
    if (o.status === "skipped") { g.skipped++; continue; }
    g.looked_up++;
    if (o.status === "no_match") g.no_match++;
    else if (o.status === "error") g.errors++;
    if (o.status !== "match") continue;
    g.matched++;
    g[o.verdict.decision]++;
    const p = o.result.person;
    if (p.contactAvailability?.email || p.emails?.length) g.email_available++;
    if (p.contactAvailability?.phone || p.phones?.length) g.phone_available++;
    if (p.socials?.length) g.any_social++;
    // Accuracy: for nurses already confirmed with a LinkedIn URL, did the
    // provider return the same profile?
    if (o.row.identity_status === "confirmed" && /linkedin\.com\/in\//i.test(o.row.linkedin_url || "") && p.linkedinUrl) {
      g.truth_checked++;
      if (normaliseLinkedin(o.row.linkedin_url) === normaliseLinkedin(p.linkedinUrl)) g.truth_same_profile++;
      else g.truth_different_profile++;
    }
  }
  return groups;
}

