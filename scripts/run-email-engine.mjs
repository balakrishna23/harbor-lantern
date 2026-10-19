#!/usr/bin/env node
/**
 * HCRHUB's own work-email engine (src/email-engine/). No third-party provider.
 *
 *   DATABASE_PATH=./data/hcrhub-dev.sqlite node scripts/run-email-engine.mjs --evaluate
 *     Accuracy test: hides each known address in turn, predicts it from the
 *     others, and compares. Writes nothing.
 *   DATABASE_PATH=./data/hcrhub-dev.sqlite node scripts/run-email-engine.mjs [--include-review] [--verify]
 *     Finds work emails for confirmed nurses (and attached review matches with
 *     --include-review), stores them in email_findings, and writes a
 *     CRM-ready CSV plus a list of employers whose email domain is unknown.
 *     --verify asks mail servers about each address (needs outbound port 25;
 *     reports "not checked" where it's blocked).
 *
 * Refuses to write to data/hcrhub.sqlite without --allow-original.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const flag = (name) => process.argv.includes(`--${name}`);
const target = path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite");
if (target === path.resolve("./data/hcrhub.sqlite") && !flag("allow-original") && !flag("evaluate")) {
  console.error(`Refusing to write to the original database (${target}). Set DATABASE_PATH to the dev copy, or pass --allow-original.`);
  process.exit(1);
}

const { db } = await import("../src/db.mjs");
const { learnDomainPatterns, explainEmail, splitEmail } = await import("../src/email-engine/patterns.mjs");
const { buildEmployerIndex, loadManualEmployerDomains, PERSONAL_DOMAINS, normaliseEmployer } = await import("../src/email-engine/employers.mjs");
const { findWorkEmail } = await import("../src/email-engine/engine.mjs");
const { crmCsv } = await import("../src/email-engine/crm-export.mjs");
const { toCsv } = await import("../src/csv.mjs");

const manualFile = path.join(path.dirname(target), "reference", "employer-email-domains.csv");
const manualRows = loadManualEmployerDomains(manualFile);

// Real addresses we already hold are the training examples. Mail-server
// accepted addresses from earlier engine runs count too.
const examples = db.prepare(`
  SELECT c.id, c.first_name firstName, c.last_name lastName, c.employer, cp.contact_value email
    FROM contact_points cp JOIN candidates c ON c.id = cp.candidate_id
   WHERE cp.kind = 'work_email' AND cp.active = 1 AND cp.contact_value LIKE '%@%'
  UNION
  SELECT c.id, c.first_name, c.last_name, c.employer, f.email
    FROM email_findings f JOIN candidates c ON c.id = f.candidate_id
   WHERE f.verification = 'accepted'`).all()
  .filter((e) => !PERSONAL_DOMAINS.has(splitEmail(e.email)?.domain));

// Leave-one-out: each held-out person is predicted from everyone else's addresses.
if (flag("evaluate")) {
  const results = [];
  for (const held of examples) {
    if (!explainEmail(held, held.email).length) { results.push({ held, noise: true }); continue; }
    const others = examples.filter((e) => e !== held);
    const r = await findWorkEmail(held, { patternsByDomain: learnDomainPatterns(others), employerIndex: buildEmployerIndex(others, manualRows) });
    results.push({ held, r });
  }
  const score = { correct: 0, wrong: 0, noPrediction: 0, notTheirAddress: 0 };
  for (const { held, r, noise } of results) {
    if (noise) { score.notTheirAddress += 1; console.log(`  ·  #${held.id} ${held.firstName} ${held.lastName}: ${held.email} doesn't match their name — ignored as an example`); continue; }
    const truth = held.email.toLowerCase();
    if (!r.email) { score.noPrediction += 1; console.log(`  -  #${held.id} ${held.firstName} ${held.lastName} (${held.employer}): no prediction — ${r.reason}`); }
    else if (r.email === truth) { score.correct += 1; console.log(`  ✓  #${held.id} ${r.email} (${r.confidence})`); }
    else { score.wrong += 1; console.log(`  ✗  #${held.id} predicted ${r.email}, actual ${truth}`); }
  }
  const predicted = score.correct + score.wrong;
  console.log(`\nKnown addresses: ${examples.length}`, score);
  console.log(`When it makes a prediction it is right ${predicted ? Math.round(100 * score.correct / predicted) : 0}% of the time (${score.correct}/${predicted}).`);
  process.exit(0);
}

const runId = crypto.randomUUID();
const patternsByDomain = learnDomainPatterns(examples);
const employerIndex = buildEmployerIndex(examples, manualRows);
const people = db.prepare(`
  SELECT id, first_name firstName, last_name lastName, employer FROM candidates
   WHERE COALESCE(employer, '') <> '' AND (identity_status = 'confirmed'
      ${flag("include-review") ? "OR (workflow_stage = 'manual_review' AND COALESCE(linkedin_url, '') <> '')" : ""})
   ORDER BY id`).all();

const upsert = db.prepare(`INSERT INTO email_findings
    (candidate_id, email, domain, pattern, confidence, verification, source, may_email, reason, alternatives_json, run_id, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(candidate_id) DO UPDATE SET email = excluded.email, domain = excluded.domain, pattern = excluded.pattern,
    confidence = excluded.confidence, verification = excluded.verification, source = excluded.source,
    may_email = excluded.may_email, reason = excluded.reason, alternatives_json = excluded.alternatives_json,
    run_id = excluded.run_id, updated_at = CURRENT_TIMESTAMP`);
// Addresses we already hold from a provider are kept as-is, not rebuilt.
const alreadyHeld = new Set(db.prepare("SELECT candidate_id FROM contact_points WHERE kind = 'work_email' AND active = 1").all().map((r) => r.candidate_id));

const tally = {};
const unknownEmployers = new Map();
for (const person of people) {
  if (alreadyHeld.has(person.id)) { tally.already_have_email = (tally.already_have_email || 0) + 1; continue; }
  const r = await findWorkEmail(person, { patternsByDomain, employerIndex, verify: flag("verify") });
  upsert.run(person.id, r.email, r.domain, r.pattern, r.confidence, r.verification, r.source, r.mayEmail ? 1 : 0,
    r.reason || null, JSON.stringify(r.alternatives || []), runId);
  const key = r.email ? `found (${r.confidence})` : r.reason?.startsWith("no email domain known") ? "employer domain unknown" : r.reason;
  tally[key] = (tally[key] || 0) + 1;
  if (r.reason?.startsWith("no email domain known")) {
    const k = normaliseEmployer(person.employer);
    unknownEmployers.set(k, { employer: person.employer, nurses: (unknownEmployers.get(k)?.nurses || 0) + 1, domain: "", source: "" });
  }
}

const outDir = path.resolve("exports/crm");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const { csv, count } = crmCsv(db);
fs.writeFileSync(path.join(outDir, `hcrhub-crm-contacts-${stamp}.csv`), csv, "utf8");
fs.writeFileSync(path.join(outDir, "hcrhub-crm-contacts-latest.csv"), csv, "utf8");
const unknown = [...unknownEmployers.values()].sort((a, b) => b.nurses - a.nurses);
fs.writeFileSync(path.join(outDir, `unknown-employer-domains-${stamp}.csv`), toCsv(unknown, ["employer", "nurses", "domain", "source"]), "utf8");

console.log(`Run ${runId}: ${people.length} nurses with a known employer`, tally);
console.log(`Learned formats for ${patternsByDomain.size} domain(s) from ${examples.length} known address(es); employer→domain entries: ${employerIndex.entries.size}`);
console.log(`CRM sheet: exports/crm/hcrhub-crm-contacts-${stamp}.csv (${count} rows)`);
console.log(`Employers with no known email domain: ${unknown.length} → exports/crm/unknown-employer-domains-${stamp}.csv`);
console.log(`  Fill in their domain and add the rows to ${path.relative(process.cwd(), manualFile)} (columns employer,domain,source) to cover them next run.`);
